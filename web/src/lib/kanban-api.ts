/**
 * Typed client for the kanban plugin's HTTP API.
 *
 * ## Why this is a separate module
 *
 * The surface is 40+ endpoints under `/api/kanban`. Adding them as
 * flat `api.*` methods would bury them among the dashboard's own calls and
 * make "is the kanban client done?" unanswerable. This module is the
 * boundary the React board is written against, and it is deliberately
 * separate so that retiring the plugin bundle does not mean deleting the
 * client the new board depends on.
 *
 * ## The board slug is not optional
 *
 * Omitting `?board=<slug>` makes the server resolve it in this order:
 * `HERMES_KANBAN_BOARD` in the environment, then the on-disk pointer at
 * `<hermes_root>/kanban/current`, then the literal `default`. That is the
 * CLI's notion of current, which is not the same as the one the user picked
 * in the UI. The shipped plugin threads the slug through all 30+ calls for
 * exactly this reason, and its comments record two regressions caused by
 * getting it wrong.
 *
 * So `board` is a required field on every call's options rather than a
 * default. There is no way to write a call that forgets it.
 *
 * ## Shapes
 *
 * `KanbanTaskCard` mirrors `dataclasses.asdict(kanban_db.Task)` plus the
 * derived keys `_task_dict` adds. The dataclass has 37 fields and the board
 * adds more; fields are optional here only where the server itself may omit
 * them (`diagnostics` and `warnings` appear only when a task has at least
 * one diagnostic).
 */

import { fetchJSON } from "./api";

// -------------------------------------------------------------------------
// Column status
// -------------------------------------------------------------------------

/**
 * `kanban_db.VALID_STATUSES`, minus `archived`.
 *
 * `archived` is a real status but not a column: `GET /board` only returns
 * it in the columns list when `include_archived=true`, and the board UI
 * treats it as a filter rather than a lane to drag into.
 */
export type KanbanStatus =
  | "triage"
  | "todo"
  | "scheduled"
  | "ready"
  | "running"
  | "blocked"
  | "review"
  | "done";

export const KANBAN_STATUSES: KanbanStatus[] = [
  "triage",
  "todo",
  "scheduled",
  "ready",
  "running",
  "blocked",
  "review",
  "done",
];

/**
 * PATCH rejects `running` outright with a 400 and tells the caller to use
 * the dispatcher/claim path. A task reaches `running` by being dispatched,
 * never by a human dragging it there, so the board must not offer it as a
 * drop target.
 */
export const SELECTABLE_STATUSES: KanbanStatus[] = KANBAN_STATUSES.filter(
  (s) => s !== "running",
);

// -------------------------------------------------------------------------
// Task
// -------------------------------------------------------------------------

export interface KanbanTaskAge {
  created_age_seconds: number | null;
  started_age_seconds: number | null;
  time_to_complete_seconds: number | null;
}

export interface KanbanDiagnosticAction {
  label: string;
  kind: string;
  payload: Record<string, unknown>;
  suggested: boolean;
}

export interface KanbanDiagnostic {
  kind: string;
  severity: "warning" | "error" | "critical";
  title: string;
  detail: string;
  actions: KanbanDiagnosticAction[];
  first_seen_at: number;
  last_seen_at: number;
  count: number;
  run_id: number | null;
  data: Record<string, unknown>;
}

export interface KanbanWarnings {
  count: number;
  kinds: Record<string, number>;
  latest_at: number;
  highest_severity: string | null;
}

export type KanbanWorkspaceKind = "scratch" | "worktree" | "dir";

