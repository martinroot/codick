/**
 * The kanban desk's main board — `Kanban Desk → Main`.
 *
 * Reads the live `/api/kanban/board` payload and keeps it current from
 * the board's event stream. The board component itself is unchanged from the
 * prototype: it renders whatever columns it is given, which is why the wiring
 * could happen without touching it.
 *
 * ## The board slug
 *
 * Comes from `?board=<slug>`, defaulting to the server's own `current`
 * board and then to `default`. It is threaded into every call — never
 * omitted — because omitting it makes the server resolve a different board
 * than the one on screen.
 *
 * ## Moves are optimistic, and they can be refused
 *
 * A drag lands the card immediately and PATCHes after. Two server replies
 * are normal and must not look like breakage:
 *
 * - 409, when a task has unsatisfied dependencies. The detail names the
 *   blocking parents, and that sentence is what goes on screen — a card
 *   that snaps back with no reason reads as a bug in the board.
 * - 400, for a move into `running`. That column is not a drop target; a
 *   task reaches it by being dispatched. `SELECTABLE_STATUSES` is what the
 *   UI offers.
 */

import * as React from "react";
import { useSearchParams } from "react-router";

import { useKanbanEvents } from "@/components/kanban/useKanbanEvents";
import {
  KanbanBoard,
  COLUMN_TITLES,
  KANBAN_COLUMNS,
  type KanbanColumn,
  type KanbanStatus,
} from "@/components/kanban/KanbanBoard";
import {
  kanbanApi,
  type KanbanBoardSummary,
  type KanbanTaskCard,
} from "@/lib/kanban-api";
import { errorMessage } from "@/lib/api-error";
import { Button } from "@/ui";

type LoadState =
  | { phase: "loading" }
  | { phase: "ready" }
  | { phase: "error"; message: string };

