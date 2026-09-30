import * as React from "react";
import { createPortal } from "react-dom";

import type {
  KanbanCreateTask,
  KanbanReasoningEffort,
  KanbanStatus,
  KanbanTaskCard,
  KanbanWorkspaceKind,
} from "@/lib/kanban-api";

/**
 * The create form, covering `CreateTaskBody` rather than just a title.
 *
 * ## Why this exists instead of a bigger composer
 *
 * The inline composer could only ask for a title, and `CreateTaskBody` has
 * twenty-one fields. Everything it was not sending was not missing from the
 * board — it was unreachable: no way to assign a card, set a priority, record
 * skills, declare a dependency, choose a workspace, or bound a goal loop.
 *
 * ## The trap this is built around
 *
 * `CreateTaskBody` is a pydantic model without `extra="forbid"`. A field it
 * does not know is **dropped without an error**, so the client cannot tell the
 * difference between "the server accepted this" and "the server threw this
 * away". That is not hypothetical: `initial_status` was missing from the model
 * for the lifetime of the feature, and every task was filed `ready` no matter
 * what the client asked for, with a 200 the whole time.
 *
 * So the rule here is that a field appears in this form only because
 * `CreateTaskBody` has it, and `createTask` strips anything unset before it
 * travels. `initial_status: null` is the specific failure to avoid: the
 * validator answers `400 initial_status must be one of ['blocked', 'running']`
 * about a field the client believed it had left alone.
 *
 * ## `done` is not offered
 *
 * The server refuses a `done` create with `400 completion blocked: no result
 * or summary evidence`, and there is no `result` field on `CreateTaskBody` — so
 * a card cannot be created finished. It is completed later, through the
 * completion dialog, which asks what it did.
 */

const WORKSPACES: { value: KanbanWorkspaceKind; label: string; hint: string }[] = [
  { value: "scratch", label: "Scratch", hint: "A throwaway directory. Nothing survives it." },
  { value: "worktree", label: "Worktree", hint: "A git worktree, so the board is not disturbed." },
  { value: "dir", label: "Directory", hint: "The project directory itself." },
];

const EFFORTS: KanbanReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

const PRIORITIES = [
  { value: 0, label: "None" },
  { value: 1, label: "P1" },
  { value: 2, label: "P2" },
  { value: 3, label: "P3" },
];

/** The two initial states `kanban_db.create_task` will actually honour. */
const INITIAL_STATUSES: { value: "blocked"; label: string }[] = [
  { value: "blocked", label: "Blocked" },
];

export interface CreateTaskDialogProps {
  /** The board's cards, for the parent picker and for the triage hint. */
  cards: KanbanTaskCard[];
  /** What the server recommends, from board metadata. */
  defaultWorkspaceKind: KanbanWorkspaceKind | null;
  /** The column the card was opened from, if any. */
  initialStatus?: KanbanStatus;
  onCancel: () => void;
  onCreate: (task: KanbanCreateTask) => Promise<void>;
  onServerError: (message: string) => void;
  open: boolean;
}

