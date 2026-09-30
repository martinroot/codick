import * as React from "react";

import { Markdown } from "@/components/Markdown";
import { DiagnosticCard } from "@/components/kanban/DiagnosticCard";
import { RecoveryPanel } from "@/components/kanban/RecoveryPanel";
import { ACCENTS } from "@/components/kanban/KanbanBoard";
import {
  kanbanApi,
  type KanbanComment,
  type KanbanDiagnostic,
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
  /**
   * A `comment` diagnostic action wants the Comments tab, not Detail. The
   * drawer owns its tab, so the caller hands over the intent and the `at`
   * timestamp is what makes a repeat request for the same task register.
   */
  commentFocus?: { taskId: string; at: number } | null;
  /**
   * Asks the page to confirm and perform a delete. The drawer does not do it
   * itself: the confirm has to be a real dialog that survives a refusal, and
   * there is already exactly one of those in the app.
   */
  onRequestDelete?: (task: KanbanTaskCard) => void;
  /**
   * Every card on the board, for the dependency editor's suggestions. The
   * editor also accepts an id that is not on the board — the server refuses
   * it with its own sentence — so this widens what the input suggests
   * without ever narrowing what it accepts.
   */
  cards?: KanbanTaskCard[];
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
  commentFocus,
  onRequestDelete,
  cards,
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

  // Honour the comment signal, but only for the task it names — a stale
  // signal must not yank the drawer to another card's tab.
  React.useEffect(() => {
    if (!commentFocus || commentFocus.taskId !== taskId) return;
    setTab("comments");
  }, [commentFocus, taskId]);

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
              cards={cards}
              detail={detail}
              diagnostics={detail?.task.diagnostics ?? []}
              setTab={setTab}
              onChanged={reloadDetail}
              onError={(message) => setActionError(message)}
              onRequestDelete={onRequestDelete}
              options={options}
              task={task}
            />
          ) : null}

          {tab === "comments" ? (
            <CommentsTab
              comments={detail?.comments ?? []}
              detailLoaded={detail !== null}
              options={options}
              onChanged={reloadDetail}
              taskId={taskId}
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

          {tab === "files" ? (
            <FilesTab
              detail={detail}
              options={options}
              onChanged={reloadDetail}
              taskId={taskId}
            />
          ) : null}

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

/**
 * The comment thread, plus the composer that was missing.
 *
 * The drawer could read comments from the day it could render them, but
 * posting meant leaving the drawer for the CLI — the write was reachable
 * from the API and from nowhere in the UI. The composer closes that gap
 * inline: `reloadDetail` re-reads the detail payload after the POST, so
 * your own post appears in the rendered thread without a page reload, at
 * the bottom, where the server's own ordering puts it.
 *
 * Refusals are shown here rather than thrown away: an empty post is the
 * ordinary mistake, and the composer stays open with the text in it.
 */
function CommentsTab({
  taskId,
  comments,
  detailLoaded,
  options,
  onChanged,
}: {
  taskId: string;
  comments: KanbanComment[];
  detailLoaded: boolean;
  options: KanbanRequestOptions;
  onChanged: () => void | Promise<void>;
}) {
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [postError, setPostError] = React.useState<string | null>(null);

  const post = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setPostError(null);
    try {
      await kanbanApi.addComment(taskId, body, options);
      setDraft("");
      await onChanged();
    } catch (err: unknown) {
      setPostError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kb-drawer-section">
      {postError ? (
        <p className="kb-drawer-error" role="alert">
          {postError}
          <button
            className="btn btn-sm btn-link"
            onClick={() => setPostError(null)}
            type="button"
          >
            Dismiss
          </button>
        </p>
      ) : null}
      {comments.length === 0 ? (
        <p className="kb-drawer-muted">No comments yet.</p>
      ) : (
        comments.map((c) => (
          <article className="kb-drawer-item" key={String(c.id)}>
            <p className="kb-drawer-item-head">
              <strong>{c.author ?? "unknown"}</strong>
              <span className="kb-drawer-muted">{when(c.created_at)}</span>
            </p>
            <Markdown content={c.body} />
          </article>
        ))
      )}
      <form
        className="kb-comment-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void post();
        }}
      >
        <textarea
          aria-label="Write a comment"
          className="form-control form-control-sm"
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter posts; Shift+Enter is the newline. Match the chat
            // composer muscle memory — Ctrl+Enter never made it into one.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void post();
            }
          }}
          placeholder="Write a comment…"
          rows={3}
          value={draft}
        />
        <div className="kb-comment-composer-actions">
          <span className="kb-drawer-muted">Enter to post · Shift+Enter for a new line</span>
          <button
            className="btn btn-sm btn-primary"
            disabled={busy || !draft.trim()}
            type="submit"
          >
            {busy ? "Posting…" : "Comment"}
          </button>
        </div>
      </form>
      {!detailLoaded ? (
        <p className="kb-drawer-muted">
          The thread could not be read just now — posting still works, but you
          may be replying to comments you cannot see.
        </p>
      ) : null}
    </div>
  );
}