export default function KanbanMainPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedBoard = searchParams.get("board");

  const [board, setBoard] = React.useState<string>(requestedBoard ?? "");
  const [boards, setBoards] = React.useState<KanbanBoardSummary[]>([]);
  const [columns, setColumns] = React.useState<KanbanColumn[]>([]);
  const [load, setLoad] = React.useState<LoadState>({ phase: "loading" });
  const [notice, setNotice] = React.useState<{ tone: string; text: string } | null>(null);

  // `board` is empty until /boards answers, so it is the dependency that
  // actually gates the fetch -- not the URL parameter, which may be absent.
  const options = React.useMemo(() => ({ board }), [board]);

  React.useEffect(() => {
    let cancelled = false;
    // Nothing to ask for yet: /boards is what tells us the current board.
    if (!board) return;
    (async () => {
      setLoad((s) => (s.phase === "ready" ? s : { phase: "loading" }));
      try {
        const payload = await kanbanApi.getBoard(options);
        if (cancelled) return;
        setColumns(payload.columns);
        setLoad({ phase: "ready" });
      } catch (err) {
        if (cancelled) return;
        setLoad({ phase: "error", message: errorMessage(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [board, options]);

  // Resolve the board list once, and adopt the server's `current` when the
  // URL says nothing. `/boards` takes no board parameter -- it is the one
  // endpoint in the API that is not board-scoped.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const payload = await kanbanApi.listBoards();
        if (cancelled) return;
        setBoards(payload.boards);
        if (!requestedBoard) {
          setBoard(payload.current ?? payload.boards[0]?.slug ?? "default");
        }
      } catch (err) {
        if (cancelled) return;
        // Failing to list boards is not fatal: fall back to `default` and let
        // the board fetch be the thing that reports a real problem.
        setBoard(requestedBoard ?? "default");
        setLoad({ phase: "error", message: errorMessage(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestedBoard]);

  // Resume cursor for the event stream. Seeded from the board payload, so a
  // first load connects from "now" and a reconnect resumes from the last event
  // this page actually saw -- without it, a tab closed for an hour comes back
  // silently missing everything that happened.
  const [eventCursor, setEventCursor] = React.useState<number | null>(null);

  const reload = React.useCallback(() => {
    if (!board) return;
    setLoad({ phase: "loading" });
    kanbanApi
      .getBoard(options)
      .then((payload) => {
        setColumns(payload.columns);
        setEventCursor(payload.latest_event_id);
        setLoad({ phase: "ready" });
      })
      .catch((err: unknown) => setLoad({ phase: "error", message: errorMessage(err) }));
  }, [board, options]);

  /**
   * Re-read the board without touching the loading phase.
   *
   * `reload` blanks the board, which is right for a user-initiated refresh
   * and wrong here: live updates arrive constantly, and a screen that drops
   * to a spinner between every event is worse than one that is a beat
   * behind. A failure here is also not worth a full-page error -- the next
   * event will try again, and blanking the board because a poll failed once
   * throws away state the user was looking at.
   */
  const refreshQuietly = React.useCallback(() => {
    if (!board) return;
    kanbanApi
      .getBoard(options)
      .then((payload) => {
        setColumns(payload.columns);
        setEventCursor(payload.latest_event_id);
      })
      .catch(() => {});
  }, [board, options]);

  // Live updates. Events are the signal, not the payload: the board is
  // re-read rather than patched, so a new event kind needs no frontend work
  // and a missed one cannot leave the screen quietly wrong. The debounce is
  // what keeps a burst -- a dispatcher moving five cards -- to one fetch.
  const liveRefresh = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleLiveRefresh = React.useCallback(() => {
    if (liveRefresh.current) return;
    liveRefresh.current = setTimeout(() => {
      liveRefresh.current = null;
      refreshQuietly();
    }, 250);
  }, [refreshQuietly]);
  React.useEffect(
    () => () => {
      if (liveRefresh.current) clearTimeout(liveRefresh.current);
    },
    [],
  );

  useKanbanEvents({
    board: board ?? "",
    since: eventCursor,
    onEvents: scheduleLiveRefresh,
    enabled: Boolean(board) && load.phase === "ready",
  });

  const handleMove = React.useCallback(
    (taskId: string, to: KanbanStatus) => {
      // Find the card before touching state, so the optimistic update is a
      // single pure transform rather than a search repeated inside a setter.
      const card = columns
        .flatMap((column) => column.tasks)
        .find((task) => task.id === taskId);
      if (!card) return;

      if (card.status === to) return;
      setColumns((previous) =>
        previous.map((column) => {
          const holds = column.tasks.some((task) => task.id === taskId);
          if (!holds) return column;
          const without = column.tasks.filter((task) => task.id !== taskId);
          return column.name === to
            ? { ...column, tasks: [...without, { ...card, status: to }] }
            : { ...column, tasks: without };
        }),
      );

      kanbanApi
        .patchTask(taskId, { status: to }, options)
        .then(async () => {
          // Re-read even on success. The optimistic position is a guess, and
          // the server is the authority: it can refuse a transition it
          // accepted at the HTTP layer, and it can move a task again within
          // the same instant a dispatcher picks it up. Without this the
          // screen shows where the card *was* dragged until something else
          // forces a reload.
          const payload = await kanbanApi.getBoard(options);
          setColumns(payload.columns);
          setNotice({ tone: "info", text: `Moved to ${COLUMN_TITLES[to]}` });
        })
        .catch((err: unknown) => {
          // A 409 names the blocking parents, and that sentence is the useful
          // thing to show -- "move failed" would not say why it snapped back.
          reload();
          setNotice({ tone: "danger", text: errorMessage(err) });
        });
    },
    [columns, options, reload],
  );

  /**
   * Creates a card, then re-reads the board.
   *
   * The obvious implementation — splice the response into the column it
   * names — does not work, and the failure is silent until a render throws:
   * `POST /tasks` returns the stored row (41 fields) while the board serves
   * enriched cards (44). `comment_count`, `link_counts` and `progress` are
   * only ever computed for the board endpoint, so the card renders with
   * `link_counts.children` on undefined.
   *
   * Re-reading is also the honest placement: the server files a new task by
   * its own rules, and `POST` with `triage` answers `ready`. Splicing would
   * put the card in the column that was asked for rather than the one it
   * landed in.
   */
  const handleCreateCard = React.useCallback(
    async (status: KanbanStatus, title: string): Promise<KanbanTaskCard> => {
      const { id } = await kanbanApi.createCardInStatus(status, title, options);
      const payload = await kanbanApi.getBoard(options);
      setColumns(payload.columns);
      const placed = payload.columns
        .flatMap((column) => column.tasks)
        .find((candidate) => candidate.id === id);
      setNotice({ tone: "success", text: `Added to ${COLUMN_TITLES[status]}` });
      if (!placed) {
        // The task exists but the board does not show it. Say so instead of
        // letting the composer look like it silently swallowed the title.
        setNotice({
          tone: "warning",
          text: `Created as ${id} but it is not on the board. Refresh to see where it went.`,
        });
        throw new Error("created task is missing from the board");
      }
      return placed;
    },
    [options],
  );

  const handleOpenTask = React.useCallback((task: KanbanTaskCard) => {
    setNotice({ tone: "info", text: `open ${task.id}` });
  }, []);

  const total = columns.reduce((sum, column) => sum + column.tasks.length, 0);
  const active = boards.find((b) => b.slug === board);

  return (
    <div className="d-flex flex-column gap-3">
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2">
        <div className="d-flex align-items-center gap-2">
          <h1 className="h4 mb-0">{active?.name ?? "Kanban Desk — Main"}</h1>
          <span className="badge text-bg-secondary">
            {total} cards · {KANBAN_COLUMNS.length} columns
          </span>
        </div>
        <div className="d-flex align-items-center gap-2">
          {boards.length > 1 ? (
            <select
              className="form-select form-select-sm w-auto"
              aria-label="Board"
              value={board}
              onChange={(event) => {
                setColumns([]);
                setBoard(event.target.value);
                // The slug lives in the URL so a reload, a link and the next
                // session all agree on which board is open.
                setSearchParams({ board: event.target.value });
              }}
            >
              {boards.map((b) => (
                <option key={b.slug} value={b.slug}>
                  {b.name}
                </option>
              ))}
            </select>
          ) : null}
          <Button outlined size="sm" onClick={reload}>
            Refresh
          </Button>
        </div>
      </div>

      {notice ? (
        <div
          className={`alert alert-${notice.tone} py-2 px-3 mb-0 small`}
          role="status"
          onClick={() => setNotice(null)}
        >
          {notice.text}
        </div>
      ) : null}

      {load.phase === "error" ? (
        <div className="alert alert-danger d-flex justify-content-between align-items-center" role="alert">
          <span>{load.message}</span>
          <Button outlined size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : null}

      {load.phase === "loading" ? (
        <p className="text-body-secondary small mb-0">Loading the board…</p>
      ) : null}

      {load.phase === "ready" && total === 0 ? (
        <p className="text-body-secondary small mb-0">
          This board is empty. Create a card with the + on a column, or check
          you are looking at the right board.
        </p>
      ) : null}

      <KanbanBoard
        columns={columns}
        onCreateCard={handleCreateCard}
        onMove={handleMove}
        onOpenTask={handleOpenTask}
      />
    </div>
  );
}
