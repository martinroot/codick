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
import { cn } from "@/lib/utils";
import "./kanban.css";

export type KanbanStatus =
  | "triage"
  | "todo"
  | "scheduled"
  | "ready"
  | "running"
  | "blocked"
  | "review"
  | "done";

export interface KanbanTask {
  id: string;
  title: string;
  status: KanbanStatus;
  assignee?: string;
  labels?: string[];
  commentCount?: number;
  attachmentCount?: number;
  checklistDone?: number;
  checklistTotal?: number;
  priority?: number;
  /** Epoch seconds; rendered as an age badge. */
  updatedAt?: number;
  dueAt?: number;
  blockedReason?: string;
  runSummary?: string;
}

export interface KanbanColumn {
  name: KanbanStatus;
  tasks: KanbanTask[];
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

function timeAgo(epochSeconds: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}

function dueLabel(epochSeconds: number): { text: string; overdue: boolean } {
  const delta = epochSeconds * 1000 - Date.now();
  const days = Math.ceil(delta / 86_400_000);
  if (days < 0) return { text: `${Math.abs(days)}d late`, overdue: true };
  if (days === 0) return { text: "today", overdue: false };
  if (days === 1) return { text: "tomorrow", overdue: false };
  return { text: `${days}d`, overdue: false };
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
  const due = task.dueAt ? dueLabel(task.dueAt) : null;

  return (
    <article
      className={cn("kb-card", dragging && "kb-card-dragging")}
      draggable
      onDragEnd={onDragEnd}
      onDragStart={(event) => onDragStart(event, task)}
      onClick={() => onOpen?.(task)}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === "  ") {
          event.preventDefault();
          onOpen?.(task);
        }
      }}
    >
      {task.labels?.length ? (
        <div className="kb-card-labels">
          {task.labels.map((label) => (
            <span className="kb-label" key={label}>
              {label}
            </span>
          ))}
        </div>
      ) : null}

      <h3 className="kb-card-title">{task.title}</h3>

      {task.runSummary ? <p className="kb-card-summary">{task.runSummary}</p> : null}

      {task.blockedReason ? (
        <p className="kb-card-blocked" role="note">
          {task.blockedReason}
        </p>
      ) : null}

      <div className="kb-card-meta">
        {task.checklistTotal ? (
          <span
            className={cn(
              "kb-chip",
              task.checklistDone === task.checklistTotal && "kb-chip-done",
            )}
          >
            <span aria-hidden>☑</span>
            {task.checklistDone}/{task.checklistTotal}
          </span>
        ) : null}

        {task.commentCount ? (
          <span className="kb-chip">
            <span aria-hidden>💬</span>
            {task.commentCount}
          </span>
        ) : null}

        {task.attachmentCount ? (
          <span className="kb-chip">
            <span aria-hidden>📎</span>
            {task.attachmentCount}
          </span>
        ) : null}

        {task.priority ? <span className="kb-chip kb-chip-priority">P{task.priority}</span> : null}

        {due ? (
          <span className={cn("kb-chip", due.overdue && "kb-chip-overdue")}>
            <span aria-hidden>🕐</span>
            {due.text}
          </span>
        ) : null}

        <span className="kb-card-spacer" />

        {task.updatedAt ? <span className="kb-age">{timeAgo(task.updatedAt)}</span> : null}

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
  const [scrolled, setScrolled] = React.useState(false);
  const railRef = React.useRef<HTMLDivElement | null>(null);

  // The left edge-fade is a lie when the rail is already at the start, so
  // track it rather than painting it unconditionally.
  const syncScrolled = React.useCallback(() => {
    const rail = railRef.current;
    if (rail) setScrolled(rail.scrollLeft > 2);
  }, []);

  React.useEffect(syncScrolled, [syncScrolled]);

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
    <div className="kb-board" data-scrolled={scrolled}>
      <div className="kb-rail" onScroll={syncScrolled} ref={railRef}>
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
const day = 86_400;

