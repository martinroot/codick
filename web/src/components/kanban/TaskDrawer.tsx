import * as React from "react";

import { Markdown } from "@/components/Markdown";
import { RecoveryPanel } from "@/components/kanban/RecoveryPanel";
import { ACCENTS } from "@/components/kanban/KanbanBoard";
import {
  kanbanApi,
  type KanbanRequestOptions,
  type KanbanStatus,
  type KanbanTaskCard,
  type KanbanTaskDetail,
} from "@/lib/kanban-api";

/**
 * The task drawer.
 *
 * Clicking a card used to write "open <id>" into a notice and stop there, so
 * every signal the board put on the card was a dead end. This is where the
 * rest of the task lives: the full body, the comment thread, the event
 * history, attachments, both link directions, children's results and the run
 * history.
 *
 * Two things are deliberately not fetched up front:
 *
 * - **The worker log.** It can be 100 KB, and opening a card is not a request
 *   to read it. It loads when its tab is shown, and it says so while it does.
 * - **The detail itself**, if the task is already open. Re-reading on every
 *   click would fight the live-update re-reads from the board.
 */
export interface TaskDrawerProps {
  taskId: string | null;
  options: KanbanRequestOptions;
  onClose: () => void;
  /** A card the board already holds, shown immediately so the drawer is not
   *  an empty pane while the detail is in flight. */
  seed?: KanbanTaskCard | null;
  /** Notified after every successful read, so the board can follow along. */
  onChanged?: () => void;
}

type Tab = "detail" | "comments" | "events" | "runs" | "files" | "log";

const TABS: { id: Tab; label: string }[] = [
  { id: "detail", label: "Detail" },
  { id: "comments", label: "Comments" },
  { id: "events", label: "Events" },
  { id: "runs", label: "Runs" },
  { id: "files", label: "Files" },
  { id: "log", label: "Log" },
];

