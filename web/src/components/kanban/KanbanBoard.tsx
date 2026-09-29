/**
 * Trello-style kanban board.
 *
 * The visual target is Trello: fixed-width columns on a horizontally
 * scrolling rail, cards as the only elevated surface, colour used
 * sparingly (a status dot, a label chip) so the board reads as a list of
 * cards rather than a pile of boxes.
 *
 * Column density, card density and the hover/active shadows are all
 * driven by CSS custom properties in `kanban.css`, so the board can be
 * retuned without touching this file.
 *
 * Drag and drop: HTML5 DnD on pointer devices plus a pointer-events
 * fallback for touch, mirroring what the shipped plugin does. `onMove`
 * is the only write path — the board owns no state beyond optimistic
 * positioning, so the same component works against mock data and against
 * the real API.
 */

import * as React from "react";

import type { KanbanStatus, KanbanTaskCard } from "@/lib/kanban-api";
import { Button } from "@/ui";
import { cn } from "@/lib/utils";
import "./kanban.css";

export type { KanbanStatus } from "@/lib/kanban-api";

// The board renders the server's card, not a board-shaped summary of it.
// A local type invented for the prototype carried `dueAt`, `attachmentCount`,
// `labels`, `checklist*`, `updatedAt`, `blockedReason` and `runSummary`:
// the first two exist nowhere in the API, so the chips that read them could
// never have been driven by real data. Renaming to the real fields makes
// that impossible — a field the server does not send is a type error now
// rather than an empty chip at runtime.
type KanbanTask = KanbanTaskCard;

export interface KanbanColumn {
  name: KanbanStatus;
  tasks: KanbanTaskCard[];
}

export const KANBAN_COLUMNS: KanbanStatus[] = [
  "triage",
  "todo",
  "scheduled",
  "ready",
  "running",
  "blocked",
  "review",
  "done",
];

export const COLUMN_TITLES: Record<KanbanStatus, string> = {
  triage: "Triage",
  todo: "To Do",
  scheduled: "Scheduled",
  ready: "Ready",
  running: "Running",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
};

/** Accent per column — the dot in the header and the drop-target tint. */
/*
 * Trello's label palette. Labels are the loudest thing on a card by design
 * -- they are the fastest thing to scan across a board -- so they are solid
 * fills with white text, not tinted chips.
 *
 * A label's colour is derived from its name rather than assigned in the data,
 * so a card that arrives with `["bug", "infra"]` is coloured without the
 * caller having to know Trello's palette exists. The hash is FNV-1a: stable
 * across reloads, which a character-code sum is not when the same word appears
 * with different neighbours.
 */
const LABEL_COLORS = [
  "#61bd4f", // green
  "#f2d600", // yellow
  "#ff9f1a", // orange
  "#eb5a46", // red
  "#c377e0", // purple
  "#0079bf", // blue
  "#00c2e0", // sky
  "#51e898", // lime
  "#ff78cb", // pink
  "#344563", // black
  "#ff9f1a", // tangerine (alias kept close to orange)
  "#00b3a4", // teal
];

function labelColor(name: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return LABEL_COLORS[hash % LABEL_COLORS.length];
}

/**
 * The one accent per status. Exported so the drawer colours a status pill
 * with the same value the column header's dot uses -- otherwise the same
 * status wears two different colours depending on which surface it is on,
 * which is the kind of inconsistency that makes a board unreadable.
 */
