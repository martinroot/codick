import * as React from "react";

import {
  kanbanApi,
  type KanbanDiagnostic,
  type KanbanDiagnosticAction,
  type KanbanRequestOptions,
} from "@/lib/kanban-api";

/**
 * Renders a backend-proposed recovery action.
 *
 * ## The contract
 *
 * The server chooses the *side effect*; this chooses only how to offer it.
 * `kind` is the whole protocol, and every kind is handled here rather than
 * being special-cased per diagnostic rule — a React-shaped copy of this
 * protocol would fork it, and the backend would then be unable to ship a new
 * action without a frontend release.
 *
 * ## Unknown kinds degrade, they do not crash
 *
 * A diagnostic whose action we do not recognise still renders: an inert,
 * clearly-marked row. Dropping the row would hide a task that the backend
 * believes is in trouble; throwing would take the whole board down because a
 * rule grew a new verb. A degraded row is the only honest middle.
 */
export interface DiagnosticActionButtonProps {
  action: KanbanDiagnosticAction;
  taskId: string;
  options: KanbanRequestOptions;
  onChanged: () => void | Promise<void>;
  onError: (message: string) => void;
  /** `comment` jumps to the composer's tab; the strip cannot do that itself. */
  onFocusComment?: () => void;
  /** Profiles for the inline reassign picker, fetched by the caller. */
  profiles?: { name: string }[];
}

export function DiagnosticActionButton({
  action,
  taskId,
  options,
  onChanged,
  onError,
  onFocusComment,
  profiles,
}: DiagnosticActionButtonProps) {
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [picker, setPicker] = React.useState(false);
  const [profile, setProfile] = React.useState("");

  React.useEffect(() => {
    setDone(false);
    setPicker(false);
  }, [taskId, action.kind]);

  const call = React.useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
        await onChanged();
        setDone(true);
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [onChanged, onError],
  );

  const reason = "actioned from the board's attention strip";

  const body = React.useMemo((): React.ReactNode => {
    switch (action.kind) {
      case "reclaim":
        return (
          <button
            className="btn btn-sm btn-outline-danger"
            disabled={busy || done}
            onClick={() =>
              call(() => kanbanApi.reclaimTask(taskId, reason, options))
            }
            type="button"
          >
            {busy ? "Reclaiming…" : done ? "Reclaimed" : "Reclaim"}
          </button>
        );

      case "reassign":
        return picker ? (
          <span className="kb-diag-assign">
            <select
              aria-label="Reassign to profile"
              className="form-select form-select-sm"
              onChange={(e) => setProfile(e.target.value)}
              value={profile}
            >
              <option value="">Choose a profile…</option>
              {(profiles ?? []).map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              className="btn btn-sm btn-outline-secondary"
              disabled={busy || !profile}
              onClick={() =>
                call(() =>
                  kanbanApi.reassignTask(
                    taskId,
                    // `reclaim_first` comes from the backend's payload, not a
                    // guess: a reassign over a live claim has to bounce the
                    // worker, and the server is the one that knows.
                    {
                      profile,
                      reclaimFirst:
                        action.payload?.reclaim_first === true,
                    },
                    options,
                  ),
                )
              }
              type="button"
            >
              {busy ? "…" : "Go"}
            </button>
            <button
              className="btn btn-sm btn-link"
              onClick={() => setPicker(false)}
              type="button"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            className="btn btn-sm btn-outline-secondary"
            disabled={busy || done}
            onClick={() => setPicker(true)}
            type="button"
          >
            {done ? "Reassigned" : "Reassign…"}
          </button>
        );

      case "unblock":
        return (
          <button
            className="btn btn-sm btn-outline-secondary"
            disabled={busy || done}
            onClick={() => call(() => kanbanApi.unblockTask(taskId, options))}
            type="button"
          >
            {busy ? "Unblocking…" : done ? "Unblocked" : "Unblock"}
          </button>
        );

      case "comment":
        return (
          <button
            className="btn btn-sm btn-outline-secondary"
            onClick={() => onFocusComment?.()}
            type="button"
          >
            {onFocusComment ? "Add a comment…" : "Add a comment"}
          </button>
        );

      case "cli_hint": {
        const command =
          typeof action.payload?.command === "string" ? action.payload.command : "";
        if (!command) {
          return <InertAction label={action.label} reason="no command in payload" />;
        }
        return <CopyCommand command={command} label={action.label} />;
      }

      case "open_docs": {
        const url = typeof action.payload?.url === "string" ? action.payload.url : "";
        if (!url) return <InertAction label={action.label} reason="no url in payload" />;
        return (
          <a
            className="btn btn-sm btn-outline-secondary"
            href={url}
            rel="noreferrer"
            target="_blank"
          >
            {action.label}
          </a>
        );
      }

      default:
        return (
          <InertAction
            label={action.label}
            reason={`unhandled action kind “${action.kind}”`}
          />
        );
    }
  }, [action, busy, call, done, onFocusComment, options, picker, profile, profiles, taskId]);

  return (
    <span className="kb-diag-action">
      {action.suggested ? <span className="kb-diag-suggested">suggested</span> : null}
      {body}
    </span>
  );
}

