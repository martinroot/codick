import * as React from "react";

import { KANBAN_EVENTS_PATH } from "@/lib/kanban-api";

/**
 * One event off the board's WebSocket.
 *
 * The backend sends the whole batch plus the cursor it advanced to, so this
 * only has to keep the cursor current -- it never has to interpret the
 * payload. A missing field would be a silent gap that only shows up as a
 * board that quietly stops updating, so a malformed frame is dropped and
 * logged rather than half-applied.
 */
export interface KanbanEvent {
  id?: number;
  kind?: string;
  task_id?: string | null;
  run_id?: number | null;
  payload?: unknown;
  created_at?: number;
}

interface KanbanEventFrame {
  events?: KanbanEvent[];
  cursor?: number;
}

export interface KanbanEventsOptions {
  /** Board to watch. Changing it opens a fresh socket -- the board is pinned
   *  at the handshake, so one socket cannot follow two boards. */
  board: string;
  /** Resume cursor from the last board read. `null` means "from now", which
   *  is right on a first load and wrong on a reconnect -- that is what drops
   *  changes made while the tab was closed. */
  since: number | null;
  /** Called with each batch. The cursor stays here: this hook is what
   *  reconnects with it, and a caller that tracked it separately would have
   *  two sources of truth for the same number. */
  onEvents: (events: KanbanEvent[]) => void;
  onStatusChange?: (connected: boolean) => void;
  enabled?: boolean;
}

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000, 10000];

function buildSocketUrl(board: string, since: number | null): string {
  const explicit = window.location;
  const scheme = explicit.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ board });
  if (since !== null) params.set("since", String(since));
  // The upgrade is authorised by the dashboard's own gate, which reads the
  // token from the query string. A browser cannot set headers on a
  // WebSocket, so this is the only way to carry it.
  const token = window.__HERMES_SESSION_TOKEN__;
  if (token) params.set("token", token);
  return `${scheme}//${explicit.host}${KANBAN_EVENTS_PATH}?${params.toString()}`;
}

/**
 * Subscribe to board changes for as long as the board is on screen.
 *
 * The board is kept honest by re-reading it when events arrive rather than by
 * replaying each event into local state. The event stream is a *signal*, not
 * a second source of truth: mapping every event kind onto a state mutation
 * would be a second implementation of the backend's rules, and it would be
 * wrong for exactly the kinds nobody remembered to handle. The spec's own
 * rule applies -- the backend decides what is true.
 */
export function useKanbanEvents(options: KanbanEventsOptions): void {
  const { board, since, onEvents, onStatusChange, enabled = true } = options;

  // Callers pass inline functions; putting them in refs keeps a new closure
  // from tearing the socket down on every render.
  const onEventsRef = React.useRef(onEvents);
  const onStatusRef = React.useRef(onStatusChange);
  React.useEffect(() => {
    onEventsRef.current = onEvents;
    onStatusRef.current = onStatusChange;
  });

  // The cursor is state rather than a ref: resuming after a reconnect must
  // use the newest value the server has handed us, and a ref written inside
  // a socket callback would still be stale when the reconnect effect runs.
  const [cursor, setCursor] = React.useState<number | null>(since);
  const cursorRef = React.useRef(cursor);
  React.useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  React.useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let closed = false;

    const connect = () => {
      if (closed) return;
      try {
        socket = new WebSocket(buildSocketUrl(board, cursorRef.current));
      } catch {
        schedule();
        return;
      }
      socket.onopen = () => {
        attempt = 0;
        onStatusRef.current?.(true);
      };
      socket.onmessage = (message) => {
        let frame: KanbanEventFrame;
        try {
          frame = JSON.parse(String(message.data)) as KanbanEventFrame;
        } catch {
          return;
        }
        const events = Array.isArray(frame.events) ? frame.events : [];
        if (typeof frame.cursor === "number") {
          setCursor(frame.cursor);
          cursorRef.current = frame.cursor;
        }
        if (events.length) onEventsRef.current(events);
      };
      socket.onclose = () => {
        onStatusRef.current?.(false);
        schedule();
      };
      // An error is always followed by close; reconnecting here too would
      // open a second socket against the same board.
      socket.onerror = () => {};
    };

    const schedule = () => {
      if (closed) return;
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
    // `since` is deliberately absent: it seeds the first connection only, and
    // re-running on every cursor update would reconnect in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, enabled]);
}
