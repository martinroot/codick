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

const COLUMN_TITLES: Record<KanbanStatus, string> = {
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

const ACCENTS: Record<KanbanStatus, string> = {
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


/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

export interface KanbanCardProps {
  task: KanbanTask;
  dragging: boolean;
  onDragStart: (event: React.DragEvent<HTMLElement>, task: KanbanTask) => void;
  onDragEnd: () => void;
  onOpen?: (task: KanbanTask) => void;
}

function KanbanCardImpl({ task, dragging, onDragStart, onDragEnd, onOpen }: KanbanCardProps) {
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

  return (
    <article
      className={cn("kb-card", dragging && "kb-card-dragging")}
      draggable
      onDragEnd={onDragEnd}
      onDragStart={(event) => onDragStart(event, task)}
      onClick={() => onOpen?.(task)}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === "                                ") {
          event.preventDefault();
          onOpen?.(task);
        }
      }}
    >
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

        {task.diagnostics?.length ? (
          <span
            className={cn(
              "kb-chip",
              task.diagnostics.some((d) => d.severity !== "warning") && "kb-chip-overdue",
            )}
            title={task.diagnostics.map((d) => d.title).join("; ")}
          >
            <span aria-hidden>⚠</span>
            {task.diagnostics.length}
          </span>
        ) : null}

        <span className="kb-card-spacer" />

        {age !== null ? <span className="kb-age">{duration(age)}</span> : null}

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

/* ------------------------------------------------------------------ */
/* Column                                                              */
/* ------------------------------------------------------------------ */

export interface KanbanColumnProps {
  column: KanbanColumn;
  draggingId: string | null;
  dropTarget: KanbanStatus | null;
  onDragStart: (event: React.DragEvent<HTMLElement>, task: KanbanTask) => void;
  onDragEnd: () => void;
  onDragOverColumn: (status: KanbanStatus) => void;
  onDropColumn: (status: KanbanStatus) => void;
  onOpenTask?: (task: KanbanTask) => void;
}

function KanbanColumnView({
  column,
  draggingId,
  dropTarget,
  onDragStart,
  onDragEnd,
  onDragOverColumn,
  onDropColumn,
  onOpenTask,
}: KanbanColumnProps) {
  const isDropTarget = dropTarget === column.name;
  const wipExceeded = column.name === "running" && column.tasks.length > 4;

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
        onDropColumn(column.name);
      }}
    >
      <header className="kb-column-header">
        <span className="kb-dot" style={{ background: ACCENTS[column.name] }} aria-hidden />
        <h2 className="kb-column-title">{COLUMN_TITLES[column.name]}</h2>
        <span className={cn("kb-count", wipExceeded && "kb-count-over")}>{column.tasks.length}</span>
        <button className="kb-column-add" type="button" aria-label={`Add card to ${COLUMN_TITLES[column.name]}`}>
          +
        </button>
      </header>

      <div className="kb-column-body">
        {column.tasks.length === 0 ? (
          <p className="kb-empty">Drop cards here</p>
        ) : (
          column.tasks.map((task) => (
            <KanbanCard
              dragging={draggingId === task.id}
              key={task.id}
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
      <footer className="kb-column-footer">
        <button className="kb-add-card" type="button">
          <span aria-hidden>+</span>
          Add a card
        </button>
      </footer>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Board                                                               */
/* ------------------------------------------------------------------ */

export interface KanbanBoardProps {
  columns: KanbanColumn[];
  onMove?: (taskId: string, to: KanbanStatus) => void;
  onOpenTask?: (task: KanbanTask) => void;
}

export function KanbanBoard({ columns, onMove, onOpenTask }: KanbanBoardProps) {
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<KanbanStatus | null>(null);
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

  const handleDropColumn = React.useCallback(
    (status: KanbanStatus) => {
      const taskId = draggingId;
      handleDragEnd();
      if (taskId) onMove?.(taskId, status);
    },
    [draggingId, handleDragEnd, onMove],
  );

  return (
    <div className="kb-board">
      <div className="kb-rail">
        {columns.map((column) => (
          <KanbanColumnView
            column={column}
            draggingId={draggingId}
            dropTarget={dropTarget}
            key={column.name}
            onDragEnd={handleDragEnd}
            onDragStart={handleDragStart}
            onDragOverColumn={handleDragOverColumn}
            onDropColumn={handleDropColumn}
            onOpenTask={onOpenTask}
          />
        ))}
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