export const ACCENTS: Record<KanbanStatus, string> = {
  triage: "#b48ce8",
  todo: "#7c8aa0",
  scheduled: "#5b9bd5",
  ready: "#d4b348",
  running: "#3fb97d",
  blocked: "#e05252",
  review: "#48b0c4",
  done: "#4a8cd1",
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Formats a duration in seconds. Not an epoch — see the card for why. */
function duration(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}


/**
 * How long a card has been sitting on nothing, in seconds.
 *
 * The reference point depends on what the column is *waiting for*. A running
 * card is waiting for a heartbeat, so its clock is the last one; a queued card
 * is waiting to be picked up, so its clock is when it was created. Using the
 * wrong one makes a healthy new task look ancient and a wedged worker look
 * fresh — which is the exact inversion the tint is supposed to prevent.
 *
 * Terminal and explicitly-held columns return null. A done card is not late
 * and a blocked card has already said it is stuck; colouring them would train
 * the eye to ignore the tint where it matters.
 */
function idleSeconds(task: KanbanTask, now: number | null): number | null {
  if (now === null) return null;
  switch (task.status) {
    case "running":
    case "review":
      return task.last_heartbeat_at !== null ? now - task.last_heartbeat_at : null;
    case "triage":
    case "todo":
    case "ready":
      return task.created_at ? now - task.created_at : null;
    default:
      return null;
  }
}

/**
 * The two tint tiers, with the amber threshold taken from the server's own
 * claim TTL rather than invented here.
 *
 * `DEFAULT_CLAIM_TTL_SECONDS` is 15 minutes in `hermes_cli/kanban_db.py`, and
 * `DEFAULT_CLAIM_HEARTBEAT_MAX_STALE_SECONDS` is 60. Using those numbers
 * means the board's idea of "late" tracks the dispatcher's own idea, instead
 * of being a second threshold that drifts from it.
 *
 * This is a *visual* cue, not a diagnosis. The authoritative judgement is the
 * server's diagnostic chip, which knows about reclaim grace periods and
 * whether a live PID is still working. Re-deciding "stuck" here would be a
 * second implementation of a rule the backend already owns.
 */
const STALE_AMBER_SECONDS = 15 * 60;
const STALE_RED_SECONDS = 60 * 60;

type StaleTier = "amber" | "red" | null;

function staleness(task: KanbanTask, now: number | null): StaleTier {
  const idle = idleSeconds(task, now);
  if (idle === null || idle < 0) return null;
  if (idle >= STALE_RED_SECONDS) return "red";
  if (idle >= STALE_AMBER_SECONDS) return "amber";
  return null;
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

export interface KanbanCardProps {
  task: KanbanTask;
  dragging: boolean;
  selected?: boolean;
  /**
   * Reported for a plain click, a modifier-click, and a shift-click. The
   * board decides what each means; the card does not know about ranges.
   */
  onSelect?: (
    task: KanbanTask,
    modifiers: { toggle: boolean; range: boolean },
  ) => void;
  /**
   * The board payload's `now`, in the server's clock. Staleness is measured
   * against it rather than the browser's, so a card whose age the server
   * reports and the tint the server implies agree even if the two clocks
   * differ.
   */
  now: number | null;
  onDragStart: (event: React.DragEvent<HTMLElement>, task: KanbanTask) => void;
  onDragEnd: () => void;
  onOpen?: (task: KanbanTask) => void;
}

function KanbanCardImpl({
  task,
  dragging,
  now,
  selected = false,
  onDragStart,
  onDragEnd,
  onOpen,
  onSelect,
}: KanbanCardProps) {
  // A drag ends with the mouse released over the card, and the browser fires
  // `click` for that too. Without this guard every drag would also open the
  // drawer or toggle the selection, which looks like the board choosing to do
  // two things at once.
  const pressedAt = React.useRef<{ x: number; y: number } | null>(null);
  const suppressClick = React.useRef(false);
  // `skills` is the only list of strings the card carries, and it is what the
  // prototype's invented `labels` was standing in for.
  const labels = task.skills ?? [];
  // Progress is a child-task rollup, not a checklist: null when the task has
  // no children, and there is nothing to show in that case.
  const progress = task.progress;
  // A card's age is a *duration*, not an epoch. The server sends no update
  // time, so this comes from `age.created_age_seconds` — passing it to an
  // epoch formatter is off by ~56 years and renders as "20725d".
  const age = task.age?.created_age_seconds ?? null;
  // Blocked is a server diagnosis, not free text on the card. Prefer the
  // worst diagnostic; fall back to the failure that produced it.
  const blocked =
    task.diagnostics?.find((d) => d.severity !== "warning")?.title ??
    task.diagnostics?.[0]?.title ??
    task.last_failure_error ??
    null;

  const tier = staleness(task, now);
  const idle = idleSeconds(task, now);
  // A claimed card is working; an unclaimed running card is a gap between
  // "dispatched" and "someone picked it up", which is the state a board
  // usually hides because it looks the same as busy.
  const claimed = Boolean(task.claim_lock);

  return (
    <article
      aria-selected={selected}
      className={cn(
        "kb-card",
        dragging && "kb-card-dragging",
        selected && "kb-card-selected",
        tier && `kb-card-stale-${tier}`,
      )}
      draggable
      onDragEnd={onDragEnd}
      onDragStart={(event) => onDragStart(event, task)}
      onMouseDown={(event) => {
        pressedAt.current = { x: event.clientX, y: event.clientY };
        suppressClick.current = false;
      }}
      onDragStartCapture={() => {
        // A real drag, not a click that has not started yet.
        suppressClick.current = true;
      }}
      onClick={(event) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        // A long press-and-hold on a trackpad can end as a click without ever
        // dragging; the movement check catches that case too.
        if (pressedAt.current) {
          const moved = Math.hypot(
            event.clientX - pressedAt.current.x,
            event.clientY - pressedAt.current.y,
          );
          if (moved > 5) return;
        }
        if (event.metaKey || event.ctrlKey || event.shiftKey) {
          event.preventDefault();
          onSelect?.(task, {
            toggle: event.metaKey || event.ctrlKey,
            range: event.shiftKey,
          });
          return;
        }
        onOpen?.(task);
      }}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === " ") {
          // Space selects. It is the conventional binding for this and it
          // is the binding that was broken by a 32-space literal, so it is
          // also the one most likely to be expected to work.
          event.preventDefault();
          onSelect?.(task, { toggle: true, range: event.shiftKey });
        } else if (event.key === "Enter") {
          event.preventDefault();
          onOpen?.(task);
        }
      }}
    >
      {/*
        The checkbox is always present rather than revealed on hover. A
        control that appears only under the cursor is not discoverable on a
        touch screen at all, and this board is used one-handed.
      */}
      <label
        className="kb-card-pick"
        onClick={(event) => event.stopPropagation()}
        title="Select for bulk actions"
      >
        <input
          checked={selected}
          onChange={() => onSelect?.(task, { toggle: true, range: false })}
          type="checkbox"
        />
        <span aria-hidden>✓</span>
      </label>

      {labels.length ? (
        <div className="kb-card-labels">
          {labels.map((label) => (
            <span
              className="kb-label"
              key={label}
              // Yellow is the one Trello colour that white text fails
              // against; the chip carries its own ink rather than forcing
              // every label to look the same.
              style={
                labelColor(label) === "#f2d600"
                  ? { background: labelColor(label), color: "#4c4c4c" }
                  : { background: labelColor(label) }
              }
            >
              {label}
            </span>
          ))}
        </div>
      ) : null}

      <h3 className="kb-card-title">{task.title}</h3>

      <div className="kb-card-ident">
        {/* The short id, so a card can be named in a terminal or a bug report
            without going to the detail drawer for it first. */}
        <code title={task.id}>{task.id.replace(/^t_/, "")}</code>
      </div>

      {task.latest_summary ? (
        <p className="kb-card-summary">{task.latest_summary}</p>
      ) : null}

      {blocked ? (
        <p className="kb-card-blocked" role="note">
          {blocked}
        </p>
      ) : null}

      <div className="kb-card-meta">
        {progress ? (
          <span
            className={cn("kb-chip", progress.done === progress.total && "kb-chip-done")}
            title={`${progress.done} of ${progress.total} subtasks done`}
          >
            <span aria-hidden>☑</span>
            {progress.done}/{progress.total}
          </span>
        ) : null}

        {task.comment_count ? (
          <span className="kb-chip">
            <span aria-hidden>💬</span>
            {task.comment_count}
          </span>
        ) : null}

        {task.link_counts.children ? (
          <span className="kb-chip" title={`${task.link_counts.children} subtasks`}>
            <span aria-hidden>⑂</span>
            {task.link_counts.children}
          </span>
        ) : null}

        {task.priority ? <span className="kb-chip kb-chip-priority">P{task.priority}</span> : null}

        {/*
          The claims a card cannot make on its own surface. Each is a field
          the server already sends and the board was dropping, so an operator
          reading the board was deciding on less than the backend knew.
        */}
        {task.tenant ? (
          <span className="kb-chip" title={`Tenant: ${task.tenant}`}>
            <span aria-hidden>⌂</span>
            {task.tenant}
          </span>
        ) : null}

        {task.link_counts.parents ? (
          <span
            className="kb-chip"
            title={`Blocked by ${task.link_counts.parents} parent task(s)`}
          >
            <span aria-hidden>⇠</span>
            {task.link_counts.parents}
          </span>
        ) : null}

        {/*
          Unassigned is a state, not an absence. On a board full of cards a
          blank corner reads as "nothing to see", while a real marker is what
          makes an unstaffed queue visible at a glance.
        */}
        {!task.assignee && task.status !== "done" ? (
          <span className="kb-chip kb-chip-needs-assignee" title="Needs an assignee">
            <span aria-hidden>☞</span>
            Unassigned
          </span>
        ) : null}

        {claimed ? (
          <span
            className={cn("kb-chip", !tier && "kb-chip-claimed")}
            title={
              task.claim_expires
                ? `Claim held until ${new Date(task.claim_expires * 1000).toLocaleTimeString()}`
                : "Claim held"
            }
          >
            <span aria-hidden>⚿</span>
            claimed
          </span>
        ) : null}

        {task.worker_pid ? (
          <span className="kb-chip" title={`Worker process ${task.worker_pid}`}>
            <span aria-hidden>⏻</span>
            {task.worker_pid}
          </span>
        ) : null}

        {task.consecutive_failures > 0 ? (
          <span
            className="kb-chip kb-chip-failures"
            title={
              task.last_failure_error
                ? `${task.consecutive_failures} failure(s): ${task.last_failure_error}`
                : `${task.consecutive_failures} consecutive failure(s)`
            }
          >
            <span aria-hidden>↻</span>
            {task.consecutive_failures}
          </span>
        ) : null}

        {task.diagnostics?.length ? (
          <span
            className={cn(
              "kb-chip",
              task.diagnostics.some((d) => d.severity !== "warning") && "kb-chip-overdue",
              // A warning and a real diagnosis look identical if they are
              // only distinguished by a count, and the count is the smaller
              // number when things are worse.
              task.diagnostics.every((d) => d.severity === "warning") && "kb-chip-warning",
            )}
            title={task.diagnostics
              .map((d) => `${d.severity}: ${d.title}`)
              .join("; ")}
          >
            <span aria-hidden>⚠</span>
            {task.diagnostics.length}
          </span>
        ) : null}

        <span className="kb-card-spacer" />

        {/*
          Prefer the idle clock. On a running card the creation age is noise --
          a nine-hour task with a heartbeat a second ago is not nine hours
          late -- and showing both would put two different numbers next to
          each other with no way to tell which one the colour follows.
        */}
        {(idle ?? age) !== null ? (
          <span
            className={cn("kb-age", tier && `kb-age-${tier}`)}
            title={
              tier
                ? `No activity for ${duration(idle ?? 0)}`
                : `Created ${age !== null ? duration(age) : "just now"} ago`
            }
          >
            {duration(idle ?? age ?? 0)}
          </span>
        ) : null}

        {task.assignee ? (
          <span className="kb-avatar" title={task.assignee}>
            {task.assignee.slice(0, 2).toUpperCase()}
          </span>
        ) : (
          <span className="kb-avatar kb-avatar-empty" title="Unassigned">
            ?
          </span>
        )}
      </div>
    </article>
  );
}