type LinkSide = "parents" | "children";

function DetailTab({
  detail,
  task,
  options,
  onChanged,
  onError,
  onRequestDelete,
  diagnostics,
  setTab,
  cards,
}: {
  detail: KanbanTaskDetail | null;
  task: KanbanTaskCard;
  options: KanbanRequestOptions;
  onChanged: () => void | Promise<void>;
  onRequestDelete?: (task: KanbanTaskCard) => void;
  onError: (message: string) => void;
  diagnostics: KanbanDiagnostic[];
  setTab: (tab: Tab) => void;
  cards?: KanbanTaskCard[];
}) {
  return (
    <div className="kb-drawer-section">
      {/*
       * Delete lives here, alone at the top of Detail, and not in the header:
       * `kanban_db.delete_task` is a hard DELETE — irreversible, and as of
       * #52 it also terminates a running task's worker and releases any
       * dependent card. A button that reaches that should not sit beside
       * controls you reach for by reflex. The page owns the confirm, which
       * names the two consequences the server now reports.
       */}
      {onRequestDelete ? (
        <div className="kb-drawer-danger">
          <button
            className="btn btn-sm btn-outline-danger"
            onClick={() => onRequestDelete(task)}
            type="button"
          >
            Delete this task
          </button>
          <span className="kb-drawer-muted">
            Removes the card, its comments, events and attachments. No undo.
          </span>
        </div>
      ) : null}

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

      {/* The backend's own diagnosis of this card, above our own controls:
          when both disagree, the server is the one with the events. */}
      {diagnostics.map((d, i) => (
        <DiagnosticCard
          diagnostic={{ ...d, task_id: task.id, task_title: task.title }}
          key={`${d.kind}-${i}`}
          onChanged={onChanged}
          onError={onError}
          onFocusComment={() => setTab("comments")}
          options={options}
        />
      ))}
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

      {detail ? (
        <section className="kb-drawer-block">
          <h3 className="kb-drawer-h3">Dependencies</h3>
          {/*
            `link_tasks` is the title-carrying form of `links`; `links` is the
            authority on what exists. Reading `.parents` off an absent
            `link_tasks` crashed the drawer — and the whole page with it — on
            any task that had a parent, so the fallback is deliberate: an id is
            worse than a title, but it is not a blank screen.
          */}
          <DependenciesEditor
            cards={cards}
            detail={detail}
            options={options}
            onChanged={onChanged}
          />
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

/**
 * Add and remove dependency edges from the drawer.
 *
 * ## Why an editor rather than two text fields
 *
 * A title edit cannot fail in ways that matter; a link can. The server
 * refuses a self-link, an unknown id, a link to a running child, and a
 * cycle — and each refusal names its reason. So the editor shows the
 * server's own sentence verbatim instead of a generic "failed", keeps the
 * inputs filled after a refusal (retrying is usually a typo fix, not a
 * re-type), and clears itself only on success.
 *
 * ## The id with `t_` prefixes
 *
 * The board's links carry full ids (`t_xxx`). The rest of the drawer
 * displays them stripped (`id.replace(/^t_/, "")`), so the editor accepts
 * the short form too and puts the `t_` back — matching what the user can
 * actually see on screen.
 */
function DependenciesEditor({
  detail,
  cards,
  options,
  onChanged,
}: {
  detail: KanbanTaskDetail;
  cards?: KanbanTaskCard[];
  options: KanbanRequestOptions;
  onChanged: () => void | Promise<void>;
}) {
  const [side, setSide] = React.useState<LinkSide>("parents");
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const self = detail.task.id;
  const normalize = (raw: string) => {
    const id = raw.trim();
    if (!id) return "";
    return id.startsWith("t_") ? id : `t_${id}`;
  };

  const add = async () => {
    if (busy) return;
    const other = normalize(value);
    if (!other) return;
    if (other === self) {
      setError("a task cannot depend on itself");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // `side === "parents"`: this task is blocked BY the typed id, so the
      // typed one is the parent. Otherwise this task blocks it and is the
      // child.
      const parentId = side === "parents" ? other : self;
      const childId = side === "parents" ? self : other;
      await kanbanApi.addLink(parentId, childId, options);
      setValue("");
      await onChanged();
    } catch (err: unknown) {
      // The server's sentence, verbatim: "linking t_a -> t_b would create
      // a cycle" beats a generic "failed". The input keeps its text.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (linkParentId: string, linkChildId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await kanbanApi.removeLink(linkParentId, linkChildId, options);
      await onChanged();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // A datalist suggests, it does not constrain: any id the server knows is
  // legal even when the board does not show it (filtered tenant, another
  // tab's fresh card).
  const suggestions = (cards ?? [])
    .filter((c) => c.id !== self)
    .map((c) => ({ id: c.id, title: c.title }));

  /** Title lookup with the detail's own `link_tasks`, per direction. */
  const titleOf = (side: LinkSide, id: string) =>
    (detail.link_tasks?.[side] ?? []).find((t) => t.id === id)?.title ?? null;

  const row = (id: string, side: LinkSide, parentId: string, childId: string) => (
    <li key={`${side}-${id}`} className="kb-deps-row">
      <span>
        <code>{id.replace(/^t_/, "")}</code>
        {titleOf(side, id) ? (
          <span className="kb-deps-title"> {titleOf(side, id)}</span>
        ) : null}
      </span>
      <button
        aria-label={`Remove dependency on ${id}`}
        className="btn btn-sm btn-outline-danger kb-deps-remove"
        disabled={busy}
        onClick={() => void remove(parentId, childId)}
        title="Remove this dependency"
        type="button"
      >
        ✕
      </button>
    </li>
  );

  return (
    <div className="kb-deps">
      {detail.links.parents.length ? (
        <>
          <p className="kb-drawer-muted kb-deps-caption">Blocked by</p>
          <ul className="kb-drawer-list kb-deps-rows">
            {detail.links.parents.map((id) => row(id, "parents", id, self))}
          </ul>
        </>
      ) : null}
      {detail.links.children.length ? (
        <>
          <p className="kb-drawer-muted kb-deps-caption">Blocks</p>
          <ul className="kb-drawer-list kb-deps-rows">
            {detail.links.children.map((id) => row(id, "children", self, id))}
          </ul>
        </>
      ) : null}
      {!detail.links.parents.length && !detail.links.children.length ? (
        <p className="kb-drawer-muted">No dependencies.</p>
      ) : null}

      {error ? (
        <p className="kb-drawer-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="kb-deps-add">
        <select
          aria-label="Dependency direction"
          className="form-select form-select-sm kb-deps-side"
          disabled={busy}
          onChange={(e) => setSide(e.target.value as LinkSide)}
          value={side}
        >
          <option value="parents">Blocked by</option>
          <option value="children">Blocks</option>
        </select>
        <input
          aria-label={side === "parents" ? "Task id that blocks this task" : "Task id this task blocks"}
          className="form-control form-control-sm"
          disabled={busy}
          list="kb-deps-suggestions"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
          placeholder={side === "parents" ? "Task id that blocks this one" : "Task id this one blocks"}
          type="text"
          value={value}
        />
        <datalist id="kb-deps-suggestions">
          {suggestions.map((s) => (
            <option key={s.id} value={s.id.replace(/^t_/, "")}>
              {s.title}
            </option>
          ))}
        </datalist>
        <button
          className="btn btn-sm btn-outline-secondary"
          disabled={busy || !value.trim()}
          onClick={() => void add()}
          type="button"
        >
          {busy ? "Linking…" : "Add"}
        </button>
      </div>
    </div>
  );
}

function FilesTab({
  taskId,
  detail,
  options,
  onChanged,
}: {
  taskId: string;
  detail: KanbanTaskDetail | null;
  options: KanbanRequestOptions;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = React.useState<number | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    if (uploading) return;
    setUploading(true);
    setError(null);
    try {
      await kanbanApi.uploadAttachment(taskId, file, options);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      // Reset so picking the same file again still fires `change`. Without
      // it a re-upload of the same name after a fix is a no-op click.
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = async (id: number) => {
    setBusy(id);
    setError(null);
    try {
      await kanbanApi.deleteAttachment(id, options);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

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
          <button
            className="btn btn-sm btn-link"
            onClick={() => setError(null)}
            type="button"
          >
            Dismiss
          </button>
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
              <span className="kb-file-actions">
                <button
                  className="btn btn-sm btn-outline-secondary"
                  disabled={busy === f.id || uploading}
                  onClick={() => download(f.id)}
                  type="button"
                >
                  {busy === f.id ? "Downloading…" : "Download"}
                </button>
                <button
                  aria-label={`Delete ${f.filename}`}
                  className="btn btn-sm btn-outline-danger"
                  disabled={busy === f.id || uploading}
                  onClick={() => void remove(f.id)}
                  title="Delete this attachment"
                  type="button"
                >
                  {busy === f.id ? "Deleting…" : "Delete"}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="kb-upload"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <input
          aria-label="Choose a file to attach"
          className="form-control form-control-sm"
          disabled={uploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
          ref={inputRef}
          type="file"
        />
        {/* A hidden-input + styled button pair: `type="file"` cannot be
            styled, and the label row needs a real button for focus order. */}
        <button
          className="btn btn-sm btn-primary"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          type="button"
        >
          {uploading ? "Uploading…" : "Attach file"}
        </button>
      </form>
      <p className="kb-drawer-muted kb-upload-note">
        Uploads go through the authenticated fetch path — the same one
        downloads use — so they work behind the dashboard's auth gate.
      </p>
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
