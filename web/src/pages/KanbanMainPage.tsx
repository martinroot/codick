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

import { AttentionStrip } from "@/components/kanban/AttentionStrip";
import { ConfirmDialog } from "@/components/kanban/ConfirmDialog";
import { PipelinePanel } from "@/components/kanban/pipeline/PipelinePanel";
import PipelineDesigner from "@/pages/pipeline/PipelineDesigner";
import { CreateTaskDialog } from "@/components/kanban/CreateTaskDialog";
import {
  BulkActionBar,
  type BulkAction,
  type BulkOutcome,
} from "@/components/kanban/BulkActionBar";
import { TaskDrawer } from "@/components/kanban/TaskDrawer";
import { readingOrder, useCardSelection } from "@/components/kanban/useCardSelection";
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
  type KanbanCreateTask,
  type KanbanTaskCard,
} from "@/lib/kanban-api";
import { errorMessage } from "@/lib/api-error";
import { Button } from "@/ui";

type LoadState =
  | { phase: "loading" }
  | { phase: "ready" }
  | { phase: "error"; message: string };

/**
 * What a move to `done` must carry to satisfy `kanban_db.complete_task`.
 *
 * A single string, not a bag of options: the server treats `result` and
 * `summary` interchangeably as evidence, so making the caller decide which to
 * send would be inventing a distinction it does not make.
 */
interface CompletionEvidence {
  summary: string;
}

/**
 * Whether a card can be completed without asking for a summary.
 *
 * Mirrors `kanban_db.complete_task`: a stored result or an existing summary is
 * evidence. Anything already recorded counts, because re-typing what the card
 * already says is the failure mode this is meant to avoid.
 *
 * `review` counts as evidenced. Measured against the live server: a `done`
 * transition out of `review` is **not** refused, because approving a card is
 * the human being the record. Asking for a summary there would be inventing a
 * requirement the backend deliberately does not have.
 *
 * Note this is a *pre-filter*, not the contract. The server is still the one
 * that decides — it also knows about `created_cards`, which this side cannot
 * see, and its refusal sentence is the one worth showing. The pre-filter
 * exists so the common case never opens a dialog it does not need.
 */
function hasCompletionEvidence(card: KanbanTaskCard): boolean {
  if (card.status === "review") return true;
  return Boolean(card.result?.trim() || card.latest_summary?.trim());
}