export function CreateTaskDialog({
  cards,
  defaultWorkspaceKind,
  initialStatus,
  onCancel,
  onCreate,
  onServerError,
  open,
}: CreateTaskDialogProps) {
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [assignee, setAssignee] = React.useState("");
  const [priority, setPriority] = React.useState(0);
  const [skills, setSkills] = React.useState("");
  const [parents, setParents] = React.useState<string[]>([]);
  const [triage, setTriage] = React.useState(false);
  const [initialStatusValue, setInitialStatusValue] =
    React.useState<"blocked" | "">("");
  const [workspaceKind, setWorkspaceKind] = React.useState<KanbanWorkspaceKind | null>(
    null,
  );
  const [workspacePath, setWorkspacePath] = React.useState("");
  const [goalMode, setGoalMode] = React.useState(false);
  const [goalMaxTurns, setGoalMaxTurns] = React.useState("");
  const [model, setModel] = React.useState("");
  const [provider, setProvider] = React.useState("");
  const [effort, setEffort] = React.useState<KanbanReasoningEffort | "">("");
  const [maxRuntime, setMaxRuntime] = React.useState("");
  const [advanced, setAdvanced] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const titleRef = React.useRef<HTMLInputElement>(null);

  // Opening from a column pre-fills what that column means. Triage and Blocked
  // are the two the create path can honour; anything else the board resolves
  // from the parents, so pretending to file it there would be a lie.
  React.useEffect(() => {
    if (!open) return;
    setTriage(initialStatus === "triage");
    setInitialStatusValue(initialStatus === "blocked" ? "blocked" : "");
    titleRef.current?.focus();
  }, [initialStatus, open]);

  if (!open) return null;

  const trimmedTitle = title.trim();
  const parentCards = cards.filter((c) => parents.includes(c.id));
  // `kanban_db.create_task` files a card `todo` while a parent is unfinished
  // and `ready` otherwise — so choosing a parent changes where the card lands,
  // which is worth saying before the user finds out on the board.
  const unfinishedParents = parentCards.filter((c) => c.status !== "done");
  const effectiveWorkspace = workspaceKind ?? defaultWorkspaceKind ?? "scratch";

  const submit = async () => {
    if (!trimmedTitle || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        title: trimmedTitle,
        body: body.trim() || null,
        assignee: assignee.trim() || null,
        priority,
        skills: skills
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        parents,
        triage,
        initialStatus: initialStatusValue === "blocked" ? "blocked" : undefined,
        workspace_kind: effectiveWorkspace,
        workspace_path: workspacePath.trim() || null,
        goal_mode: goalMode,
        goal_max_turns: goalMaxTurns ? Number(goalMaxTurns) : undefined,
        model_override: model.trim() || null,
        provider_override: provider.trim() || null,
        reasoning_effort: effort === "" ? null : effort,
        max_runtime_seconds: maxRuntime ? Number(maxRuntime) : undefined,
      });
    } catch (problem) {
      // The dialog stays open and keeps everything typed. The server's own
      // sentence is the useful part — it is the one that names which field it
      // refused.
      setError(problem instanceof Error ? problem.message : String(problem));
      onServerError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      aria-modal
      className="modal fade show d-block kb-create"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onCancel();
      }}
      role="dialog"
    >
      <div
        className="modal-backdrop fade show"
        onClick={() => {
          if (!busy) onCancel();
        }}
      />
      <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
        <div className="modal-content">
          <div className="modal-header">
            <h2 className="modal-title h5 mb-0">New task</h2>
            <button
              aria-label="Close"
              className="btn-close"
              disabled={busy}
              onClick={onCancel}
              type="button"
            />
          </div>

          <div className="modal-body">
            {error ? (
              <div className="alert alert-danger py-2 px-3 small" role="alert">
                {error}
              </div>
            ) : null}

            <div className="mb-3">
              <label className="form-label small fw-semibold" htmlFor="kb-create-title">
                Title
              </label>
              <input
                autoFocus
                className="form-control"
                id="kb-create-title"
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
                }}
                placeholder="What needs doing"
                ref={titleRef}
                value={title}
              />
            </div>

            <div className="mb-3">
              <label className="form-label small fw-semibold" htmlFor="kb-create-body">
                Description
              </label>
              <textarea
                className="form-control font-monospace"
                id="kb-create-body"
                onChange={(e) => setBody(e.target.value)}
                placeholder="Markdown. What does done look like?"
                rows={4}
                value={body}
              />
            </div>

            <div className="row g-2 mb-3">
              <div className="col-6 col-md-4">
                <label className="form-label small fw-semibold" htmlFor="kb-create-assignee">
                  Assignee
                </label>
                <input
                  className="form-control"
                  id="kb-create-assignee"
                  onChange={(e) => setAssignee(e.target.value)}
                  placeholder="Unassigned"
                  value={assignee}
                />
              </div>
              <div className="col-6 col-md-4">
                <label className="form-label small fw-semibold" htmlFor="kb-create-priority">
                  Priority
                </label>
                <select
                  className="form-select"
                  id="kb-create-priority"
                  onChange={(e) => setPriority(Number(e.target.value))}
                  value={priority}
                >
                  {PRIORITIES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-12 col-md-4">
                <label className="form-label small fw-semibold" htmlFor="kb-create-skills">
                  Skills
                </label>
                <input
                  className="form-control"
                  id="kb-create-skills"
                  onChange={(e) => setSkills(e.target.value)}
                  placeholder="Comma separated"
                  value={skills}
                />
              </div>
            </div>

            <div className="mb-3">
              <label className="form-label small fw-semibold" htmlFor="kb-create-parents">
                Blocked by
              </label>
              <select
                className="form-select"
                id="kb-create-parents"
                multiple
                onChange={(e) =>
                  setParents([...e.target.selectedOptions].map((o) => o.value))
                }
                size={Math.min(4, Math.max(2, cards.length))}
                value={parents}
              >
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title} — {c.status}
                  </option>
                ))}
              </select>
              {/*
               * The create path resolves the initial status from the parents
               * rather than from a column, so this is the one choice in the
               * form that changes where the card lands. Saying so here beats
               * finding a card in To Do that you expected in Ready.
               */}
              {unfinishedParents.length ? (
                <div className="form-text">
                  {unfinishedParents.length === 1
                    ? `"${unfinishedParents[0].title}" is not done, so this will be filed To Do.`
                    : `${unfinishedParents.length} parents are not done, so this will be filed To Do.`}
                </div>
              ) : null}
            </div>

            <div className="row g-2 mb-3">
              <div className="col-6 col-md-4">
                <label className="form-label small fw-semibold" htmlFor="kb-create-workspace">
                  Workspace
                </label>
                <select
                  className="form-select"
                  id="kb-create-workspace"
                  onChange={(e) => setWorkspaceKind(e.target.value as KanbanWorkspaceKind)}
                  value={effectiveWorkspace}
                >
                  {WORKSPACES.map((w) => (
                    <option key={w.value} value={w.value}>
                      {w.label}
                    </option>
                  ))}
                </select>
                <div className="form-text">
                  {WORKSPACES.find((w) => w.value === effectiveWorkspace)?.hint}
                  {defaultWorkspaceKind && !workspaceKind ? " (board default)" : ""}
                </div>
              </div>
              <div className="col-6 col-md-4">
                <label className="form-label small fw-semibold" htmlFor="kb-create-path">
                  Workspace path
                </label>
                <input
                  className="form-control font-monospace"
                  id="kb-create-path"
                  onChange={(e) => setWorkspacePath(e.target.value)}
                  placeholder="Inherits the board's"
                  value={workspacePath}
                />
              </div>
              <div className="col-12 col-md-4">
                <label className="form-label small fw-semibold" htmlFor="kb-create-initial">
                  File as
                </label>
                <select
                  className="form-select"
                  id="kb-create-initial"
                  onChange={(e) =>
                    setInitialStatusValue(e.target.value === "blocked" ? "blocked" : "")
                  }
                  value={initialStatusValue}
                >
                  <option value="">To Do (or Ready)</option>
                  {INITIAL_STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-check form-switch mb-3">
              <input
                checked={triage}
                className="form-check-input"
                id="kb-create-triage"
                onChange={(e) => {
                  setTriage(e.target.checked);
                  if (e.target.checked) setInitialStatusValue("");
                }}
                type="checkbox"
              />
              <label className="form-check-label small" htmlFor="kb-create-triage">
                File for triage — a human decides the shape before any work starts
              </label>
            </div>

            <div className="form-check form-switch mb-2">
              <input
                checked={goalMode}
                className="form-check-input"
                id="kb-create-goal"
                onChange={(e) => setGoalMode(e.target.checked)}
                type="checkbox"
              />
              <label className="form-check-label small" htmlFor="kb-create-goal">
                Goal mode — keep going across turns instead of stopping at the first answer
              </label>
            </div>
            {goalMode ? (
              <div className="mb-3 ms-4" style={{ maxWidth: 220 }}>
                <label className="form-label small fw-semibold" htmlFor="kb-create-turns">
                  Max turns
                </label>
                <input
                  className="form-control"
                  id="kb-create-turns"
                  min={1}
                  onChange={(e) => setGoalMaxTurns(e.target.value)}
                  type="number"
                  value={goalMaxTurns}
                />
              </div>
            ) : null}

            <button
              className="btn btn-sm btn-link px-0"
              onClick={() => setAdvanced((v) => !v)}
              type="button"
            >
              {advanced ? "Hide" : "Show"} model overrides
            </button>

            {advanced ? (
              <div className="row g-2 mt-1">
                <div className="col-6 col-md-3">
                  <label className="form-label small fw-semibold" htmlFor="kb-create-model">
                    Model
                  </label>
                  <input
                    className="form-control"
                    id="kb-create-model"
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="Inherits the profile"
                    value={model}
                  />
                </div>
                <div className="col-6 col-md-3">
                  <label className="form-label small fw-semibold" htmlFor="kb-create-provider">
                    Provider
                  </label>
                  <input
                    className="form-control"
                    id="kb-create-provider"
                    onChange={(e) => setProvider(e.target.value)}
                    placeholder="Inherits"
                    value={provider}
                  />
                </div>
                <div className="col-6 col-md-3">
                  <label className="form-label small fw-semibold" htmlFor="kb-create-effort">
                    Reasoning
                  </label>
                  <select
                    className="form-select"
                    id="kb-create-effort"
                    onChange={(e) =>
                      setEffort(e.target.value === "" ? "" : (e.target.value as KanbanReasoningEffort))
                    }
                    value={effort}
                  >
                    <option value="">Inherits</option>
                    {EFFORTS.map((e) => (
                      <option key={e} value={e}>
                        {e}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-6 col-md-3">
                  <label className="form-label small fw-semibold" htmlFor="kb-create-runtime">
                    Max runtime (s)
                  </label>
                  <input
                    className="form-control"
                    id="kb-create-runtime"
                    min={1}
                    onChange={(e) => setMaxRuntime(e.target.value)}
                    type="number"
                    value={maxRuntime}
                  />
                </div>
              </div>
            ) : null}
          </div>

          <div className="modal-footer">
            <span className="me-auto small text-body-secondary">
              {unfinishedParents.length || triage || initialStatusValue
                ? null
                : "Filed To Do, or Ready when nothing blocks it."}
            </span>
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={!trimmedTitle || busy}
              onClick={() => void submit()}
              type="button"
            >
              {busy ? "Creating…" : "Create task"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
