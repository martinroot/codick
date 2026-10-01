"""Durable identity and idempotent ingress for external task sources.

Why this exists
---------------
Every channel that can push a task at us — Microsoft To Do today, something else
tomorrow — has the same two problems, and both of them are about truth rather
than plumbing:

1. **A task must have an identity that outlives any single request.** If the
   task's id, route, run and correlation live in UI memory or a scratch file,
   then a restart loses exactly the thing that makes Telegram, the board and
   the HTTP API the same task instead of three unrelated conversations.

2. **Delivery is retried.** Microsoft Graph re-sends a webhook when the
   acknowledgement is slow, and will do it again on a timeout. A retry that
   starts a second agent run produces two answers, two cards, and a cost that
   is double what the board says it is. This is the same class of bug as the
   double-submitted pipeline attempt: a lease or a timeout is not an
   idempotency key.

So the contract here is deliberately narrow and platform-agnostic:

- ``claim_event`` is the only way in. It either wins the event and returns
  ``new``, or loses and returns the *stored* outcome of the original delivery.
  Never "start again and hope".
- The claim is atomic against a concurrent delivery. Two requests arriving at
  the same instant produce exactly one winner, decided by the unique
  constraint rather than by a read followed by a write.

What this module deliberately is **not**
---------------------------------------
It is not a Microsoft client. It has no Graph endpoint, no OAuth flow and no
knowledge of what a To Do list is. Repository policy is explicit that vendor
SaaS connectors ship as standalone plugin repositories, not in this tree; the
plugin calls into this module. If this file grew a `get_todo_list()`, the
policy argument would be exactly one function long and finished.

Layout follows the other durable stores: ``<HERMES_HOME>/plugin-data/``,
resolved on every call so it follows the active profile, never cached across
profile switches.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, List, Optional

from hermes_cli.sqlite_util import write_txn

# ---------------------------------------------------------------------------
# Storage location
# ---------------------------------------------------------------------------


def ingress_data_root() -> Path:
    """``<HERMES_HOME>/plugin-data/ingress/`` — resolved on every call so it
    follows the active profile."""
    # `hermes_constants`, not `hermes_cli.home` -- there is no such module, and
    # this import sat behind a passing test suite for a full cycle because every
    # test passed an explicit path and never called the function.
    from hermes_constants import get_hermes_home

    return get_hermes_home() / "plugin-data" / "ingress"


def ingress_db_path() -> Path:
    return ingress_data_root() / "ingress.db"


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS ingest_events (
    platform      TEXT NOT NULL,
    event_id      TEXT NOT NULL,
    task_id       TEXT,
    payload_hash  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'claimed',
    result_json   TEXT,
    error         TEXT,
    claimed_at    REAL NOT NULL,
    settled_at    REAL,
    PRIMARY KEY (platform, event_id)
);

CREATE INDEX IF NOT EXISTS idx_ingest_events_task
    ON ingest_events (task_id);

CREATE TABLE IF NOT EXISTS external_tasks (
    platform       TEXT NOT NULL,
    external_id    TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    profile        TEXT,
    project        TEXT,
    board_task_id  TEXT,
    run_id         TEXT,
    channel        TEXT,
    session_id     TEXT,
    title          TEXT,
    state          TEXT NOT NULL DEFAULT 'received',
    detail_json    TEXT,
    received_at    REAL NOT NULL,
    updated_at     REAL NOT NULL,
    PRIMARY KEY (platform, external_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_external_tasks_correlation
    ON external_tasks (correlation_id);

-- One task, many deliveries (#57).
--
-- `external_tasks` is keyed by correlation id, so a To Do item and a Telegram
-- message about the same piece of work cannot both be rows in it: the unique
-- index would refuse the second. That is the whole problem, and it is why this
-- table exists. A delivery is the *channel-side* handle; the task is the work.
CREATE TABLE IF NOT EXISTS external_deliveries (
    platform       TEXT NOT NULL,
    external_id    TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    received_at    REAL NOT NULL,
    PRIMARY KEY (platform, external_id)
);

CREATE INDEX IF NOT EXISTS idx_external_deliveries_correlation
    ON external_deliveries (correlation_id);

CREATE INDEX IF NOT EXISTS idx_external_tasks_board_task
    ON external_tasks (board_task_id);

CREATE TABLE IF NOT EXISTS routing_rules (
    platform  TEXT NOT NULL,
    selector  TEXT NOT NULL,
    profile   TEXT NOT NULL,
    note      TEXT,
    created_at REAL NOT NULL,
    PRIMARY KEY (platform, selector)
);
"""

