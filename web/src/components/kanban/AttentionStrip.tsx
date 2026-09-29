import * as React from "react";

import { DiagnosticCard } from "@/components/kanban/DiagnosticCard";
import {
  kanbanApi,
  type KanbanDiagnostic,
  type KanbanProfile,
  type KanbanRequestOptions,
} from "@/lib/kanban-api";

/** The three levels `kanban_diagnostics` emits, plus "no filter". */
type Severity = "warning" | "error" | "critical";

/**
 * Board-level attention strip.
 *
 * ## Why it collapses
 *
 * A board with nine stuck tasks must not be a wall of cards above the columns
 * — the strip would cover the thing it is reporting on. It shows the worst
 * few, keeps the count honest, and expands on demand. An operator scanning
 * the board sees "3 need attention", not a second board.
 *
 * ## Polling, not the event stream
 *
 * The WebSocket carries task and run events. A diagnostic is a *derived*
 * judgement over task + event + run state with time-based thresholds, so it
 * appears and expires on a clock rather than on an event — a task can go stale
 * with nothing happening at all. Polling is therefore the honest transport
 * here, and the interval is deliberately unhurried: this is an operator tool,
 * not a ticker.
 */
export interface AttentionStripProps {
  options: KanbanRequestOptions;
  /** Re-read the board after an action, so the columns follow along. */
  onBoardChanged: () => void | Promise<void>;
  /** Open a task in the drawer. */
  onOpenTask: (taskId: string) => void;
  /** Jump straight to the comment composer for a task. */
  onFocusComment: (taskId: string) => void;
  /** A 409 or a dead endpoint must not look like "nothing is wrong". */
  onError: (message: string) => void;
}

const REFRESH_MS = 60_000;
const COLLAPSED = 3;

export function AttentionStrip({
  options,
  onBoardChanged,
  onOpenTask,
  onFocusComment,
  onError,
}: AttentionStripProps) {
  const [diagnostics, setDiagnostics] = React.useState<KanbanDiagnostic[] | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [severity, setSeverity] = React.useState<Severity | "all">("all");
  const [profiles, setProfiles] = React.useState<KanbanProfile[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const payload = await kanbanApi.getDiagnostics({
        ...options,
        ...(severity === "all" ? {} : { severity }),
      });
      // The endpoint is nested: one entry per task, each holding that task's
      // diagnostics. The strip renders one card per diagnostic, so it flattens
      // here — and stamps the owning task onto each, because an action needs
      // a task id and the inner object does not carry one.
      const flat = (payload.diagnostics ?? []).flatMap((entry) =>
        (entry.diagnostics ?? []).map((d) => ({
          ...d,
          task_id: entry.task_id,
          task_title: entry.task_title,
          task_status: entry.task_status,
          task_assignee: entry.task_assignee,
        })),
      );
      setDiagnostics(flat);
      setLoadError(null);
    } catch (error) {
      // Say so. Swallowing this would make a broken diagnostics endpoint
      // indistinguishable from a healthy board, which is the worst possible
      // failure for the one panel whose job is to report trouble.
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [options, severity]);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Only fetched once something is actually wrong — the roster is for the
  // reassign picker, and a healthy board should not pay for it.
  React.useEffect(() => {
    if (!diagnostics?.length || profiles.length) return;
    let live = true;
    kanbanApi
      .listProfiles(options)
      .then((list) => {
        if (live) setProfiles(list);
      })
      .catch(() => {
        if (live) setProfiles([]);
      });
    return () => {
      live = false;
    };
  }, [diagnostics, options, profiles.length]);

  if (loadError) {
    return (
      <div className="kb-strip kb-strip-error" role="alert">
        <strong>Attention</strong> could not be read: {loadError}
        <button className="btn btn-sm btn-link" onClick={() => void refresh()} type="button">
          Retry
        </button>
      </div>
    );
  }

  // null = still loading. Rendered as nothing rather than as "all clear",
  // because "we have not looked yet" and "there is nothing wrong" are
  // different facts and an operator must not see the second one first.
  if (diagnostics === null) return null;
  if (diagnostics.length === 0) return null;

  const shown = expanded ? diagnostics : diagnostics.slice(0, COLLAPSED);
  const hidden = diagnostics.length - shown.length;

  return (
    <section className="kb-strip" aria-label="Tasks needing attention">
      <header className="kb-strip-head">
        <strong className="kb-strip-count">
          {diagnostics.length} need{diagnostics.length === 1 ? "s" : ""} attention
        </strong>
        <span className="kb-strip-filters">
          {(["all", "critical", "error", "warning"] as const).map((s) => (
            <button
              className={`btn btn-sm ${severity === s ? "btn-secondary" : "btn-link"}`}
              key={s}
              onClick={() => setSeverity(s)}
              type="button"
            >
              {s}
            </button>
          ))}
        </span>
        <span className="ms-auto kb-strip-tools">
          {hidden > 0 || expanded ? (
            <button
              className="btn btn-sm btn-link"
              onClick={() => setExpanded((v) => !v)}
              type="button"
            >
              {expanded ? "Show less" : `Show ${hidden} more`}
            </button>
          ) : null}
          <button className="btn btn-sm btn-link" onClick={() => void refresh()} type="button">
            Refresh
          </button>
        </span>
      </header>

      <div className="kb-strip-body">
        {shown.map((d, i) => (
          <DiagnosticCard
            diagnostic={d}
            key={`${d.task_id ?? d.kind}-${d.kind}-${i}`}
            onChanged={async () => {
              await refresh();
              await onBoardChanged();
            }}
            onError={onError}
            onFocusComment={onFocusComment}
            onOpenTask={onOpenTask}
            options={options}
            profiles={profiles}
          />
        ))}
      </div>
    </section>
  );
}