export const MOCK_COLUMNS: KanbanColumn[] = [
  {
    name: "triage",
    tasks: [
      {
        id: "T-1041",
        title: "Investigate 502s on /api/plugins/kanban/board",
        status: "triage",
        assignee: "grokwin",
        labels: ["bug", "backend"],
        commentCount: 3,
        priority: 3,
        updatedAt: now - 1_200,
      },
      {
        id: "T-1042",
        title: "User report: kanban board empty after restart",
        status: "triage",
        labels: ["bug"],
        commentCount: 1,
        updatedAt: now - 3_600,
      },
    ],
  },
  {
    name: "todo",
    tasks: [
      {
        id: "T-1035",
        title: "Port kanban board to TSX in web/src",
        status: "todo",
        assignee: "grokwin",
        labels: ["frontend", "refactor"],
        checklistDone: 2,
        checklistTotal: 5,
        commentCount: 5,
        attachmentCount: 1,
        priority: 1,
        dueAt: now + 2 * day,
        updatedAt: now - 7_200,
      },
      {
        id: "T-1036",
        title: "Migrate remaining dashboard pages to Bootstrap 5",
        status: "todo",
        assignee: "imoney",
        labels: ["frontend"],
        checklistDone: 1,
        checklistTotal: 23,
        commentCount: 2,
        priority: 2,
        updatedAt: now - 86_400,
      },
      {
        id: "T-1037",
        title: "Add WIP limits per column",
        status: "todo",
        labels: ["ux"],
        updatedAt: now - 172_800,
      },
    ],
  },
  {
    name: "ready",
    tasks: [
      {
        id: "T-1030",
        title: "Trello-style card shadows and hover states",
        status: "ready",
        assignee: "grokwin",
        labels: ["design"],
        checklistDone: 3,
        checklistTotal: 4,
        commentCount: 4,
        dueAt: now + day,
        updatedAt: now - 900,
      },
    ],
  },
  {
    name: "running",
    tasks: [
      {
        id: "T-1028",
        title: "Bootstrap theme: dark palette on --bs-* tokens",
        status: "running",
        assignee: "grokwin",
        labels: ["design", "frontend"],
        runSummary: "Tokens applied; verifying focus ring contrast against the teal primary.",
        checklistDone: 5,
        checklistTotal: 6,
        commentCount: 7,
        updatedAt: now - 60,
      },
      {
        id: "T-1029",
        title: "Modal focus trap without Radix",
        status: "running",
        assignee: "grokwin",
        labels: ["frontend", "a11y"],
        runSummary: "Escape, scroll lock and focus return implemented; Tab trap under test.",
        commentCount: 2,
        updatedAt: now - 240,
      },
      {
        id: "T-1024",
        title: "Session token forwarding for preview build",
        status: "running",
        assignee: "imoney",
        labels: ["infra"],
        runSummary: "Preview proxy added; 9119 login blocks protected endpoints.",
        updatedAt: now - 400,
      },
    ],
  },
  {
    name: "blocked",
    tasks: [
      {
        id: "T-1015",
        title: "Expose preview to the public without auth",
        status: "blocked",
        assignee: "martin",
        labels: ["infra", "security"],
        blockedReason: "Needs a dashboard session token or a dedicated read-only account.",
        commentCount: 6,
        priority: 1,
        updatedAt: now - 5_400,
      },
    ],
  },
  {
    name: "review",
    tasks: [
      {
        id: "T-1010",
        title: "FilesPage migration to Bootstrap layer",
        status: "review",
        assignee: "grokwin",
        labels: ["frontend"],
        runSummary: "Ten DS imports collapsed to one @/ui import; tsc and vite build green.",
        checklistDone: 4,
        checklistTotal: 4,
        commentCount: 3,
        updatedAt: now - 800,
      },
    ],
  },
  {
    name: "done",
    tasks: [
      {
        id: "T-1005",
        title: "Add Bootstrap 5.3.8 as the UI foundation",
        status: "done",
        assignee: "grokwin",
        labels: ["build"],
        checklistDone: 1,
        checklistTotal: 1,
        updatedAt: now - 2 * day,
      },
      {
        id: "T-1006",
        title: "Clone repo and audit the dashboard architecture",
        status: "done",
        assignee: "grokwin",
        updatedAt: now - 3 * day,
      },
    ],
  },
];
