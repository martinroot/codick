/** Typed client for the pipeline API (`/api/pipelines`, spec §11).
 *
 * ## Credentials
 *
 * Every run-scoped route requires a credential, and the credential is server
 * side: the browser must never hold one. So this client is for the *local*
 * surface, where the dashboard's own session is the credential and the
 * `Idempotency-Key` is generated per call. An external site uses a bearer
 * credential it holds itself and calls the same URLs — that is the point of the
 * ownership checks, not a second API.
 *
 * ## Why `Idempotency-Key` is generated here and not by the caller
 *
 * Run creation and response submission are the two operations where a retry has
 * to be safe, and a caller that has to remember to pass a key is a caller that
 * will forget. `crypto.randomUUID()` is available in every browser this ships
 * to, and generating it per call is what makes a double-click or a flaky
 * connection harmless.
 */

import { authedFetch } from "./api";

// -------------------------------------------------------------------------
// Shapes
// -------------------------------------------------------------------------

/** Run status, as `pipeline_runs.status`. */
export type PipelineRunStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "blocked"
  | "failed"
  | "completed"
  | "cancelled";

export type PipelineAttemptStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "unknown";

export type InputRequestStatus =
  | "open"
  | "answered"
  | "invalidated"
  | "expired"
  | "cancelled";

/** What the template select needs, read off the stored row. */
export interface PipelineTemplateSummary {
  id: string;
  version: string;
  name: string | null;
  readiness_status: "ready" | "unavailable";
  readiness_detail?: string[] | null;
}

/**
 * The template's own JSON — the spec's document, verbatim.
 *
 * It is **nested under `template`**, because that is what the server sends:
 * `ScenarioTemplate.to_dict()` renders the row (`id`, `version`, `name`,
 * `readiness_status`, …) around a `template` field holding the document. The
 * client does not flatten it, because a client that flattens one level it
 * invented is a client that silently reads `undefined` from a server that never
 * promised to flatten.
 */
export interface PipelineTemplateBody {
  schema_version?: string;
  id?: string;
  name?: string;
  start_step?: string;
  inputs_schema?: Record<string, unknown>;
  steps: PipelineStepTemplate[];
  example_response?: unknown;
}

export interface PipelineStepTemplate {
  id: string;
  type: "agent" | "tool" | "user_input" | "condition";
  next?: string | null;
  /** A review is a `user_input` step; the strip needs to tell it from a question. */
  prompt?: string;
  response_schema?: Record<string, unknown>;
  wait_timeout_seconds?: number | null;
}

/** The stored row, as `ScenarioTemplate.to_dict()` renders it. */
export interface PipelineTemplate {
  id: string;
  version: string;
  name: string | null;
  description: string | null;
  template: PipelineTemplateBody;
  created_at: number;
  updated_at: number;
  /** `ready` templates are runnable; `unavailable` ones are stored but not runnable (#30). */
  readiness_status: "ready" | "unavailable";
  readiness_detail?: string[] | null;
}

export interface PipelineStepAttempt {
  id: string;
  step_id: string;
  attempt_no: number;
  status: PipelineAttemptStatus;
  error?: string | null;
  error_code?: string | null;
  output?: Record<string, unknown> | null;
  execution_id?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
  lease_owner?: string | null;
  lease_expires?: number | null;
}

export interface PipelineInputRequest {
  id: string;
  step_id: string;
  attempt_id?: string | null;
  status: InputRequestStatus;
  prompt: string;
  response_schema?: Record<string, unknown> | null;
  chat?: unknown;
  wait_timeout_seconds?: number | null;
  deadline?: number | null;
  accepted_response?: Record<string, unknown> | null;
  responded_at?: number | null;
  created_at?: number;
}

export interface PipelineRunEvent {
  seq: number;
  event_id: string;
  type: string;
  step_id?: string | null;
  attempt_id?: string | null;
  request_id?: string | null;
  payload?: Record<string, unknown> | null;
  occurred_at: number;
}

