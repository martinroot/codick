/**
 * The kanban desk's main board -- `Kanban Desk → Main`.
 *
 * Still renders against `MOCK_COLUMNS`, so it needs no API call and no
 * session token. The production board swaps `MOCK_COLUMNS` for the live
 * `/api/plugins/kanban/board` payload; nothing else about the component
 * changes, which is why this route could be filled in without touching
 * `KanbanBoard` itself.
 */

import * as React from "react";
import {
  KanbanBoard,
  KANBAN_COLUMNS,
  MOCK_COLUMNS,
  type KanbanColumn,
  type KanbanStatus,
  type KanbanTask,
} from "@/components/kanban/KanbanBoard";
import { Button } from "@/ui";

export default function KanbanMainPage() {
  const [columns, setColumns] = React.useState<KanbanColumn[]>(MOCK_COLUMNS);
  const [lastMove, setLastMove] = React.useState<string | null>(null);

  // Optimistic move: the card lands in its new column immediately, which
  // is what makes the board feel instant. The real page will PATCH here
  // and roll back on failure.
  const handleMove = React.useCallback((taskId: string, to: KanbanStatus) => {
    setColumns((previous) => {
      let moved: KanbanTask | undefined;
      const stripped = previous.map((column) => {
        const found = column.tasks.find((task) => task.id === taskId);
        if (!found) return column;
        moved = found;
        return { ...column, tasks: column.tasks.filter((task) => task.id !== taskId) };
      });
      if (!moved) return previous;
      return stripped.map((column) =>
        column.name === to
          ? { ...column, tasks: [...column.tasks, { ...moved!, status: to }] }
          : column,
      );
    });
    setLastMove(`${taskId} → ${to}`);
    window.setTimeout(() => setLastMove(null), 2000);
  }, []);

  const handleOpenTask = React.useCallback((task: KanbanTask) => {
    // The drawer is the next piece; the click target is wired so the
    // affordance is testable now.
    setLastMove(`open ${task.id}`);
    window.setTimeout(() => setLastMove(null), 2000);
  }, []);

  const total = columns.reduce((sum, column) => sum + column.tasks.length, 0);

  return (
    <div className="d-flex flex-column gap-3">
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2">
        <div className="d-flex align-items-center gap-2">
          <h1 className="h4 mb-0">Kanban Desk — Main</h1>
          <span className="badge text-bg-secondary">
            {total} cards · {KANBAN_COLUMNS.length} columns
          </span>
        </div>
        <div className="d-flex align-items-center gap-2">
          {lastMove ? <span className="badge text-bg-info">{lastMove}</span> : null}
          <Button outlined size="sm" onClick={() => setColumns(MOCK_COLUMNS)}>
            Reset
          </Button>
        </div>
      </div>

      <p className="text-body-secondary small mb-0">
        Drag a card between columns. Click a card to open it.
      </p>

      <KanbanBoard columns={columns} onMove={handleMove} onOpenTask={handleOpenTask} />
    </div>
  );
}