_INITIALIZED_PATHS: set[str] = set()


def _backfill_deliveries(conn: sqlite3.Connection) -> None:
    """Give every existing task a delivery row for its own (platform, id).

    Before #57 the task row *was* the delivery, so a database written by the old
    schema has rows with no delivery behind them. Backfilling keeps those tasks
    reachable through the new lookup instead of silently vanishing from it.

    ``INSERT OR IGNORE`` on the primary key makes this safe to re-run, which
    matters because the schema is applied on every open.

    It opens its own transaction rather than relying on the caller: a bare
    execute leaves an implicit transaction open, and the next ``write_txn`` on
    the same connection then fails with "cannot start a transaction within a
    transaction" -- an error a long way from this function.
    """
    with write_txn(conn):
        conn.execute(
            "INSERT OR IGNORE INTO external_deliveries "
            "(platform, external_id, correlation_id, received_at) "
            "SELECT platform, external_id, correlation_id, received_at FROM external_tasks"
        )


def connect(db_path: Optional[Path] = None) -> sqlite3.Connection:
    """Open (and initialize if needed) the ingress DB. Schema init is
    idempotent and cached per resolved path per process; ``db_path`` is the
    test seam."""
    path = db_path if db_path is not None else ingress_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    resolved = str(path.resolve())

    def _initialize(conn: sqlite3.Connection) -> None:
        if resolved in _INITIALIZED_PATHS:
            return
        conn.executescript(SCHEMA_SQL)
        _backfill_deliveries(conn)
        conn.commit()
        _INITIALIZED_PATHS.add(resolved)

    conn = sqlite3.connect(str(path), timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        _initialize(conn)
    except Exception:
        conn.close()
        raise
    return conn


@contextlib.contextmanager
def connect_closing(db_path: Optional[Path] = None) -> Iterator[sqlite3.Connection]:
    """Open the ingress DB and close it on exit (sqlite3's context manager
    never closes)."""
    conn = connect(db_path=db_path)
    try:
        yield conn
    finally:
        with contextlib.suppress(Exception):
            conn.close()


# ---------------------------------------------------------------------------
# Records
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EventClaim:
    """The outcome of trying to take ownership of one delivery.

    ``claimed`` is the only value that authorises work. ``duplicate`` carries
    the original delivery's stored outcome so the caller can replay it — the
    caller must not treat a duplicate as a fresh task, and must not silently
    swallow it either, because a replayed answer is what the platform is
    waiting for.
    """

    claimed: bool
    platform: str
    event_id: str
    task_id: Optional[str] = None
    status: str = "claimed"
    result: Any = None
    error: Optional[str] = None


@dataclass(frozen=True)
class ExternalTask:
    platform: str
    external_id: str
    correlation_id: str
    profile: Optional[str]
    project: Optional[str]
    board_task_id: Optional[str]
    run_id: Optional[str]
    channel: Optional[str]
    session_id: Optional[str]
    title: Optional[str]
    state: str
    detail: Optional[dict]
    received_at: float
    updated_at: float

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "ExternalTask":
        detail = None
        if row["detail_json"]:
            with contextlib.suppress(json.JSONDecodeError):
                detail = json.loads(row["detail_json"])
        return cls(
            platform=row["platform"],
            external_id=row["external_id"],
            correlation_id=row["correlation_id"],
            profile=row["profile"],
            project=row["project"],
            board_task_id=row["board_task_id"],
            run_id=row["run_id"],
            channel=row["channel"],
            session_id=row["session_id"],
            title=row["title"],
            state=row["state"],
            detail=detail,
            received_at=row["received_at"],
            updated_at=row["updated_at"],
        )


def receipt_key(notification: dict) -> str:
    """One key for one webhook delivery, in the same format the Teams pipeline
    already uses (``plugins/teams_pipeline/store.py``).

    The format is duplicated rather than imported on purpose. That plugin
    directory is not importable from this package's dependency graph, and a
    cross-plugin import to save three lines would couple the core to a plugin
    that policy can move out of the tree. The contract is the *string*, and this
    test is what holds the two honest:

        id:<explicit id>                      when the payload carries one
        sha256:<hex of canonical JSON>        otherwise

    Two systems that agree on the spelling can share a delivery id. Two systems
    that invent their own cannot, and the failure is silent: both dedupe, each
    within itself, and the duplicate still runs twice.
    """
    explicit = notification.get("id")
    if explicit:
        return f"id:{explicit}"
    canonical = json.dumps(notification, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"


def _dumps(value: Any) -> Optional[str]:
    if value is None:
        return None
    return json.dumps(value, sort_keys=True, default=str)


# ---------------------------------------------------------------------------
# Event claiming — the idempotency boundary
# ---------------------------------------------------------------------------


def claim_event(
    conn: sqlite3.Connection,
    *,
    platform: str,
    event_id: str,
    payload_hash: str,
    task_id: Optional[str] = None,
    now: Optional[float] = None,
) -> EventClaim:
    """Take ownership of one delivery, or learn that it already happened.

    The atomicity is the point. A read-then-write ("does this event exist?")
    races: two concurrent deliveries both read *no*, and both proceed. Here the
    insert is attempted first and the unique constraint on
    ``(platform, event_id)`` decides the winner, so at most one caller ever
    receives ``claimed=True``.

    A duplicate is **not** an error and **not** a re-run: the caller replays
    ``result`` and acknowledges.
    """
    ts = time.time() if now is None else now
    with write_txn(conn):
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO ingest_events
                (platform, event_id, task_id, payload_hash, status, claimed_at)
            VALUES (?, ?, ?, ?, 'claimed', ?)
            """,
            (platform, event_id, task_id, payload_hash, ts),
        )
        inserted = cur.rowcount == 1

    if inserted:
        return EventClaim(
            claimed=True,
            platform=platform,
            event_id=event_id,
            task_id=task_id,
            status="claimed",
        )

    row = conn.execute(
        "SELECT * FROM ingest_events WHERE platform = ? AND event_id = ?",
        (platform, event_id),
    ).fetchone()
    if row is None:
        # The row vanished between our insert and this read. Someone removed it,
        # which is not a state this module creates; treat as claimed so the
        # work happens rather than being silently dropped.
        return EventClaim(
            claimed=True,
            platform=platform,
            event_id=event_id,
            task_id=task_id,
            status="claimed",
        )

    result = None
    if row["result_json"]:
        with contextlib.suppress(json.JSONDecodeError):
            result = json.loads(row["result_json"])
    return EventClaim(
        claimed=False,
        platform=platform,
        event_id=event_id,
        task_id=row["task_id"],
        status=row["status"],
        result=result,
        error=row["error"],
    )


def settle_event(
    conn: sqlite3.Connection,
    *,
    platform: str,
    event_id: str,
    status: str,
    result: Any = None,
    error: Optional[str] = None,
    now: Optional[float] = None,
) -> None:
    """Record how a claimed delivery ended, so a duplicate can replay it."""
    ts = time.time() if now is None else now
    with write_txn(conn):
        conn.execute(
            """
            UPDATE ingest_events
               SET status = ?, result_json = ?, error = ?, settled_at = ?,
                   task_id = COALESCE(task_id, ?)
             WHERE platform = ? AND event_id = ?
            """,
            (status, _dumps(result), error, ts, None, platform, event_id),
        )


# ---------------------------------------------------------------------------
# External task identity
# ---------------------------------------------------------------------------


def new_correlation_id() -> str:
    import uuid

    return f"cor_{uuid.uuid4().hex[:16]}"


def upsert_task(
    conn: sqlite3.Connection,
    *,
    platform: str,
    external_id: str,
    correlation_id: Optional[str] = None,
    profile: Optional[str] = None,
    project: Optional[str] = None,
    title: Optional[str] = None,
    channel: Optional[str] = None,
    detail: Optional[dict] = None,
    now: Optional[float] = None,
) -> ExternalTask:
    """Create or update the durable record for one external task.

    The correlation id is generated once and never regenerated: it is the thing
    that ties a Telegram reply, a board card and a run together, so replacing
    it on a later update would break exactly the link this table exists to hold.
    """
    ts = time.time() if now is None else now
    with write_txn(conn):
        row = conn.execute(
            "SELECT correlation_id FROM external_tasks WHERE platform = ? AND external_id = ?",
            (platform, external_id),
        ).fetchone()
        correlation = correlation_id or (row["correlation_id"] if row else None)
        if not correlation:
            correlation = new_correlation_id()
        if row is None:
            conn.execute(
                """
                INSERT INTO external_tasks
                    (platform, external_id, correlation_id, profile, project,
                     channel, title, detail_json, state, received_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
                """,
                (platform, external_id, correlation, profile, project,
                 channel, title, _dumps(detail), ts, ts),
            )
        else:
            conn.execute(
                """
                UPDATE external_tasks
                   SET profile = COALESCE(?, profile),
                       project = COALESCE(?, project),
                       channel = COALESCE(?, channel),
                       title = COALESCE(?, title),
                       detail_json = COALESCE(?, detail_json),
                       updated_at = ?
                 WHERE platform = ? AND external_id = ?
                """,
                (profile, project, channel, title, _dumps(detail), ts,
                 platform, external_id),
            )
    # A task created on To Do is also a To Do *delivery*. Without this the task
    # row exists but nothing can reach it through the delivery lookup, so
    # `list_deliveries` would omit its own channel and a second channel's binding
    # would not be visible from the first.
    record_delivery(
        conn, platform=platform, external_id=external_id,
        correlation_id=correlation, now=ts,
    )
    task = get_task(conn, platform=platform, external_id=external_id)
    if task is None:  # pragma: no cover - the row was just written
        raise RuntimeError("external task vanished immediately after upsert")
    return task


def get_task(
    conn: sqlite3.Connection, *, platform: str, external_id: str
) -> Optional[ExternalTask]:
    """The task behind one channel-side handle.

    Resolved through ``external_deliveries`` first, so a To Do id and a Telegram
    id that name the same correlation id return the **same** task. Falling back
    to the task row keeps databases written before #57 readable.
    """
    row = conn.execute(
        "SELECT correlation_id FROM external_deliveries "
        "WHERE platform = ? AND external_id = ?",
        (platform, external_id),
    ).fetchone()
    if row is not None:
        return get_task_by_correlation(conn, row["correlation_id"])
    row = conn.execute(
        "SELECT * FROM external_tasks WHERE platform = ? AND external_id = ?",
        (platform, external_id),
    ).fetchone()
    return ExternalTask.from_row(row) if row is not None else None


def record_delivery(
    conn: sqlite3.Connection,
    *,
    platform: str,
    external_id: str,
    correlation_id: str,
    now: Optional[float] = None,
) -> str:
    """Attach a channel-side handle to a task; returns the correlation id.

    Insert-first, so two concurrent deliveries of the same item cannot both
    decide they own the binding: the primary key decides, and the loser gets the
    winner's correlation id back rather than inventing its own.

    Two platforms naming the **same** correlation id is the #57 case -- a To Do
    item and a Telegram message about the same work -- and it is exactly what
    this table makes expressible.
    """
    ts = time.time() if now is None else now
    with write_txn(conn):
        cur = conn.execute(
            "INSERT OR IGNORE INTO external_deliveries "
            "(platform, external_id, correlation_id, received_at) VALUES (?, ?, ?, ?)",
            (platform, external_id, correlation_id, ts),
        )
        if cur.rowcount == 0:
            row = conn.execute(
                "SELECT correlation_id FROM external_deliveries "
                "WHERE platform = ? AND external_id = ?",
                (platform, external_id),
            ).fetchone()
            if row is not None and row["correlation_id"] != correlation_id:
                # A retry that names a different task is a real conflict, not a
                # duplicate. Silently keeping the old binding would make the
                # delivery's own correlation id a lie.
                raise ValueError(
                    f"delivery ({platform!r}, {external_id!r}) is already bound to "
                    f"{row['correlation_id']!r}, not {correlation_id!r}"
                )
            return row["correlation_id"] if row is not None else correlation_id
    return correlation_id


def list_deliveries(
    conn: sqlite3.Connection, correlation_id: str
) -> List[dict]:
    """Every channel-side handle for one task."""
    rows = conn.execute(
        "SELECT platform, external_id, received_at FROM external_deliveries "
        "WHERE correlation_id = ? ORDER BY platform, external_id",
        (correlation_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def get_task_by_correlation(
    conn: sqlite3.Connection, correlation_id: str
) -> Optional[ExternalTask]:
    row = conn.execute(
        "SELECT * FROM external_tasks WHERE correlation_id = ?", (correlation_id,)
    ).fetchone()
    return ExternalTask.from_row(row) if row is not None else None


def bind_run(
    conn: sqlite3.Connection,
    *,
    platform: str,
    external_id: str,
    board_task_id: Optional[str] = None,
    run_id: Optional[str] = None,
    session_id: Optional[str] = None,
    now: Optional[float] = None,
) -> Optional[ExternalTask]:
    """Attach the run that serves this task, and the session it runs in.

    ``session_id`` is recorded, never trusted for authorization: session
    identity and tenant authorization are separate questions, and in
    ``api_server`` the session key is not bound to a credential.
    """
    ts = time.time() if now is None else now
    # Resolved through the delivery to the task's own row. Binding by the
    # delivery's (platform, external_id) would update nothing for a second
    # channel: that handle has no task row of its own, so the run and the
    # session were written nowhere and the binding silently vanished.
    task = get_task(conn, platform=platform, external_id=external_id)
    if task is None:
        return None
    with write_txn(conn):
        conn.execute(
            """
            UPDATE external_tasks
               SET board_task_id = COALESCE(?, board_task_id),
                   run_id = COALESCE(?, run_id),
                   session_id = COALESCE(?, session_id),
                   updated_at = ?
             WHERE correlation_id = ?
            """,
            (board_task_id, run_id, session_id, ts, task.correlation_id),
        )
    return get_task_by_correlation(conn, task.correlation_id)


def set_state(
    conn: sqlite3.Connection,
    *,
    platform: str,
    external_id: str,
    state: str,
    now: Optional[float] = None,
) -> Optional[ExternalTask]:
    """Move the task's lifecycle state. The record survives every transition,
    so a restart can answer "what was this task doing" without asking the
    platform again."""
    ts = time.time() if now is None else now
    with write_txn(conn):
        conn.execute(
            "UPDATE external_tasks SET state = ?, updated_at = ? WHERE platform = ? AND external_id = ?",
            (state, ts, platform, external_id),
        )
    return get_task(conn, platform=platform, external_id=external_id)