export const KanbanCard = React.memo(KanbanCardImpl);

/** Stable identities for the read-only defaults, so a missing handler does
 *  not make every card a new props object on every render. */
const EMPTY_SET: ReadonlySet<string> = new Set();
function noopSelect() {}

/* ------------------------------------------------------------------ */
/* Column                                                              */
/* ------------------------------------------------------------------ */

export interface KanbanColumnProps {
  column: KanbanColumn;
  now: number | null;
  draggingId: string | null;
  dropTarget: KanbanStatus | null;
  onDragStart: (event: React.DragEvent<HTMLElement>, task: KanbanTask) => void;
  onDragEnd: () => void;
  onDragOverColumn: (status: KanbanStatus) => void;
  onDropColumn: (status: KanbanStatus, dataTransfer: DataTransfer | null) => void;
  onOpenTask?: (task: KanbanTask) => void;
  /**
   * Creates a card in this column. Returns the server's card so the board
   * can place what the server actually made — the status it came back with
   * is not always the one that was asked for.
   */
  onCreateCard?: (status: KanbanStatus, title: string) => Promise<KanbanTaskCard>;
  selectedIds: ReadonlySet<string>;
  onSelectTask: NonNullable<KanbanBoardProps["onSelectTask"]>;
  /** Select exactly these ids. Replaces the selection, it does not add to it. */
  onSelectColumn: (ids: string[], column: string) => void;
  /** This column's first index in reading order. */
  orderOffset: number;
}