function when(seconds: number | null | undefined): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString();
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function TaskDrawer({
  taskId,
  options,
  onClose,
  seed,
  onChanged,
}: TaskDrawerProps) {
  const [detail, setDetail] = React.useState<KanbanTaskDetail | null>(null);
  const [load, setLoad] = React.useState<{ phase: string; message?: string }>({
    phase: "idle",
  });
  const [tab, setTab] = React.useState<Tab>("detail");
  const [log, setLog] = React.useState<{ text: string; phase: string } | null>(null);
  /**
   * A refusal from a recovery action -- 409 "already ended", 409 "no longer
   * reclaimable" -- is information, not breakage. It is shown in the panel and
   * the drawer stays open, because the correct next step is usually to look at
   * the card again rather than retry.
   */
  const [actionError, setActionError] = React.useState<string | null>(null);

  /**
   * Re-read after a mutation. Deliberately does not flip the drawer into its
   * loading phase: a panel that blanks while acting looks like the click
   * failed, and on a reclaim that is exactly the wrong impression.
   */
  const reloadDetail = React.useCallback(async () => {
    if (!taskId) return;
    try {
      const payload = await kanbanApi.getTask(taskId, options);
      setDetail(payload);
      onChanged?.();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [options, onChanged, taskId]);

  // A new task resets everything. Keeping the previous task's comments on
  // screen while the next one loads is how you end up reading one task while
  // believing you are reading another.
  React.useEffect(() => {
    if (!taskId) {
      setDetail(null);
      setLoad({ phase: "idle" });
      setTab("detail");
      setLog(null);
      setActionError(null);
      return;
    }
    let cancelled = false;
    setLoad({ phase: "loading" });
    kanbanApi
      .getTask(taskId, options)
      .then((payload) => {
        if (cancelled) return;
        setDetail(payload);
        setLoad({ phase: "ready" });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoad({ phase: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
    // `options` is memoised on the board, so this does not re-run per render.
  }, [taskId, options]);

  // The log is fetched when its tab is opened, not before.
  React.useEffect(() => {
    if (tab !== "log" || !taskId || log !== null) return;
    let cancelled = false;
    setLog({ text: "", phase: "loading" });
    kanbanApi
      .getTaskLog(taskId, options, 2000)
      .then((payload) => {
        if (!cancelled) setLog({ text: payload.log ?? "", phase: "ready" });
      })
      .catch(() => {
        if (!cancelled) setLog({ text: "", phase: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [tab, taskId, options, log]);

  React.useEffect(() => {
    if (!taskId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [taskId, onClose]);

  if (!taskId) return null;

  const task = detail?.task ?? seed ?? null;
  const counts: Record<Tab, number | null> = {
    detail: null,
    comments: detail?.comments.length ?? null,
    events: detail?.events.length ?? null,
    runs: detail?.runs.length ?? null,
    files: detail?.attachments.length ?? null,
    log: null,
  };

  return (
    <>
      <div className="kb-drawer-backdrop" onClick={onClose} aria-hidden />
      <aside
        className="kb-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={task?.title ?? "Task"}
      >
        <header className="kb-drawer-head">
          <div className="kb-drawer-head-main">
            <h2 className="kb-drawer-title">{task?.title ?? "Loading…"}</h2>
            {task ? (
              <p className="kb-drawer-sub">
                <code>{task.id}</code>
                <span className="kb-drawer-status">
                  <span
                    className="kb-dot"
                    style={{ background: ACCENTS[task.status] }}
                    aria-hidden
                  />
                  {task.status}
                </span>
                {task.assignee ? (
                  <span className="kb-drawer-assignee">@{task.assignee}</span>
                ) : null}
              </p>
            ) : null}
          </div>
          <button
            aria-label="Close task"
            className="btn btn-sm btn-outline-secondary"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </header>

        <nav className="kb-drawer-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              aria-selected={tab === t.id}
              className={`kb-drawer-tab${tab === t.id ? " is-active" : ""}`}
              key={t.id}
              onClick={() => setTab(t.id)}
              role="tab"
              type="button"
            >
              {t.label}
              {counts[t.id] ? <span className="kb-drawer-count">{counts[t.id]}</span> : null}
            </button>
          ))}
        </nav>

        <div className="kb-drawer-body">
          {load.phase === "error" ? (
            <p className="kb-drawer-error" role="alert">
              {load.message}
            </p>
          ) : null}

          {/* A refusal from a recovery action, shown separately from a load
              failure: the detail loaded fine, the action did not. */}
          {actionError ? (
            <p className="kb-drawer-error" role="alert">
              {actionError}
              <button
                className="btn btn-sm btn-link"
                onClick={() => setActionError(null)}
                type="button"
              >
                Dismiss
              </button>
            </p>
          ) : null}

          {!detail && load.phase === "loading" ? (
            <p className="kb-drawer-muted">Loading…</p>
          ) : null}

          {tab === "detail" && task ? (
            <DetailTab
              detail={detail}
              onChanged={reloadDetail}
              onError={(message) => setActionError(message)}
              options={options}
              task={task}
            />
          ) : null}

          {tab === "comments" ? (
            <List
              empty="No comments yet."
              items={detail?.comments ?? []}
              render={(c) => (
                <article className="kb-drawer-item" key={String(c.id)}>
                  <p className="kb-drawer-item-head">
                    <strong>{c.author ?? "unknown"}</strong>
                    <span className="kb-drawer-muted">{when(c.created_at)}</span>
                  </p>
                  <Markdown content={c.body} />
                </article>
              )}
            />
          ) : null}

          {tab === "events" ? (
            <List
              empty="No events recorded."
              items={detail?.events ?? []}
              render={(e) => (
                <p className="kb-drawer-item" key={e.id}>
                  <code>{e.kind}</code>
                  <span className="kb-drawer-muted"> {when(e.created_at)}</span>
                </p>
              )}
            />
          ) : null}

          {tab === "runs" ? (
            <List
              empty="This task has not run yet."
              items={detail?.runs ?? []}
              render={(r) => (
                <article className="kb-drawer-item" key={r.id}>
                  <p className="kb-drawer-item-head">
                    <strong>{r.status}</strong>
                    {r.outcome ? <span className="kb-drawer-muted"> → {r.outcome}</span> : null}
                    <span className="kb-drawer-muted">{when(r.started_at)}</span>
                  </p>
                  {r.summary ? <p>{r.summary}</p> : null}
                  {r.error ? <p className="kb-drawer-error">{r.error}</p> : null}
                </article>
              )}
            />
          ) : null}

          {tab === "files" ? <FilesTab detail={detail} options={options} /> : null}

          {tab === "log" ? (
            <div className="kb-drawer-log">
              {log === null || log.phase === "loading" ? (
                <p className="kb-drawer-muted">Loading log…</p>
              ) : log.phase === "error" ? (
                <p className="kb-drawer-error">The worker log is not available for this task.</p>
              ) : log.text ? (
                <pre>{log.text}</pre>
              ) : (
                <p className="kb-drawer-muted">The worker log is empty.</p>
              )}
            </div>
          ) : null}
        </div>

        {onChanged && detail ? (
          <footer className="kb-drawer-foot">
            <span className="kb-drawer-muted">id {task?.id}</span>
          </footer>
        ) : null}
      </aside>
    </>
  );
}

function DetailTab({
  detail,
  task,
  options,
  onChanged,
  onError,
}: {
  detail: KanbanTaskDetail | null;
  task: KanbanTaskCard;
  options: KanbanRequestOptions;
  onChanged: () => void | Promise<void>;
  onError: (message: string) => void;
}) {
  return (
    <div className="kb-drawer-section">
      {/* Recovery sits above the description: when a card is stuck, the
          question is "what do I do about it", not "what is it". */}
      {detail ? (
        <RecoveryPanel
          onChanged={onChanged}
          onError={onError}
          options={options}
          task={detail}
        />
      ) : null}
      {task.body ? (
        <section className="kb-drawer-block">
          <h3 className="kb-drawer-h3">Description</h3>
          <Markdown content={task.body} />
        </section>
      ) : null}

      <section className="kb-drawer-block">
        <h3 className="kb-drawer-h3">Fields</h3>
        <dl className="kb-drawer-fields">
          <dt>Status</dt>
          <dd>{task.status}</dd>
          <dt>Assignee</dt>
          <dd>{task.assignee ?? "— unassigned"}</dd>
          <dt>Priority</dt>
          <dd>{task.priority || "—"}</dd>
          <dt>Tenant</dt>
          <dd>{task.tenant ?? "—"}</dd>
          {/*
            Provider before model, because the model is chosen *within* a
            provider's catalogue. Showing the model alone hides which vendor
            the override is actually reaching for.
          */}
          <dt>Model override</dt>
          <dd>
            {task.provider_override || task.model_override
              ? [task.provider_override, task.model_override].filter(Boolean).join(" / ")
              : "— inherits the profile"}
          </dd>
          <dt>Reasoning</dt>
          <dd>{task.reasoning_effort ?? "— inherits"}</dd>
          <dt>Created</dt>
          <dd>{when(task.created_at)}</dd>
          <dt>Completed</dt>
          <dd>{when(task.completed_at)}</dd>
        </dl>
      </section>

      {detail && (detail.links.parents.length || detail.links.children.length) ? (
        <section className="kb-drawer-block">
          <h3 className="kb-drawer-h3">Dependencies</h3>
          {detail.links.parents.length ? (
            <>
              <p className="kb-drawer-muted">Blocked by</p>
              <ul className="kb-drawer-list">
                {detail.link_tasks.parents.map((t) => (
                  <li key={t.id}>
                    <code>{t.id.replace(/^t_/, "")}</code> {t.title}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {detail.links.children.length ? (
            <>
              <p className="kb-drawer-muted">Blocks</p>
              <ul className="kb-drawer-list">
                {detail.link_tasks.children.map((t) => (
                  <li key={t.id}>
                    <code>{t.id.replace(/^t_/, "")}</code> {t.title}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      {detail?.child_results.length ? (
        <section className="kb-drawer-block">
          <h3 className="kb-drawer-h3">Child results</h3>
          {detail.child_results.map((c) => (
            <article className="kb-drawer-item" key={c.id}>
              <p className="kb-drawer-item-head">
                <strong>{c.title}</strong>
                <span className="kb-drawer-status">
                  <span
                    className="kb-dot"
                    style={{ background: ACCENTS[c.status as KanbanStatus] }}
                    aria-hidden
                  />
                  {c.status}
                </span>
              </p>
              {c.latest_summary ? <p>{c.latest_summary}</p> : null}
              {c.result ? (
                <details>
                  <summary>Result</summary>
                  <pre>{c.result}</pre>
                </details>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}

      {task.result ? (
        <section className="kb-drawer-block">
          <h3 className="kb-drawer-h3">Result</h3>
          {/* The result is agent output, not user-authored copy, so it is
              shown verbatim: escaping it would change what was produced. */}
          <pre>{task.result}</pre>
        </section>
      ) : null}
    </div>
  );
}

function FilesTab({
  detail,
  options,
}: {
  detail: KanbanTaskDetail | null;
  options: KanbanRequestOptions;
}) {
  const [busy, setBusy] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const download = async (id: number) => {
    setBusy(id);
    setError(null);
    try {
      const { blob, filename } = await kanbanApi.downloadAttachment(id, options);
      // A synthetic anchor, because a plain link sends no Authorization
      // header and every download 401s in a gated deployment.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on the next tick; revoking synchronously can cancel the
      // download in some browsers before it has read the blob.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const files = detail?.attachments ?? [];
  return (
    <div className="kb-drawer-section">
      {error ? (
        <p className="kb-drawer-error" role="alert">
          {error}
        </p>
      ) : null}
      {files.length === 0 ? (
        <p className="kb-drawer-muted">No attachments.</p>
      ) : (
        <ul className="kb-drawer-list">
          {files.map((f) => (
            <li className="kb-drawer-file" key={f.id}>
              <span>
                {f.filename}
                <span className="kb-drawer-muted"> · {size(f.size)}</span>
              </span>
              <button
                className="btn btn-sm btn-outline-secondary"
                disabled={busy === f.id}
                onClick={() => download(f.id)}
                type="button"
              >
                {busy === f.id ? "Downloading…" : "Download"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function List<T>({
  items,
  render,
  empty,
}: {
  items: T[];
  render: (item: T, index: number) => React.ReactNode;
  empty: string;
}) {
  if (items.length === 0) return <p className="kb-drawer-muted">{empty}</p>;
  return <div className="kb-drawer-section">{items.map(render)}</div>;
}