export interface PipelineRun {
  id: string;
  template_id: string;
  template_version: string;
  /** The board card this run is anchored to. Set together with the run. */
  card_id: string | null;
  status: PipelineRunStatus;
  current_step_id: string | null;
  next_attempt_at?: number | null;
  deadline?: number | null;
  /** The document the run was started from, so a later edit cannot rewrite history. */
  template_snapshot?: PipelineTemplateBody | null;
  template_hash?: string | null;
  /** The executor's step-activation count — not a list of attempts. */
  step_executions: number;
  rework_cycles: number;
  inputs?: Record<string, unknown> | null;
  result?: unknown;
  error?: string | null;
  error_code?: string | null;
  created_at?: number;
  started_at?: number | null;
  ended_at?: number | null;
  updated_at?: number | null;
  attempts: PipelineStepAttempt[];
  input_requests: PipelineInputRequest[];
  events: PipelineRunEvent[];
  /** Metadata only — no filesystem path; fetch the bytes from the download route. */
  artifacts?: PipelineArtifact[];
}

/** A delivered file: what the run produced, and how to ask for it. */
export interface PipelineArtifact {
  id: string;
  run_id: string;
  filename: string;
  mime_type: string | null;
  size: number;
  checksum: string | null;
  created_at: number;
}

/**
 * The URL to download an artifact from.
 *
 * A plain link, not a fetch: the route answers with the bytes and the
 * `Content-Disposition` the browser turns into a save, and a JS fetch would put
 * the file in memory to re-save it by hand. The session rides in the URL
 * because a browser cannot set `Authorization` on a navigation.
 */
