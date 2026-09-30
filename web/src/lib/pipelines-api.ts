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

export interface PipelineTemplateSummary {
  id: string;
  version: string;
  name: string;
  description?: string;
  /** `ready` templates are runnable; anything else is stored but not runnable. */
  readiness_status: "ready" | "unavailable";
  readiness_detail?: string | null;
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

export interface PipelineTemplate {
  schema_version: string;
  id: string;
  version: string;
  name: string;
  description?: string;
  start_step: string;
  inputs_schema?: Record<string, unknown>;
  steps: PipelineStepTemplate[];
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
  step_executions: number;
  rework_cycles: number;
  inputs?: Record<string, unknown> | null;
  result?: unknown;
  error?: string | null;
  error_code?: string | null;
  attempts: PipelineStepAttempt[];
  input_requests: PipelineInputRequest[];
  events: PipelineRunEvent[];
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