export default function KanbanMainPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedBoard = searchParams.get("board");

  const [board, setBoard] = React.useState<string>(requestedBoard ?? "");
  const [boards, setBoards] = React.useState<KanbanBoardSummary[]>([]);
  const [columns, setColumns] = React.useState<KanbanColumn[]>([]);
  /**
   * The server's clock, as of the last board read. Cards measure staleness
   * against this rather than the browser's clock: the ages the server reports
   * and the tint the board draws then agree, and a laptop with a wrong time
   * does not make every card look wedged.
   */
  const [serverNow, setServerNow] = React.useState<number | null>(null);
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
      setServerNow(payload.now ?? null);
        setServerNow(payload.now ?? null);
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
        setServerNow(payload.now ?? null);
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
      setServerNow(payload.now ?? null);
        setServerNow(payload.now ?? null);
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
    async (taskId: string, to: KanbanStatus, evidence?: CompletionEvidence) => {
      // Find the card before touching state, so the optimistic update is a
      // single pure transform rather than a search repeated inside a setter.
      const card = columns
        .flatMap((column) => column.tasks)
        .find((task) => task.id === taskId);
      if (!card) return;

      if (card.status === to) return;

      // Spec section 9: the executor owns a pipeline card's column. The server
      // refuses the write; catching it here saves the round trip and, unlike
      // the refusal, says "pipeline" in a sentence the drag context makes
      // sense of. The optimistic update below must never run for one.
      if (card.pipeline) {
        setNotice({
          tone: "warning",
          text: `"${card.title}" is a pipeline card — its column is owned by the pipeline executor and cannot be moved manually.`,
        });
        return;
      }

      if (to === "done" && !hasCompletionEvidence(card)) {
        setCompletionAsk({ task: card, to });
        return;
      }
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

      await kanbanApi
        .patchTask(
          taskId,
          // `summary` is sent as `result` too. The server treats either as
          // evidence, but the board reads `latest_summary` for its summary
          // column, so writing only one leaves the card looking unfinished
          // after it is done.
          evidence?.summary
            ? { status: to, result: evidence.summary, summary: evidence.summary }
            : { status: to },
          options,
        )
        .then(async () => {
          // Re-read even on success. The optimistic position is a guess, and
          // the server is the authority: it can refuse a transition it
          // accepted at the HTTP layer, and it can move a task again within
          // the same instant a dispatcher picks it up. Without this the
          // screen shows where the card *was* dragged until something else
          // forces a reload.
          const payload = await kanbanApi.getBoard(options);
          setColumns(payload.columns);
          setServerNow(payload.now ?? null);
          setNotice({ tone: "info", text: `Moved to ${COLUMN_TITLES[to]}` });
        })
        .catch((err: unknown) => {
          // A 409 names the blocking parents, and a 400 on `done` names the
          // missing evidence. That sentence is the useful thing to show --
          // "move failed" would not say why it snapped back.
          reload();
          const message = errorMessage(err);
          setNotice({ tone: "danger", text: message });
          throw err;
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
  /**
   * The full create form. `null` when closed; a `KanbanStatus` when it was
   * opened from a column, because "file as" and the create path's two honoured
   * initial states both start there.
   */
  const [createAsk, setCreateAsk] = React.useState<KanbanStatus | null | undefined>(undefined);

  const submitCreate = React.useCallback(
    async (task: KanbanCreateTask) => {
      const { task: created } = await kanbanApi.createTask(task, options);
      const id = created.id;
      // `POST /tasks` answers with a 41-field task row; the board card is 44
      // fields. The row is not a card, so the board is re-read rather than
      // patched from the response — a create that shows a card missing its
      // signals would be worse than one that takes a moment longer.
      const payload = await kanbanApi.getBoard(options);
      setColumns(payload.columns);
      setServerNow(payload.now ?? null);
      const placed = payload.columns
        .flatMap((column) => column.tasks)
        .find((candidate) => candidate.id === id);
      setCreateAsk(undefined);
      if (!placed) {
        setNotice({
          tone: "warning",
          text: `Created as ${id} but it is not on the board. Refresh to see where it went.`,
        });
        return;
      }
      setNotice({
        tone: "success",
        text: `Added to ${COLUMN_TITLES[placed.status]}`,
      });
    },
    [options],
  );

  const handleCreateCard = React.useCallback(
    async (status: KanbanStatus, title: string): Promise<KanbanTaskCard> => {
      const { id } = await kanbanApi.createCardInStatus(status, title, options);
      const payload = await kanbanApi.getBoard(options);
      setColumns(payload.columns);
      setServerNow(payload.now ?? null);
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

  // The drawer. Its id rather than the whole card, because the card is a
  // 44-field board row and the drawer re-reads the full task anyway -- holding
  // the row would only risk showing board data in a pane that is meant to be
  // the detail.
  const [openTaskId, setOpenTaskId] = React.useState<string | null>(null);

  // --- Completion contract --------------------------------------------
  //
  // A move to `done` without evidence becomes a question rather than a
  // request. Held here rather than inside the board so that a drag, a bulk
  // "Complete" and any future entry point all meet the same gate.
  const [completionAsk, setCompletionAsk] = React.useState<{
    task: KanbanTaskCard;
    to: KanbanStatus;
  } | null>(null);
  const [completionSummary, setCompletionSummary] = React.useState("");
  const [completionBusy, setCompletionBusy] = React.useState(false);
  const [completionError, setCompletionError] = React.useState<string | null>(null);

  // The bulk variant of the same question. `ids` is the whole selection and
  // `bare` the subset with no evidence — both are needed, because the summary
  // is written to all of them while only some actually required one.
  /**
   * A destructive action waiting to be confirmed, with the cards it covers.
   * Held as cards, not ids: the confirm has to name what is being destroyed,
   * and a count taken from a live selection can change between asking and
   * answering.
   */
  const [destructive, setDestructive] = React.useState<{
    action: BulkAction;
    cards: KanbanTaskCard[];
  } | null>(null);

  const [bulkCompletion, setBulkCompletion] = React.useState<{
    pending: BulkAction;
    ids: string[];
    bare: KanbanTaskCard[];
    /** The card's title, when the selection is a single card worth naming. */
    label: string | null;
  } | null>(null);
  /** Set by a diagnostic's `comment` action to open the drawer on Comments. */
  const [commentFocus, setCommentFocus] = React.useState<{
    taskId: string;
    at: number;
  } | null>(null);
  // ------------------------------------------------------------- selection

  const selection = useCardSelection();
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [bulkOutcome, setBulkOutcome] = React.useState<BulkOutcome | null>(null);

  /**
   * Reading order is taken from the same array the board renders, or a
   * shift-range would be measured against a different list than the one the
   * user clicked in. Recomputed per render and passed down with the index.
   */
  const order = React.useMemo(
    () => readingOrder(columns),
    [columns],
  );

  /**
   * A card that leaves the board must not stay selected: the action bar would
   * then keep offering to act on ids the server no longer has, and the bulk
   * call would spend its errors on "not found".
   */
  React.useEffect(() => {
    const present = new Set(order);
    if (![...selection.selected].some((id) => !present.has(id))) return;
    const next = new Set([...selection.selected].filter((id) => present.has(id)));
    if (next.size !== selection.selected.size) selection.setSelected(next);
  }, [order, selection]);

  const handleSelectTask = React.useCallback(
    (
      task: KanbanTaskCard,
      modifiers: { toggle: boolean; range: boolean },
      index: number,
    ) => {
      setBulkOutcome(null);
      if (modifiers.range) selection.extendTo(order, index);
      else if (modifiers.toggle) selection.toggle(task.id, index);
      // A plain click falls through to the drawer, which the board calls
      // directly -- selecting on every click would make opening a card
      // impossible.
    },
    [order, selection],
  );

  const handleBulk = React.useCallback(
    async (
      action: BulkAction,
      evidence?: CompletionEvidence,
      /**
       * The exact ids to act on. Set only by the destructive confirm, which
       * already decided what it is destroying. Going through
       * `selection.setSelected` and reading it back on the next line does not
       * work: React has not applied the state yet, so `handleBulk` sees the
       * selection as it was *after* a concurrent refetch pruned it — the
       * confirm would then delete fewer cards than the one it described, with
       * no refusal to show for it.
       */
      confirmedIds?: string[],
    ) => {
      const ids = confirmedIds ?? [...selection.selected];
      if (!ids.length || bulkBusy) return;

      // The same contract, on the path that bypasses `handleMove`. A bulk
      // "Complete" over cards with no evidence must ask for a summary, and one
      // summary covers the batch — asking per card would be a dialog storm,
      // and asking not at all is how cards get completed with nothing recorded.
      // `!evidence` is load-bearing. Without it the dialog's own confirm
      // re-enters this function, the gate fires a second time on the very
      // summary it just collected, the dialog reopens, and the call returns
      // having sent nothing — a completion that silently does not happen.
      if (action.kind === "status" && action.status === "done" && !evidence) {
        const selected = columns
          .flatMap((column) => column.tasks)
          .filter((task) => selection.selected.has(task.id));
        const bare = selected.filter((task) => !hasCompletionEvidence(task));
        if (bare.length) {
          setBulkCompletion({
          pending: action,
          ids,
          bare,
          // A confirmation that does not say what it is confirming is a
          // confirmation nobody should click.
          label:
            ids.length === 1
              ? (bare[0]?.title ??
                columns.flatMap((c) => c.tasks).find((t) => t.id === ids[0])?.title ??
                null)
              : null,
        });
          return;
        }
      }
      // Delete and archive both need a name and a count before they happen.
      // Ask first, act second. `confirmedIds` being present is what the
      // confirm hands back, and it is the only thing that lets the second
      // entry fall through to the work.
      if (
        (action.kind === "delete" || action.kind === "archive") &&
        !confirmedIds
      ) {
        setDestructive({
          action,
          cards: columns
            .flatMap((column) => column.tasks)
            .filter((task) => selection.selected.has(task.id)),
        });
        return;
      }
      setBulkBusy(true);
      setBulkOutcome(null);
      try {
        // There is no bulk delete endpoint. `POST /tasks/bulk` knows how to set
        // a status, a priority and `archive`, and that is the end of it — so
        // delete walks the ids itself, one DELETE per card, and reconciles per
        // card exactly like the endpoint's own per-card results. A single
        // "deleted 12 cards" over 11 successes would be a lie the board then
        // contradicts.
        if (action.kind === "delete") {
          const results = await Promise.all(
            ids.map(async (id) => {
              try {
                await kanbanApi.deleteTask(id, options);
                return { id, ok: true };
              } catch (error) {
                return {
                  id,
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                };
              }
            }),
          );
          const outcome = reconcile(ids, results);
          setBulkOutcome(outcome);
          setDestructive(null);
          /*
           * The bar cannot carry this report. It renders only while something
           * is selected, and the one refusal a delete can produce is "that card
           * is gone" — which is precisely what empties the selection and
           * unmounts the bar. So a per-card outcome for delete goes to the
           * page notice, which does not depend on the selection surviving.
           */
          if (outcome.failures.length) {
            setNotice({
              tone: "warning",
              text:
                `Deleted ${outcome.succeeded} of ${outcome.requested} — ` +
                `${outcome.failures.length} already gone: ` +
                outcome.failures.map((f) => `${f.id} (${f.error})`).join("; "),
            });
          } else {
            setNotice({
              tone: "success",
              text: `Deleted ${outcome.succeeded} card${outcome.succeeded === 1 ? "" : "s"}. This cannot be undone.`,
            });
          }
          await reload();
          return;
        }
        const body =
          action.kind === "status"
            ? evidence?.summary
              ? // The bulk body takes one `result`/`summary` for the whole
                // batch, so a single written summary is spread across every
                // selected card. The alternative — a per-card dialog — is a
                // dialog storm, and leaving them unevidenced is the bug.
                { ids, status: action.status, result: evidence.summary, summary: evidence.summary }
              : { ids, status: action.status }
            : action.kind === "priority"
              ? { ids, priority: action.priority }
              : { ids, archive: true };
        const data = await kanbanApi.bulkUpdate(body, options);
        // Per card, never as one verdict. The server stops at nothing, so a
        // single "updated N cards" would report success over a batch that was
        // partly refused -- and the refusals are the interesting part.
        const results = data?.results ?? [];
        const failures = results
          .filter((entry) => !entry.ok)
          .map((entry) => ({ id: entry.id, error: entry.error ?? "refused" }));
        setBulkOutcome({
          requested: ids.length,
          succeeded: results.filter((entry) => entry.ok).length,
          failures,
        });
        // Anything the server did not mention at all did not happen, and those
        // cards stay selected so the next attempt is not guesswork.
        const reported = new Set(results.map((entry) => entry.id));
        const succeeded = results.filter((entry) => entry.ok).map((entry) => entry.id);
        selection.setSelected(succeeded.concat([...selection.selected].filter((id) => !reported.has(id))));
        // A quiet read: `reload` would flip the board into its loading phase
        // between the write and the cards repainting, which reads as a
        // flicker. This is the same re-read handleCreateCard uses.
        const payload = await kanbanApi.getBoard(options);
        setColumns(payload.columns);
        setServerNow(payload.now ?? null);
        setEventCursor(payload.latest_event_id);
      } catch (error) {
        setBulkOutcome({
          requested: ids.length,
          succeeded: 0,
          failures: ids.map((id) => ({ id, error: errorMessage(error) })),
        });
      } finally {
        setBulkBusy(false);
      }
    },
    [bulkBusy, options, selection],
  );

  const handleOpenTask = React.useCallback((task: KanbanTaskCard) => {
    setOpenTaskId(task.id);
  }, []);

  const reconcile = React.useCallback(
    (ids: string[], results: { id: string; ok: boolean; error?: string }[]) => {
      const failed = results.filter((r) => !r.ok);
      const next = new Set(
        selection.selected,
      );
      for (const r of results) {
        if (r.ok) next.delete(r.id);
        else next.add(r.id);
      }
      selection.setSelected(next);
      return {
        requested: ids.length,
        succeeded: results.filter((r) => r.ok).length,
        failures: failed.map((r) => ({ id: r.id, error: r.error ?? "refused" })),
      };
    },
    [selection],
  );

  /**
   * What deleting this selection would do beyond destroying the cards: kill a
   * worker, and release other people's dependent work. Read off the cards the
   * confirm is holding, not off a live lookup, so the warning cannot describe
   * a different set than the one being confirmed.
   */
  const riskyDelete = React.useMemo(() => {
    const cards = destructive?.cards ?? [];
    return {
      running: cards.filter((c) => c.status === "running").length,
      // `link_counts.children` is on the board card — `/board` computes it
      // from `task_links`, so no extra fetch and the count cannot describe a
      // different set than the one being confirmed. A detail-shaped card
      // carries `link_tasks` instead, so read that when it is all there is.
      children: cards.reduce(
        (sum, c) =>
          sum + (c.link_counts?.children ?? (c as { link_tasks?: { children?: unknown[] } }).link_tasks?.children?.length ?? 0),
        0,
      ),
    };
  }, [destructive]);

  const closeDestructive = React.useCallback(() => {
    setDestructive(null);
    setCompletionError(null);
    setCompletionBusy(false);
  }, []);

  const confirmDestructive = React.useCallback(async () => {
    if (!destructive) return;
    // Hand the held cards back as explicit ids, so the second entry into
    // `handleBulk` walks exactly what the confirm described — including a card
    // that has since vanished, which is the one that must come back refused.
    await handleBulk(
      destructive.action,
      undefined,
      destructive.cards.map((c) => c.id),
    );
    closeDestructive();
  }, [closeDestructive, destructive, handleBulk, selection]);

  const closeBulkCompletion = React.useCallback(() => {
    setBulkCompletion(null);
    setCompletionSummary("");
    setCompletionError(null);
    setCompletionBusy(false);
  }, []);

  const confirmBulkCompletion = React.useCallback(async () => {
    if (!bulkCompletion) return;
    const summary = completionSummary.trim();
    if (!summary) return;
    setCompletionBusy(true);
    setCompletionError(null);
    try {
      await handleBulk(bulkCompletion.pending, { summary });
      closeBulkCompletion();
    } catch (error) {
      setCompletionError(error instanceof Error ? error.message : String(error));
    } finally {
      setCompletionBusy(false);
    }
  }, [bulkCompletion, closeBulkCompletion, completionSummary, handleBulk]);

  const closeCompletion = React.useCallback(() => {
    setCompletionAsk(null);
    setCompletionSummary("");
    setCompletionError(null);
    setCompletionBusy(false);
  }, []);

  const confirmCompletion = React.useCallback(async () => {
    if (!completionAsk) return;
    const summary = completionSummary.trim();
    if (!summary) return;
    setCompletionBusy(true);
    setCompletionError(null);
    const { task, to } = completionAsk;
    try {
      await handleMove(task.id, to, { summary });
      closeCompletion();
    } catch (error) {
      // Deliberately not closing. The text the operator wrote is the thing
      // they will not want to retype, and the server's sentence is the reason
      // it did not land.
      setCompletionError(error instanceof Error ? error.message : String(error));
    } finally {
      setCompletionBusy(false);
    }
  }, [closeCompletion, completionAsk, completionSummary, handleMove]);

  /** Board or the pipeline designer; the header pill tabs are the switch. */
  const [view, setView] = React.useState<"board" | "design">("board");

  const total = columns.reduce((sum, column) => sum + column.tasks.length, 0);
  const active = boards.find((b) => b.slug === board);

  return (
    <div className="d-flex flex-column gap-3">
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2">
        <div className="d-flex align-items-center gap-2">
          <ul className="nav nav-pills nav-sm gap-1" role="tablist">
            <li className="nav-item" role="presentation">
              <button
                type="button"
                role="tab"
                aria-selected={view === "board"}
                className={`nav-link py-1 px-2 ${view === "board" ? "active" : ""}`}
                onClick={() => setView("board")}
              >
                Board
              </button>
            </li>
            <li className="nav-item" role="presentation">
              <button
                type="button"
                role="tab"
                aria-selected={view === "design"}
                className={`nav-link py-1 px-2 ${view === "design" ? "active" : ""}`}
                onClick={() => setView("design")}
              >
                Design pipeline
              </button>
            </li>
          </ul>
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
          <Button onClick={() => setCreateAsk(null)} size="sm">
            New task
          </Button>
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

      {view === "design" ? <PipelineDesigner /> : null}

      {view === "board" && load.phase === "ready" && total === 0 ? (
        <p className="text-body-secondary small mb-0">
          This board is empty. Create a card with the + on a column, or check
          you are looking at the right board.
        </p>
      ) : null}

      <TaskDrawer
        cards={columns.flatMap((column) => column.tasks)}
        commentFocus={commentFocus}
        onClose={() => setOpenTaskId(null)}
        // The same gate the bulk bar goes through, with a one-card selection.
        // Two confirm implementations would be two chances to be wrong about
        // the only irreversible action on the board.
        onRequestDelete={(task) => {
          selection.setSelected(new Set([task.id]));
          /*
           * The drawer fetched `GET /tasks/{id}`, whose payload is the detail
           * shape — `link_tasks`, no `link_counts`. The confirm reads the
           * board card, which is where `link_counts.children` lives, so hand it
           * that one when the card is on the board. Falling back to the drawer's
           * own task keeps the confirm correct for a card that is filtered off
           * the board, where `link_tasks` is all there is.
           */
          const fromBoard = columns
            .flatMap((column) => column.tasks)
            .find((t) => t.id === task.id);
          setDestructive({
            action: { kind: "delete" },
            cards: [fromBoard ?? task],
          });
        }}
        options={options}
        taskId={openTaskId}
      />

      {/*
        The bar is inside the board frame so it covers the rail rather than
        pushing the columns down -- a selection bar that reflows the board
        makes the cards you are about to act on move under the cursor.
      */}
      <CreateTaskDialog
        cards={columns.flatMap((column) => column.tasks)}
        defaultWorkspaceKind={active?.default_workspace_kind ?? null}
        initialStatus={createAsk ?? undefined}
        onCancel={() => setCreateAsk(undefined)}
        onCreate={submitCreate}
        onServerError={(message) => setNotice({ tone: "danger", text: message })}
        open={createAsk !== undefined}
      />

      <ConfirmDialog
        body={
          destructive ? (
            <>
              {destructive.cards.length === 1 ? (
                <p className="mb-2">
                  <strong>{destructive.cards[0]?.title}</strong>
                  {destructive.action.kind === "delete" ? (
                    <>
                      {" "}
                      and every comment, event and attachment on it will be deleted. This
                      cannot be undone.
                    </>
                  ) : (
                    " will be archived and hidden from the board. It is still on the server."
                  )}
                </p>
              ) : null}

              {/*
               * The server now says what a delete actually did — a running
               * task's worker was killed, and dependent cards were released.
               * Those are the two consequences a count of "3 cards" hides, and
               * they are exactly the ones that touch something other than the
               * card being destroyed. `kanban_db.delete_task` was fixed in
               * #52; the confirm has to name it, or the fix is invisible.
               */}
              {destructive.action.kind === "delete" && riskyDelete.running + riskyDelete.children > 0 ? (
                <div className="kb-confirm-warn" role="alert">
                  {destructive.cards.length === 1 ? (
                    <>
                      {riskyDelete.running ? (
                        <p className="mb-1">
                          <strong>This card is running.</strong> Deleting it terminates the
                          worker attached to it.
                        </p>
                      ) : null}
                      {riskyDelete.children ? (
                        <p className="mb-1">
                          <strong>
                            {riskyDelete.children} card{riskyDelete.children === 1 ? "" : "s"}{" "}
                            depend{riskyDelete.children === 1 ? "s" : ""} on it
                          </strong>
                          . {riskyDelete.children === 1 ? "It" : "They"} will be released and
                          may become ready to run.
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <>
                      {riskyDelete.running ? (
                        <p className="mb-1">
                          <strong>{riskyDelete.running} of these cards {riskyDelete.running === 1 ? "is" : "are"} running.</strong>{" "}
                          Deleting {riskyDelete.running === 1 ? "it" : "them"} terminates the
                          attached workers.
                        </p>
                      ) : null}
                      {riskyDelete.children ? (
                        <p className="mb-1">
                          <strong>
                            {riskyDelete.children} card{riskyDelete.children === 1 ? "" : "s"}{" "}
                            depend{riskyDelete.children === 1 ? "s" : ""} on these
                          </strong>
                          . {riskyDelete.children === 1 ? "It" : "They"} will be released and may
                          become ready to run.
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}

              {destructive.cards.length > 1 ? (
                <p className="mb-2">
                  {destructive.cards.length} cards will be{" "}
                  {destructive.action.kind === "delete" ? (
                    <>deleted with all their comments, events and attachments</>
                  ) : (
                    <>archived and hidden from the board</>
                  )}
                  .{" "}
                  {destructive.action.kind === "delete" && (
                    <>This cannot be undone. </>
                  )}
                </p>
              ) : null}
              {/*
               * A confirm that says "3 cards" over a selection of 4 is worse
               * than no confirm, so the list is the authority on the count.
               */}
              {destructive.cards.length > 1 ? (
                <ul className="kb-confirm-list mb-0">
                  {destructive.cards.slice(0, 8).map((card) => (
                    <li key={card.id}>{card.title}</li>
                  ))}
                  {destructive.cards.length > 8 ? (
                    <li className="kb-confirm-more">
                      and {destructive.cards.length - 8} more
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </>
          ) : bulkCompletion ? (
            bulkCompletion.label ? (
              <>
                This card has no result recorded. The summary is stored as its result and
                its history.
              </>
            ) : (
              <>
                {bulkCompletion.bare.length} of {bulkCompletion.ids.length} selected cards
                have no result recorded. One summary is written to all{" "}
                {bulkCompletion.ids.length} — the ones that already have evidence keep it.
              </>
            )
          ) : completionAsk ? (
            <>
              <strong>{completionAsk.task.title}</strong> will be marked{" "}
              <strong>Done</strong>. Nothing recorded here can be recovered from the card
              afterwards.
            </>
          ) : null
        }
        busy={completionBusy}
        error={completionError}
        tone={destructive?.action.kind === "delete" ? "danger" : "primary"}
        confirmLabel={
          destructive
            ? destructive.action.kind === "delete"
              ? `Delete ${destructive.cards.length} card${destructive.cards.length === 1 ? "" : "s"}`
              : `Archive ${destructive.cards.length} card${destructive.cards.length === 1 ? "" : "s"}`
            : "Complete"
        }
        onCancel={destructive ? closeDestructive : bulkCompletion ? closeBulkCompletion : closeCompletion}
        onConfirm={() =>
          void (destructive
            ? confirmDestructive()
            : bulkCompletion
              ? confirmBulkCompletion()
              : confirmCompletion())
        }
        open={
          completionAsk !== null || bulkCompletion !== null || destructive !== null
        }
        requireText={
          destructive
            ? undefined
            : {
                label: "Completion summary",
                onChange: setCompletionSummary,
                placeholder: "What did this actually do?",
                value: completionSummary,
              }
        }
        title={
          destructive
            ? destructive.action.kind === "delete"
              ? "Delete this work?"
              : "Archive these cards?"
            : bulkCompletion
              ? bulkCompletion.label
                ? `Complete "${bulkCompletion.label}"`
                : `Complete ${bulkCompletion.ids.length} tasks`
              : "Complete this task"
        }
      />

      {/* Spec §9: a compact panel above the board, not a page and not a
          separate stage. The drawer owns which card is selected, so the panel
          reads that rather than keeping a second notion of "the current card". */}
      <PipelinePanel
        selectedCardId={openTaskId}
        onRunCreated={(cardId) => {
          // The pair is created together, so there is a card to open the moment
          // Run returns. The board is re-read rather than patched: the panel
          // does not know the board's shape, and a local insert here would be a
          // second thing to keep in step with the server.
          kanbanApi
            .getBoard(options)
            .then((payload) => {
              setColumns(payload.columns);
              setServerNow(payload.now ?? null);
              setOpenTaskId(cardId);
            })
            .catch((err: unknown) => {
              setNotice({ tone: "error", text: errorMessage(err) });
            });
        }}
        onError={(message) => setNotice({ tone: "error", text: message })}
      />

      <AttentionStrip
        onBoardChanged={() => kanbanApi.getBoard(options).then((payload) => {
          setColumns(payload.columns);
          setServerNow(payload.now ?? null);
        })}
        onError={(message) => setNotice({ tone: "error", text: message })}
        onFocusComment={(taskId) => {
          setOpenTaskId(taskId);
          // A comment action wants the composer, not the detail. The drawer
          // owns its tab, so the intent is handed over as a signal rather
          // than by reaching into it.
          setCommentFocus({ taskId, at: Date.now() });
        }}
        onOpenTask={setOpenTaskId}
        options={options}
      />

      <BulkActionBar
        busy={bulkBusy}
        count={selection.selected.size}
        onClear={() => {
          selection.clear();
          setBulkOutcome(null);
        }}
        onDismissFailures={() => setBulkOutcome(null)}
        onRun={handleBulk}
        outcome={bulkOutcome}
      />

      <KanbanBoard
        columns={columns}
        now={serverNow}
        onRequestDelete={(ids) => {
          // The third entry point into one confirm. The zone resolves a drop to
          // a single id and a click to "the selection"; both end up here, and
          // so does the drawer. Three call sites, one dialog.
          if (ids.length) {
            const card = columns
              .flatMap((c) => c.tasks)
              .find((t) => t.id === ids[0]);
            if (!card) return;
            selection.setSelected(new Set(ids));
            setDestructive({ action: { kind: "delete" }, cards: [card] });
            return;
          }
          // A drop with no id on the transfer and nothing selected is a dead
          // click. It cannot happen with a real browser drag — the DataTransfer
          // is shared across the whole drag — but a silent no-op from a
          // control that looked armed is the one thing this must never be.
          if (selection.selected.size === 0) {
            setNotice({
              tone: "warning",
              text: "Nothing to delete: no card is selected.",
            });
            return;
          }
          handleBulk({ kind: "delete" });
        }}
        onCreateCard={handleCreateCard}
        onMove={(taskId, to) => {
          // Fire-and-forget: the board does not await, and `handleMove`
          // rethrows so the completion dialog can show the server's sentence.
          // A promise with no catch here would surface as an unhandled
          // rejection and take the console down with an unrelated stack.
          void handleMove(taskId, to).catch(() => {});
        }}
        onOpenTask={handleOpenTask}
        onSelectMany={(ids) => {
          selection.setSelected(ids);
          setBulkOutcome(null);
        }}
        onSelectTask={handleSelectTask}
        selectedIds={selection.selected}
      />
    </div>
  );
}