export function artifactDownloadUrl(artifactId: string, token?: string | null): string {
  // The id is encoded, so a real id never introduces a path segment — which is
  // what the server's shape test on this path relies on.
  const path = withManagementProfile(
    `/api/pipelines/artifacts/${encodeURIComponent(artifactId)}/download`
  );
  const session = token ?? window.__HERMES_SESSION_TOKEN__ ?? null;
  return session ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(session)}` : path;
}

/**
 * The data a run has collected, in the shape the tab shows it.
 *
 * There is no `collected_data` field on the wire, and inventing one in the client
 * would produce a tab that renders `null` forever. What the run actually holds is
 * each attempt's `output` plus the run's `inputs` and `result`, so that is what
 * this assembles — keyed by step, because a value with no step beside it cannot
 * be traced back to the step that produced it.
 */
export function collectedData(run: PipelineRun): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const attempt of run.attempts ?? []) {
    if (attempt.output === null || attempt.output === undefined) continue;
    out[attempt.step_id] = attempt.output;
  }
  return out;
}

// -------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------

/** One field-level finding from a 422, carrying the JSON path the spec asks for. */
export interface SchemaError {
  path: string;
  message: string;
}

export class PipelineApiError extends Error {
  readonly status: number;
  readonly schemaErrors: SchemaError[];
  readonly requestId: string | null;

  constructor(status: number, message: string, detail: unknown) {
    super(message);
    this.name = "PipelineApiError";
    this.status = status;
    const body = detail as Record<string, unknown> | null;
    const errors = Array.isArray(body?.errors) ? (body?.errors as SchemaError[]) : [];
    this.schemaErrors = errors;
    this.requestId =
      typeof body?.request_id === "string" ? (body.request_id as string) : null;
  }
}

function idempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Older browsers still need a key; uniqueness is the whole requirement.
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authedFetch(`/api/pipelines${path}`, init);
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A non-JSON error body is still an error; the status is the message.
    }
    const detail = (body as { detail?: unknown } | null)?.detail;
    const message =
      (detail && typeof detail === "object" && "message" in detail
        ? String((detail as { message: unknown }).message)
        : `pipeline request failed (${response.status})`);
    throw new PipelineApiError(response.status, message, detail);
  }
  return (await response.json()) as T;
}

// -------------------------------------------------------------------------
// Calls
// -------------------------------------------------------------------------

import { withManagementProfile } from "@/lib/api";

export const pipelinesApi = {
  listTemplates(): Promise<{ templates: PipelineTemplateSummary[] }> {
    return request("/templates");
  },

  getTemplate(id: string, version?: string): Promise<PipelineTemplate> {
    const query = version ? `?version=${encodeURIComponent(version)}` : "";
    return request(`/templates/${encodeURIComponent(id)}${query}`);
  },

  storeTemplate(template: PipelineTemplate): Promise<PipelineTemplate> {
    return request("/templates", {
      method: "POST",
      body: JSON.stringify({ template }),
    });
  },

  /** Validate without storing — what Load JSON calls before offering to keep it. */
  validateTemplate(template: unknown): Promise<{ valid: boolean; errors: SchemaError[] }> {
    return request("/templates/validate", {
      method: "POST",
      body: JSON.stringify({ template }),
    });
  },

  /**
   * Create a run and its card together (spec §9). `inputs` is keyed to the
   * template's `inputs_schema`; the form that collects it is generated from that
   * schema rather than hand-written per template.
   */
  createRun(input: {
    templateId: string;
    version?: string;
    inputs?: Record<string, unknown>;
  }): Promise<PipelineRun> {
    return request("/runs", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify({
        template_id: input.templateId,
        version: input.version,
        inputs: input.inputs ?? {},
      }),
    });
  },

  getRun(runId: string): Promise<PipelineRun> {
    return request(`/runs/${encodeURIComponent(runId)}`);
  },

  /**
   * Stop a run.
   *
   * A stop is not a promise that the work stopped. A model turn already in
   * flight keeps running until the provider returns; what is guaranteed is that
   * its answer can no longer change this run. The server says so in the run's
   * own state, so the button reflects the run rather than the click.
   *
   * Stopping a finished run is a 409, not a silent success — the caller's
   * intent is already satisfied and a fake 200 would have a client retry a stop
   * that can never take effect.
   */
  stopRun(runId: string): Promise<PipelineRun> {
    return request(`/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
  },

  /**
   * Re-arm a run whose step failed.
   *
   * Only `failed` is retryable. A `blocked` run means the outcome of an external
   * call could not be established, and re-running it is the blind repeat of a
   * side effect — so it is offered recovery, not a retry button.
   */
  retryRun(runId: string): Promise<PipelineRun> {
    return request(`/runs/${encodeURIComponent(runId)}/retry`, { method: "POST" });
  },

  /**
   * The run anchored to a board card.
   *
   * Without this the panel cannot re-attach: a run is created together with its
   * card, but nothing could find it again by the card, so a reload left the
   * operator looking at a card with no question to answer. For a service someone
   * pays for and returns to later, that reload is the normal case.
   */
  getRunByCard(cardId: string): Promise<PipelineRun> {
    return request(`/cards/${encodeURIComponent(cardId)}/run`);
  },

  /** Events after `afterSeq`, so a reconnect catches up instead of restarting. */
  listEvents(runId: string, afterSeq = 0): Promise<{ events: PipelineRunEvent[] }> {
    return request(`/runs/${encodeURIComponent(runId)}/events?after_seq=${afterSeq}`);
  },

  /**
   * Answer an open `user_input` request.
   *
   * A 422 leaves the request open and names each offending field's JSON path,
   * so the form can point at the field rather than saying "invalid". A 409 means
   * the request is no longer open — answered, superseded, or expired.
   */
  submitResponse(
    runId: string,
    requestId: string,
    response: Record<string, unknown>
  ): Promise<{ request_id: string; status: string; replayed?: boolean }> {
    return request(
      `/runs/${encodeURIComponent(runId)}/input-requests/${encodeURIComponent(requestId)}/response`,
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey() },
        body: JSON.stringify({ response }),
      }
    );
  },
};
