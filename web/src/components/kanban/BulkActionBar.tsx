import { COLUMN_TITLES } from "@/components/kanban/KanbanBoard";
import type { KanbanStatus } from "@/lib/kanban-api";

/**
 * The bulk action bar.
 *
 * It appears only when something is selected, and it reports **per card**
 * rather than as one verdict. `POST /tasks/bulk` is not atomic: it walks the
 * ids, applies each, and returns `{id, ok, error?}` for every one of them. A
 * single toast saying "12 cards updated" over a call where two were refused
 * because their parents are unfinished is the exact failure this bar has to
 * avoid — the user would believe the board is in the state they asked for.
 */
export interface BulkFailure {
  id: string;
  error: string;
}

export interface BulkOutcome {
  requested: number;
  succeeded: number;
  failures: BulkFailure[];
}

export interface BulkActionBarProps {
  count: number;
  /** Per-card results from the last bulk call, or null before one has run. */
  outcome: BulkOutcome | null;
  busy: boolean;
  onRun: (action: BulkAction) => void;
  onClear: () => void;
  onDismissFailures: () => void;
}

export type BulkAction =
  | { kind: "status"; status: KanbanStatus }
  | { kind: "priority"; priority: number }
  | { kind: "archive" }
  | { kind: "delete" };

const MOVES: { status: KanbanStatus; label: string }[] = [
  { status: "todo", label: "→ To Do" },
  { status: "ready", label: "→ Ready" },
  { status: "review", label: "→ Review" },
  { status: "blocked", label: "Block" },
  { status: "done", label: "Complete" },
];

export function BulkActionBar({
  count,
  outcome,
  busy,
  onRun,
  onClear,
  onDismissFailures,
}: BulkActionBarProps) {
  if (count === 0) return null;
  return (
    <div className="kb-bulk" role="toolbar" aria-label="Bulk actions">
      <span className="kb-bulk-count">
        {count} selected
      </span>

      <div className="kb-bulk-group">
        {MOVES.map((move) => (
          <button
            className="btn btn-sm btn-outline-secondary"
            disabled={busy}
            key={move.status}
            onClick={() => onRun({ kind: "status", status: move.status })}
            title={`Move every selected card to ${COLUMN_TITLES[move.status]}`}
            type="button"
          >
            {move.label}
          </button>
        ))}
      </div>

      <div className="kb-bulk-group">
        {[1, 2, 3].map((priority) => (
          <button
            className="btn btn-sm btn-outline-secondary"
            disabled={busy}
            key={priority}
            onClick={() => onRun({ kind: "priority", priority })}
            type="button"
          >
            P{priority}
          </button>
        ))}
        <button
          className="btn btn-sm btn-outline-secondary"
          disabled={busy}
          onClick={() => onRun({ kind: "archive" })}
          type="button"
        >
          Archive
        </button>
      </div>

      {/*
       * Delete sits last, in danger styling, and goes through a confirm that
       * names the count. `kanban_db.delete_task` is a hard DELETE with no
       * guard of any kind: it takes a running card, a card with children, and
       * every comment, event and attachment row with it, and there is no undo.
       * That is why it is the last control in the bar and why the confirm
       * exists — the affordance sits one misclick from the only irreversible
       * action on the board.
       */}

      <button
        className="btn btn-sm btn-outline-danger"
        disabled={busy}
        onClick={() => onRun({ kind: "delete" })}
        type="button"
      >
        Delete
      </button>

      <button
        className="btn btn-sm btn-outline-secondary ms-auto"
        disabled={busy}
        onClick={onClear}
        type="button"
      >
        Clear
      </button>

      {busy ? <span className="kb-bulk-muted">Working…</span> : null}

      {outcome && outcome.failures.length ? (
        <div className="kb-bulk-failures" role="alert">
          <span>
            {outcome.succeeded} of {outcome.requested} done —{" "}
            {outcome.failures.length} refused:
          </span>
          <ul>
            {outcome.failures.slice(0, 4).map((f) => (
              <li key={f.id}>
                <code>{f.id.replace(/^t_/, "")}</code> {f.error}
              </li>
            ))}
            {outcome.failures.length > 4 ? (
              <li>…and {outcome.failures.length - 4} more</li>
            ) : null}
          </ul>
          <button
            className="btn btn-sm btn-link"
            onClick={onDismissFailures}
            type="button"
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