/**
 * A rendered, disabled, explicitly-labelled row. The point is that it is
 * *visible* — an unrecognised action must not look like a missing one.
 */
function InertAction({ label, reason }: { label: string; reason: string }) {
  return (
    <button className="btn btn-sm btn-outline-secondary" disabled title={reason} type="button">
      {label}
    </button>
  );
}

/** Copies a `hermes …` command to the clipboard and says so. */
function CopyCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = React.useState<"no" | "yes" | "failed">("no");

  return (
    <span className="kb-diag-cli">
      <code>{command}</code>
      <button
        className="btn btn-sm btn-outline-secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setCopied("yes");
          } catch {
            // Clipboard access is permission-gated and blocked in some
            // contexts. The command stays selectable either way, so this is
            // a degraded affordance rather than a dead end.
            setCopied("failed");
          }
        }}
        type="button"
      >
        {copied === "yes" ? "Copied" : copied === "failed" ? "Copy failed" : label}
      </button>
    </span>
  );
}

export interface DiagnosticCardProps {
  diagnostic: KanbanDiagnostic;
  options: KanbanRequestOptions;
  onChanged: () => void | Promise<void>;
  onError: (message: string) => void;
  onOpenTask?: (taskId: string) => void;
  onFocusComment?: (taskId: string) => void;
  profiles?: { name: string }[];
}

export function DiagnosticCard({
  diagnostic,
  options,
  onChanged,
  onError,
  onOpenTask,
  onFocusComment,
  profiles,
}: DiagnosticCardProps) {
  const taskId = diagnostic.task_id ?? "";
  // Suggested actions first, and only then the rest — the backend already
  // decided the recommended order; re-sorting by severity would lose that.
  const actions = React.useMemo(() => {
    const rest = diagnostic.actions.filter((a) => !a.suggested);
    return [...diagnostic.actions.filter((a) => a.suggested), ...rest];
  }, [diagnostic.actions]);

  return (
    <article className={`kb-diag kb-diag-${diagnostic.severity}`} data-kind={diagnostic.kind}>
      <header className="kb-diag-head">
        <span className="kb-diag-sev">{diagnostic.severity}</span>
        <h4 className="kb-diag-title">{diagnostic.title}</h4>
        {taskId && onOpenTask ? (
          <button
            className="btn btn-sm btn-link kb-diag-open"
            onClick={() => onOpenTask(taskId)}
            type="button"
          >
            {diagnostic.task_title ?? taskId}
          </button>
        ) : null}
      </header>
      <p className="kb-diag-detail">{diagnostic.detail}</p>
      {actions.length ? (
        <div className="kb-diag-actions">
          {actions.map((action, i) => (
            <DiagnosticActionButton
              action={action}
              key={`${action.kind}-${i}`}
              onChanged={onChanged}
              onError={onError}
              onFocusComment={
                action.kind === "comment"
                  ? () => onFocusComment?.(taskId)
                  : undefined
              }
              options={options}
              profiles={profiles}
              taskId={taskId}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}