function KanbanColumnView({
  column,
  now,
  selectedIds,
  onSelectTask,
  onSelectColumn,
  orderOffset,
  draggingId,
  dropTarget,
  onDragStart,
  onDragEnd,
  onDragOverColumn,
  onDropColumn,
  onOpenTask,
  onCreateCard,
}: KanbanColumnProps) {
  const isDropTarget = dropTarget === column.name;
  const wipExceeded = column.name === "running" && column.tasks.length > 4;

  // `running` is not a column you can create into: PATCH rejects it with a
  // 400 and a task only reaches it by being dispatched. Offering the composer
  // there would produce a guaranteed failure on submit.
  const creatable = column.name !== "running" && Boolean(onCreateCard);
  const [composing, setComposing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const openComposer = React.useCallback(() => {
    if (!creatable) return;
    setComposing(true);
  }, [creatable]);

  const submit = React.useCallback(async () => {
    const title = draft.trim();
    if (!title || !onCreateCard || saving) return;
    setSaving(true);
    try {
      await onCreateCard(column.name, title);
      setDraft("");
      // Stay open: adding three cards should not mean retyping the box.
    } catch {
      // The page surfaces the reason. Swallowing the title here would lose
      // what someone typed over an error message, which is the worst
      // possible time to lose it.
    } finally {
      setSaving(false);
    }
  }, [column.name, draft, onCreateCard, saving]);

  return (
    <section
      aria-label={COLUMN_TITLES[column.name]}
      className={cn("kb-column", isDropTarget && "kb-column-drop")}
      data-status={column.name}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDragOverColumn(column.name);
      }}
      onDragLeave={(event) => {
        // Ignore leave events bubbling from children — only a genuine
        // exit from the column should clear the highlight.
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          onDragOverColumn(null as unknown as KanbanStatus);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDropColumn(column.name, event.dataTransfer);
      }}
    >
      <header className="kb-column-header">
        <span className="kb-dot" style={{ background: ACCENTS[column.name] }} aria-hidden />
        <h2 className="kb-column-title">{COLUMN_TITLES[column.name]}</h2>
        <span className={cn("kb-count", wipExceeded && "kb-count-over")}>{column.tasks.length}</span>
        {column.tasks.length ? (
          <button
            className="kb-column-selectall"
            onClick={() => onSelectColumn(column.tasks.map((t) => t.id), column.name)}
            title={`Select all ${column.tasks.length} in ${COLUMN_TITLES[column.name]}`}
            type="button"
          >
            ⌗
          </button>
        ) : null}
        {/* Absent rather than disabled in `running`: a control that cannot
            ever succeed is noise, and the column header should say what the
            column is for, not that a task is in flight there. */}
        {creatable ? (
          <button
            className="kb-column-add"
            onClick={openComposer}
            type="button"
            aria-label={`Add card to ${COLUMN_TITLES[column.name]}`}
          >
            +
          </button>
        ) : null}
      </header>

      <div className="kb-column-body">
        {column.tasks.length === 0 ? (
          <p className="kb-empty">Drop cards here</p>
        ) : (
          column.tasks.map((task, indexInColumn) => (
            <KanbanCard
              dragging={draggingId === task.id}
              key={task.id}
              now={now}
              onSelect={(t, mods) => onSelectTask(t, mods, orderOffset + indexInColumn)}
              selected={selectedIds.has(task.id)}
              onDragEnd={onDragEnd}
              onDragStart={onDragStart}
              onOpen={onOpenTask}
              task={task}
            />
          ))
        )}
      </div>

      {/* Trello puts the composer at the foot of the list, not in the
          header -- the header's + is a quick-add and this is the full one. */}
      {composing ? (
        <form
          className="kb-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <textarea
            autoFocus
            className="kb-composer-input"
            onBlur={() => {
              // Trello closes an untouched composer when it loses focus. One
              // with text stays open, so a stray click cannot discard a title
              // someone just typed.
              if (!draft.trim()) setComposing(false);
            }}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft("");
                setComposing(false);
              }
            }}
            placeholder="What needs doing?"
            rows={3}
            value={draft}
          />
          <div className="kb-composer-actions">
            <Button disabled={saving || !draft.trim()} size="sm" type="submit">
              {saving ? "Adding…" : "Add card"}
            </Button>
            <Button ghost onClick={() => { setDraft(""); setComposing(false); }} size="sm" type="button">
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {creatable ? (
        <footer className="kb-column-footer">
          <button className="kb-add-card" onClick={openComposer} type="button">
            <span aria-hidden>+</span>
            Add a card
          </button>
        </footer>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Board                                                               */
/* ------------------------------------------------------------------ */

export interface KanbanBoardProps {
  columns: KanbanColumn[];
  /** The payload's server clock, threaded to each card for the staleness tint. */
  now?: number | null;
  onMove?: (taskId: string, to: KanbanStatus) => void;
  onOpenTask?: (task: KanbanTask) => void;
  /**
   * Omit to make the board read-only: the composer and both add controls
   * disappear rather than appearing and failing. The page passes it only
   * when a board is loaded and writable.
   */
  onCreateCard?: (status: KanbanStatus, title: string) => Promise<KanbanTaskCard>;
  /** Ids currently selected for bulk actions. */
  selectedIds?: ReadonlySet<string>;
  /**
   * Selection changed. `index` is the card's position in reading order
   * (column by column), which is what a shift-range is measured in.
   */
  onSelectTask?: (
    task: KanbanTask,
    modifiers: { toggle: boolean; range: boolean },
    index: number,
  ) => void;
  /** Replace the selection outright — select-all, clear, per-column. */
  onSelectMany?: (ids: string[]) => void;
}

export function KanbanBoard({
  columns,
  now = null,
  onMove,
  onOpenTask,
  onCreateCard,
  selectedIds,
  onSelectTask,
  onSelectMany,
}: KanbanBoardProps) {
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<KanbanStatus | null>(null);
  const totalCards = React.useMemo(
    () => columns.reduce((sum, column) => sum + column.tasks.length, 0),
    [columns],
  );

  const handleDragStart = React.useCallback((event: React.DragEvent<HTMLElement>, task: KanbanTask) => {
    setDraggingId(task.id);
    event.dataTransfer.effectAllowed = "move";
    // Firefox refuses to start a drag unless some data is set.
    event.dataTransfer.setData("text/plain", task.id);
  }, []);

  const handleDragEnd = React.useCallback(() => {
    setDraggingId(null);
    setDropTarget(null);
  }, []);

  const handleDragOverColumn = React.useCallback((status: KanbanStatus) => {
    setDropTarget(status);
  }, []);

  /**
   * The dragged id comes from the event, not from state.
   *
   * `dragstart` writes it to `dataTransfer` — it has to, or Firefox refuses
   * to start the drag at all — and reading it back from there is the only
   * source that is correct at drop time. React state is not: a drop that
   * lands before the `dragstart` re-render, or after any re-render resets
   * it, sees `null` and the card silently stays where it was. That is what
   * "it only moves after I reload" looked like — nothing was ever sent.
   */
  const handleDropColumn = React.useCallback(
    (status: KanbanStatus, dataTransfer: DataTransfer | null) => {
      const taskId = dataTransfer?.getData("text/plain") || draggingId;
      handleDragEnd();
      if (taskId) onMove?.(taskId, status);
    },
    [draggingId, handleDragEnd, onMove],
  );

  return (
    <div className="kb-board">
      <div className="kb-selectall">
        <button
          className="btn btn-sm btn-link"
          disabled={!totalCards}
          onClick={() => onSelectMany?.(columns.flatMap((c) => c.tasks.map((t) => t.id)))}
          type="button"
        >
          Select all {totalCards}
        </button>
        <button
          className="btn btn-sm btn-link"
          disabled={!totalCards}
          onClick={() => onSelectMany?.([])}
          type="button"
        >
          Clear
        </button>
      </div>

      <div className="kb-rail">
        {columns.map((column, columnIndex) => {
          // Reading order is column-major, so a column's first card's index is
          // the total of every card before it. Computed here rather than
          // passed in, so it cannot drift out of step with the render.
          const orderOffset = columns
            .slice(0, columnIndex)
            .reduce((sum, c) => sum + c.tasks.length, 0);
          return (
          <KanbanColumnView
            column={column}
            onSelectColumn={(ids) => onSelectMany?.(ids)}
            orderOffset={orderOffset}
            selectedIds={selectedIds ?? EMPTY_SET}
            onSelectTask={onSelectTask ?? noopSelect}
            draggingId={draggingId}
            dropTarget={dropTarget}
            key={column.name}
            onDragEnd={handleDragEnd}
            onDragStart={handleDragStart}
            onDragOverColumn={handleDragOverColumn}
            now={now}
            onDropColumn={handleDropColumn}
            onOpenTask={onOpenTask}
            onCreateCard={onCreateCard}
          />
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mock data — used by the design preview route only                    */
/* ------------------------------------------------------------------ */

const now = Math.floor(Date.now() / 1000);

/**
 * Mock cards for `/kanban-next`, in the server's own shape.
 *
 * Replaced in #4 by the real `GET /board`. Until then the board has to
 * compile against a type the server actually honours, otherwise the port
 * would be developed against a fiction and every field would have to be
 * re-checked at the moment the data is wired up.
 *
 * `mockCard` fills all 44 fields so a card only declares what it varies —
 * and so that adding a field to `KanbanTaskCard` breaks this factory rather
 * than quietly producing cards that miss it.
 */
function mockCard(
  id: string,
  status: KanbanStatus,
  title: string,
  extra: Partial<KanbanTaskCard> & { ageSeconds?: number } = {},
): KanbanTaskCard {
  const { ageSeconds = 3_600, ...rest } = extra;
  return {
    id,
    title,
    body: null,
    status,
    assignee: null,
    created_by: "dashboard",
    tenant: null,
    project_id: null,
    priority: 0,
    created_at: now - ageSeconds,
    started_at: status === "running" ? now - ageSeconds : null,
    completed_at: status === "done" ? now - 60 : null,
    claim_lock: null,
    claim_expires: null,
    workspace_kind: "scratch",
    workspace_path: null,
    skills: null,
    model_override: null,
    provider_override: null,
    reasoning_effort: null,
    max_runtime_seconds: null,
    max_retries: null,
    goal_mode: false,
    goal_max_turns: null,
    worker_pid: null,
    last_heartbeat_at: null,
    current_run_id: null,
    session_id: null,
    branch_name: null,
    workflow_template_id: null,
    current_step_key: null,
    completion_contract: "",
    consecutive_failures: 0,
    last_failure_error: null,
    block_kind: null,
    block_recurrences: 0,
    result: null,
    idempotency_key: null,
    age: {
      created_age_seconds: ageSeconds,
      started_age_seconds: status === "running" ? ageSeconds : null,
      time_to_complete_seconds: status === "done" ? ageSeconds : null,
    },
    latest_summary: null,
    current_run_started_at: null,
    link_counts: { parents: 0, children: 0 },
    comment_count: 0,
    progress: null,
    ...rest,
  };
}

export const MOCK_COLUMNS: KanbanColumn[] = [
  {
    name: "triage",
    tasks: [
      mockCard("T-1041", "triage", "Investigate 502s on /api/plugins/kanban/board", {
        assignee: "grokwin",
        skills: ["bug", "backend"],
        comment_count: 3,
        priority: 3,
        ageSeconds: 1_200,
      }),
      mockCard("T-1042", "triage", "User report: kanban board empty after restart", {
        skills: ["bug"],
        comment_count: 1,
        ageSeconds: 3_600,
      }),
    ],
  },
  {
    name: "todo",
    tasks: [
      mockCard("T-1035", "todo", "Port kanban board to TSX in web/src", {
        assignee: "grokwin",
        skills: ["frontend", "refactor"],
        progress: { done: 2, total: 5 },
        comment_count: 5,
        priority: 1,
        ageSeconds: 7_200,
      }),
      mockCard("T-1036", "todo", "Migrate remaining dashboard pages to Bootstrap 5", {
        assignee: "imoney",
        skills: ["frontend"],
        progress: { done: 1, total: 23 },
        comment_count: 2,
        priority: 2,
        ageSeconds: 86_400,
      }),
      mockCard("T-1037", "todo", "Add WIP limits per column", {
        skills: ["ux"],
        ageSeconds: 172_800,
      }),
    ],
  },
  {
    name: "ready",
    tasks: [
      mockCard("T-1030", "ready", "Trello-style card shadows and hover states", {
        assignee: "grokwin",
        skills: ["design"],
        progress: { done: 3, total: 4 },
        comment_count: 4,
        ageSeconds: 900,
      }),
    ],
  },
  {
    name: "running",
    tasks: [
      mockCard("T-1028", "running", "Bootstrap theme: dark palette on --bs-* tokens", {
        assignee: "grokwin",
        skills: ["design", "frontend"],
        latest_summary:
          "Tokens applied; verifying focus ring contrast against the teal primary.",
        progress: { done: 5, total: 6 },
        comment_count: 7,
        ageSeconds: 60,
      }),
      mockCard("T-1029", "running", "Modal focus trap without Radix", {
        assignee: "grokwin",
        skills: ["frontend", "a11y"],
        latest_summary:
          "Escape, scroll lock and focus return implemented; Tab trap under test.",
        comment_count: 2,
        ageSeconds: 240,
      }),
      mockCard("T-1024", "running", "Session token forwarding for preview build", {
        assignee: "imoney",
        skills: ["infra"],
        latest_summary: "Preview proxy added; 9119 login blocks protected endpoints.",
        ageSeconds: 400,
      }),
    ],
  },
  {
    name: "blocked",
    tasks: [
      mockCard("T-1015", "blocked", "Expose preview to the public without auth", {
        assignee: "martin",
        skills: ["infra", "security"],
        // A blocked card is a server diagnosis, not free text the board
        // invents. On the real payload this arrives as `diagnostics`.
        diagnostics: [
          {
            kind: "auth_required",
            severity: "error",
            title: "Needs a dashboard session token or a dedicated read-only account.",
            detail: "The preview proxy rejects unauthenticated requests.",
            actions: [],
            first_seen_at: now - 5_400,
            last_seen_at: now - 5_400,
            count: 1,
            run_id: null,
            data: {},
          },
        ],
        comment_count: 6,
        priority: 1,
        ageSeconds: 5_400,
      }),
    ],
  },
  {
    name: "review",
    tasks: [
      mockCard("T-1010", "review", "FilesPage migration to Bootstrap layer", {
        assignee: "grokwin",
        skills: ["frontend"],
        latest_summary: "Ten DS imports collapsed to one @/ui import; tsc and vite build green.",
        progress: { done: 4, total: 4 },
        comment_count: 3,
        ageSeconds: 800,
      }),
    ],
  },
  {
    name: "done",
    tasks: [
      mockCard("T-1005", "done", "Add Bootstrap 5.3.8 as the UI foundation", {
        assignee: "grokwin",
        skills: ["build"],
        progress: { done: 1, total: 1 },
        ageSeconds: 2 * 86_400,
      }),
      mockCard("T-1006", "done", "Clone repo and audit the dashboard architecture", {
        assignee: "grokwin",
        ageSeconds: 3 * 86_400,
      }),
    ],
  },
];