export type KanbanReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export interface KanbanTaskCard {
  // identity
  id: string;
  title: string;
  body: string | null;
  status: KanbanStatus;

  // ownership
  assignee: string | null;
  created_by: string | null;
  tenant: string | null;
  project_id: string | null;

  // scheduling
  priority: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  claim_lock: string | null;
  claim_expires: number | null;

  // execution
  workspace_kind: KanbanWorkspaceKind;
  workspace_path: string | null;
  skills: string[] | null;
  model_override: string | null;
  provider_override: string | null;
  reasoning_effort: KanbanReasoningEffort | null;
  max_runtime_seconds: number | null;
  max_retries: number | null;
  goal_mode: boolean;
  goal_max_turns: number | null;
  worker_pid: number | null;
  last_heartbeat_at: number | null;
  current_run_id: number | null;
  session_id: string | null;
  branch_name: string | null;

  // workflow
  workflow_template_id: string | null;
  current_step_key: string | null;
  completion_contract: string | null;

  // failure
  consecutive_failures: number;
  last_failure_error: string | null;
  block_kind: string | null;
  block_recurrences: number;

  // output
  result: string | null;
  idempotency_key: string | null;

  // derived by _task_dict
  age: KanbanTaskAge;
  /** Truncated to 200 chars on the board; the full text is on the detail endpoint. */
  latest_summary: string | null;
  current_run_started_at: number | null;
  link_counts: { parents: number; children: number };
  comment_count: number;
  /** null when the task has no children. */
  progress: { done: number; total: number } | null;

  // present only when the task carries at least one diagnostic
  diagnostics?: KanbanDiagnostic[];
  warnings?: KanbanWarnings;
}

/**
 * A task as `POST /tasks` returns it: the dataclass, not the card.
 *
 * Three fields exist only on the enriched card the board endpoint builds —
 * `comment_count`, `link_counts`, `progress` — and are absent here. Verified
 * against the running server: 41 keys on create, 44 on the board, and the
 * difference is exactly those three. Splicing this into a rendered board
 * crashes the card, because the renderer reads `link_counts.children`.
 */
export type KanbanTaskRow = Omit<
  KanbanTaskCard,
  "comment_count" | "link_counts" | "progress"
>;

export interface KanbanColumn {
  name: KanbanStatus;
  tasks: KanbanTaskCard[];
}

export interface KanbanBoardPayload {
  columns: KanbanColumn[];
  tenants: (string | null)[];
  assignees: string[];
  /** Feed this to the events WebSocket as `?since=` to resume without a gap. */
  latest_event_id: number;
  now: number;
}

// -------------------------------------------------------------------------
// Board envelope, boards list, stats
// -------------------------------------------------------------------------

export interface KanbanBoardSummary {
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  default_workdir: string | null;
  project_id: string | null;
  project_name: string | null;
  default_workspace_kind: KanbanWorkspaceKind | null;
  /** Absolute path of the board's SQLite file. Derived per read, never stored. */
  db_path: string;
  created_at: number;
  counts: Partial<Record<KanbanStatus | "archived", number>>;
  total: number;
  archived: boolean;
  is_current: boolean;
}

export interface KanbanBoardsResponse {
  boards: KanbanBoardSummary[];
  current: string | null;
}

export interface KanbanStatsResponse {
  by_status: Record<string, number>;
  by_assignee: Record<string, Record<string, number>>;
  oldest_ready_age_seconds: number | null;
  now: number;
}

export interface KanbanBoardDiagnosticEntry {
  task_id: string;
  task_title: string;
  task_status: KanbanStatus;
  task_assignee: string | null;
  diagnostics: KanbanDiagnostic[];
}

export interface KanbanDiagnosticsResponse {
  diagnostics: KanbanBoardDiagnosticEntry[];
  count: number;
}

// -------------------------------------------------------------------------
// Writes
// -------------------------------------------------------------------------

export interface KanbanCreateTask {
  title: string;
  /**
   * NOT a free status. `kanban_db.create_task` resolves the initial state
   * itself: `blocked` if `initialStatus` says so, else `triage` if `triage`
   * is set, else `todo` when a parent is unfinished, else `ready`. A `status`
   * field sent to the API is dropped by pydantic without complaint, and the
   * task lands in `ready` regardless -- which is why the board creates and
   * then moves rather than pretending otherwise.
   */
  /** Forces `triage`. */
  triage?: boolean;
  /** `blocked` is the only value `kanban_db` accepts here. */
  initialStatus?: "blocked";
  assignee?: string | null;
  body?: string | null;
  priority?: number;
  tenant?: string | null;
  parent_id?: string | null;
  workspace_kind?: KanbanWorkspaceKind;
  workspace_path?: string | null;
  skills?: string[];
  goal_mode?: boolean;
  goal_max_turns?: number;
  model_override?: string | null;
  provider_override?: string | null;
  reasoning_effort?: KanbanReasoningEffort | null;
  workflow_template_id?: string | null;
  current_step_key?: string | null;
}

export interface KanbanUpdateTask {
  title?: string;
  status?: KanbanStatus;
  assignee?: string | null;
  body?: string | null;
  priority?: number;
  /** Written when a task completes; the server requires it to be non-empty. */
  result?: string | null;
  summary?: string | null;
  tenant?: string | null;
  skills?: string[];
  model_override?: string | null;
  provider_override?: string | null;
  reasoning_effort?: KanbanReasoningEffort | null;
  block_kind?: string | null;
  workspace_kind?: KanbanWorkspaceKind;
  workspace_path?: string | null;
  goal_mode?: boolean;
  goal_max_turns?: number;
}

export interface KanbanBulkResult {
  id: string;
  ok: boolean;
  error?: string;
}

export interface KanbanBulkResponse {
  results: KanbanBulkResult[];
}

// -------------------------------------------------------------------------
// Options
// -------------------------------------------------------------------------

export interface KanbanRequestOptions {
  /**
   * Board slug. Required, never defaulted — see the module header for why
   * an implicit "current" is the wrong board as often as not.
   */
  board: string;
  /** Narrow the board to one tenant. */
  tenant?: string | null;
  /** Adds the `archived` column, which `/board` otherwise omits. */
  includeArchived?: boolean;
  /** Management profile override, as on every other dashboard call. */
  profile?: string;
}

const BASE_PATH = "/api/kanban";

/**
 * Builds `?board=...` first, always, then the optional filters.
 *
 * Ordering is not cosmetic: it keeps the URL identical for identical
 * requests, and `coalesced_read` dedupes on the full path, so a caller that
 * varied its parameter order would silently defeat that cache.
 */
function kanbanUrl(path: string, options: KanbanRequestOptions): string {
  const search = new URLSearchParams();
  search.set("board", options.board);
  if (options.tenant) search.set("tenant", options.tenant);
  if (options.includeArchived) search.set("include_archived", "true");
  return `${BASE_PATH}${path}?${search.toString()}`;
}

// -------------------------------------------------------------------------
// Client
// -------------------------------------------------------------------------

export const kanbanApi = {
  /**
   * The whole board in one call. Returns the columns plus the filter
   * vocabularies (`tenants`, `assignees`) and `latest_event_id`.
   */
  getBoard: (options: KanbanRequestOptions) =>
    fetchJSON<KanbanBoardPayload>(kanbanUrl("/board", options)),

  /** Every board, with counts. Unscoped — `/boards` is not board-scoped. */
  listBoards: (profile?: string) => {
    const url = profile ? `${BASE_PATH}/boards?profile=${encodeURIComponent(profile)}` : `${BASE_PATH}/boards`;
    return fetchJSON<KanbanBoardsResponse>(url);
  },

  /** Column counts and the oldest ready task's age. */
  getStats: (options: KanbanRequestOptions) =>
    fetchJSON<KanbanStatsResponse>(kanbanUrl("/stats", options)),

  /**
   * Tasks carrying diagnostics, for the attention strip. Optionally narrowed
   * to one severity.
   */
  getDiagnostics: (
    options: KanbanRequestOptions & { severity?: "warning" | "error" | "critical" },
  ) => {
    const url = kanbanUrl("/diagnostics", options);
    return fetchJSON<KanbanDiagnosticsResponse>(
      options.severity ? `${url}&severity=${options.severity}` : url,
    );
  },

  /**
   * Creates a task and returns it as the server stores it.
   *
   * Not `{id}`, and not a card either: see `KanbanTaskRow` for why the
   * three derived fields are missing. To render it, re-read the board.
   */
  createTask: (task: KanbanCreateTask, options: KanbanRequestOptions) =>
    fetchJSON<{ task: KanbanTaskRow; warning?: string }>(kanbanUrl("/tasks", options), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...task,
        // `initialStatus` is the TS-facing name; the REST field is snake_case.
        ...(task.initialStatus === "blocked" ? { initial_status: "blocked" } : {}),
      }),
    }),

  /**
   * Creates a card in a specific column.
   *
   * `POST /tasks` cannot be asked for an arbitrary status, so this either
   * uses the two the create path does honour or creates-then-moves. The
   * move is not a race: the card is created unassigned, and an unassigned
   * task cannot be dispatched, so there is no window in which a worker
   * picks it up before the status it was filed under is applied.
   */
  createCardInStatus: async (
    status: KanbanStatus,
    title: string,
    options: KanbanRequestOptions,
  ): Promise<{ id: string }> => {
    if (status === "triage") {
      const { task } = await kanbanApi.createTask({ title, triage: true }, options);
      return { id: task.id };
    }
    if (status === "blocked") {
      const { task } = await kanbanApi.createTask(
        { title, initialStatus: "blocked" },
        options,
      );
      return { id: task.id };
    }
    const { task } = await kanbanApi.createTask({ title }, options);
    if (task.status !== status) {
      // `done` refuses a bare status change with 400: "completion blocked:
      // no result or summary evidence". A card created straight into Done
      // has no run behind it, so the evidence is the act of creating it --
      // stating that, rather than inventing a result, is the honest field.
      await kanbanApi.patchTask(
        task.id,
        status === "done" ? { status, result: "created directly in Done" } : { status },
        options,
      );
    }
    return { id: task.id };
  },

  /**
   * Partial update, including status transitions.
   *
   * Rejections come back as errors rather than silent no-ops: 409 for a
   * refused transition (the detail names the blocking parents) and 409 when
   * dependencies are unsatisfied. The board has to surface both, because a
   * card that refuses to move with no reason looks broken.
   */
  patchTask: (
    id: string,
    patch: KanbanUpdateTask,
    options: KanbanRequestOptions,
  ) =>
    fetchJSON<{ ok: boolean }>(
      kanbanUrl(`/tasks/${encodeURIComponent(id)}`, options),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    ),

  deleteTask: (id: string, options: KanbanRequestOptions) =>
    fetchJSON<{ ok: boolean }>(kanbanUrl(`/tasks/${encodeURIComponent(id)}`, options), {
      method: "DELETE",
    }),

  /**
   * Applies one patch to many tasks.
   *
   * NOT atomic: the response is per-id, and a partial failure is normal.
   * Read `results` and mark only the ids that came back `ok: false` — the
   * shipped board shows "N of M failed" rather than treating the call as
   * all-or-nothing.
   */
  bulkPatch: (
    ids: string[],
    patch: KanbanUpdateTask,
    options: KanbanRequestOptions,
  ) =>
    fetchJSON<KanbanBulkResponse>(kanbanUrl("/tasks/bulk", options), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, patch }),
    }),

  addComment: (id: string, body: string, options: KanbanRequestOptions) =>
    fetchJSON<{ ok: boolean }>(
      kanbanUrl(`/tasks/${encodeURIComponent(id)}/comments`, options),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    ),

  /** Release a stuck claim. */
  reclaimTask: (id: string, options: KanbanRequestOptions) =>
    fetchJSON<{ ok: boolean }>(
      kanbanUrl(`/tasks/${encodeURIComponent(id)}/reclaim`, options),
      { method: "POST" },
    ),

  /** Reassign to a profile; the server reclaims the claim first. */
  reassignTask: (id: string, profile: string, options: KanbanRequestOptions) =>
    fetchJSON<{ ok: boolean }>(
      kanbanUrl(`/tasks/${encodeURIComponent(id)}/reassign`, options),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile }),
      },
    ),

  /**
   * LLM-assisted task fleshing out. Triage only; the server refuses
   * elsewhere.
   */
  specifyTask: (id: string, options: KanbanRequestOptions) =>
    fetchJSON<{
      ok: boolean;
      task_id: string;
      reason: string;
      new_title: string | null;
    }>(kanbanUrl(`/tasks/${encodeURIComponent(id)}/specify`, options), {
      method: "POST",
    }),

  /** LLM-assisted fan-out into child tasks. Triage only. */
  decomposeTask: (id: string, options: KanbanRequestOptions) =>
    fetchJSON<{
      ok: boolean;
      task_id: string;
      reason: string;
      fanout: number;
      child_ids: string[];
      new_title: string | null;
    }>(kanbanUrl(`/tasks/${encodeURIComponent(id)}/decompose`, options), {
      method: "POST",
    }),
};

export type KanbanApi = typeof kanbanApi;
