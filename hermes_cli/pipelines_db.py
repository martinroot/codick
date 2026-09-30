"""CoDick pipeline run-state storage (spec ``docs/pipelines/spec.md`` §4, §12; issue #36).

The six objects of spec §4 — ``ScenarioTemplate``, ``PipelineRun``, ``StepAttempt``,
``InputRequest``, ``Artifact``, ``RunEvent`` — live in one SQLite DB under
``<HERMES_HOME>/plugin-data/pipelines/``. That location is the decision recorded in #44:
the run state machine and the board link must be writable in one transaction on the
dashboard's store, where the kanban board already lives; ``/api/pipelines/*`` is a core
namespace there, a peer of ``/api/kanban`` (#27).

Hermes-internal tables are never edited; everything here is CoDick's own additive schema
(spec §12). The kanban ``tasks`` table gains no columns — a run's card link is
``pipeline_runs.card_id`` on this side (#40 point 6), a card is not created per step, and
run state is never communicated by moving a card between columns.

**Single-node by construction** (#40 point 5): shared SQLite over the network is not a
multi-server mechanism (spec §12). The later cluster/fleet epics must move or share run
state explicitly; nothing here should assume a second writer node.

Execution state never lives in the source JSON: a run stores an immutable snapshot of the
template plus its hash when it is created (spec §4), so editing a template never changes a
run already in flight. Migrations are idempotent ``CREATE TABLE IF NOT EXISTS`` plus
``add_column_if_missing`` — opening an old DB is always safe.

Artefacts: the blob lives on disk under ``artifacts_root()``; the row carries metadata and
a *relative* storage reference, which is server-side only — an artifact payload must reach
a client through a protected route, never as a raw filesystem path (spec §12).
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, List, Optional

from hermes_cli.sqlite_util import add_column_if_missing, open_db, write_txn
from hermes_constants import get_hermes_home

__all__ = [
    "RUN_STATUSES", "TERMINAL_RUN_STATUSES", "ATTEMPT_STATUSES", "REQUEST_STATUSES",
    "KNOWN_EVENT_TYPES", "EVENT_SCHEMA_VERSION",
    "ScenarioTemplate", "PipelineRun", "StepAttempt", "InputRequest", "RunEvent", "Artifact",
    "pipelines_data_root", "pipelines_db_path", "artifacts_root", "connect", "connect_closing",
    "import_template", "get_template", "list_templates", "list_template_versions", "delete_template",
    "create_run", "get_run", "list_runs", "runs_for_card", "set_run_status", "set_run_scheduling",
    "set_run_result", "finish_run", "bump_rework_cycles", "bump_step_executions",
    "expire_input_deadlines",
    "create_attempt", "get_attempt", "list_attempts", "start_attempt", "finish_attempt",
    "claim_attempt", "heartbeat_attempt", "release_attempt",
    "open_input_request", "get_input_request", "list_input_requests", "answer_input_request",
    "invalidate_input_requests",
    "append_event", "get_event", "list_events",
    "register_artifact", "list_artifacts",
]

# Run states (spec §7). ``blocked`` = an unknown outcome of an external call or a missing
# prerequisite; recovery, not approval. ``waiting_input`` = an open InputRequest, no model call.
RUN_STATUSES = frozenset({
    "queued", "running", "waiting_input", "blocked", "completed", "failed", "cancelled",
})
TERMINAL_RUN_STATUSES = frozenset({"completed", "failed", "cancelled"})

# Attempt states (spec §7). ``unknown`` is the restart-reconciliation state: the outcome of
# the external call could not be established, and the side effect must not be blindly repeated.
ATTEMPT_STATUSES = frozenset({
    "queued", "running", "waiting_input", "completed", "failed", "cancelled", "unknown",
})

REQUEST_STATUSES = frozenset({"open", "answered", "expired", "invalidated", "cancelled"})

# The event vocabulary of #43 (spec §11). Documented, not enforced — additive per the
# compat contract; a future stage may add types without a migration.
KNOWN_EVENT_TYPES = frozenset({
    "run.created", "run.started", "run.blocked", "run.completed", "run.failed", "run.cancelled",
    "step.started", "step.progress", "step.completed", "step.failed",
    "input.requested", "input.message", "input.received",
    "route.selected",
})
EVENT_SCHEMA_VERSION = "1.0"


def _now() -> int:
    return int(time.time())


def _new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def pipelines_data_root() -> Path:
    """``<HERMES_HOME>/plugin-data/pipelines/`` — resolved on every call so it follows the
    active profile; never cached across profile switches (see ``plugins/plugin_storage``)."""
    return get_hermes_home() / "plugin-data" / "pipelines"


def pipelines_db_path() -> Path:
    return pipelines_data_root() / "pipelines.db"


def artifacts_root() -> Path:
    return pipelines_data_root() / "artifacts"


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS scenario_templates (
    id          TEXT NOT NULL,
    version     TEXT NOT NULL,
    name        TEXT,
    description TEXT,
    json        TEXT NOT NULL,
    -- Import readiness (#30, spec §6): 'ready' or 'unavailable'; a template
    -- stored unavailable may exist but must not be runnable.
    readiness        TEXT NOT NULL DEFAULT 'ready',
    readiness_detail TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
    id               TEXT PRIMARY KEY,
    template_id      TEXT NOT NULL,
    template_version TEXT NOT NULL,
    -- Immutable snapshot of the template at run creation + its hash (spec §4). Never
    -- updated after insert; editing or deleting the template cannot change a run.
    template_snapshot TEXT NOT NULL,
    template_hash     TEXT NOT NULL,
    status           TEXT NOT NULL,
    current_step_id  TEXT,
    next_attempt_at  INTEGER,
    deadline         INTEGER,
    step_executions  INTEGER NOT NULL DEFAULT 0,
    rework_cycles    INTEGER NOT NULL DEFAULT 0,
    inputs           TEXT,
    result           TEXT,
    error            TEXT,
    error_code       TEXT,
    card_id          TEXT,
    created_at       INTEGER NOT NULL,
    started_at       INTEGER,
    ended_at         INTEGER,
    updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS step_attempts (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    step_id         TEXT NOT NULL,
    ordinal         INTEGER NOT NULL,
    iteration       INTEGER NOT NULL DEFAULT 0,
    attempt_no      INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL,
    execution_id    TEXT,
    idempotency_key TEXT,
    input_snapshot  TEXT,
    output          TEXT,
    error           TEXT,
    error_code      TEXT,
    lease_owner     TEXT,
    lease_expires   INTEGER,
    created_at      INTEGER NOT NULL,
    started_at      INTEGER,
    ended_at        INTEGER
);

CREATE TABLE IF NOT EXISTS input_requests (
    id                   TEXT PRIMARY KEY,
    run_id               TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    step_id              TEXT,
    attempt_id           TEXT,
    status               TEXT NOT NULL,
    prompt               TEXT,
    response_schema      TEXT,
    chat                 TEXT,
    wait_timeout_seconds INTEGER,
    deadline             INTEGER,
    accepted_response    TEXT,
    responded_at         INTEGER,
    created_at           INTEGER NOT NULL,
    closed_at            INTEGER
);

-- Append-only run event log (spec §4, #43). ``seq`` is the table-wide AUTOINCREMENT, so it
-- increases strictly within a run; a client dedupes on ``event_id``/``seq`` and catches up
-- with ``list_events(after_seq=N)``. State + transition + seq land in one write_txn.
CREATE TABLE IF NOT EXISTS run_events (
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id       TEXT NOT NULL UNIQUE,
    run_id         TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    step_id        TEXT,
    attempt_id     TEXT,
    request_id     TEXT,
    type           TEXT NOT NULL,
    payload        TEXT,
    schema_version TEXT NOT NULL,
    occurred_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    filename    TEXT NOT NULL,
    mime_type   TEXT,
    size        INTEGER NOT NULL DEFAULT 0,
    checksum    TEXT,
    owner       TEXT,
    -- Relative reference under ``artifacts_root()``, server-side only (spec §12).
    storage_ref TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_card   ON pipeline_runs(card_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);
CREATE INDEX IF NOT EXISTS idx_step_attempts_run    ON step_attempts(run_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_input_requests_run   ON input_requests(run_id);
CREATE INDEX IF NOT EXISTS idx_run_events_run       ON run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_artifacts_run        ON artifacts(run_id);
"""

_INITIALIZED_PATHS: set[str] = set()


def connect(db_path: Optional[Path] = None) -> sqlite3.Connection:
    """Open (and initialize if needed) the pipeline DB. Schema init is idempotent and cached
    per resolved path per process. ``db_path`` is the test seam; production resolves the
    per-profile ``pipelines_db_path()``."""
    path = db_path if db_path is not None else pipelines_db_path()
    resolved = str(path.resolve())

    def _initialize(conn: sqlite3.Connection) -> None:
        if resolved in _INITIALIZED_PATHS:
            return
        conn.executescript(SCHEMA_SQL)
        # #30 migration: readiness columns on DBs created before the column
        # existed. The CREATE TABLE above covers fresh DBs.
        add_column_if_missing(conn, "scenario_templates", "readiness",
                              "readiness TEXT NOT NULL DEFAULT 'ready'")
        add_column_if_missing(conn, "scenario_templates", "readiness_detail", "readiness_detail TEXT")
        _INITIALIZED_PATHS.add(resolved)

    return open_db(path, db_label="plugin-data/pipelines/pipelines.db",
                   foreign_keys=True, check_same_thread=False, initialize=_initialize)


def connect_closing(db_path: Optional[Path] = None):
    """Open the pipeline DB and close it on exit (sqlite3's context manager never closes)."""
    conn = connect(db_path=db_path)
    try:
        yield conn
    finally:
        with contextlib.suppress(Exception):
            conn.close()


# --- Payload helpers ----------------------------------------------------------

def _dumps(value: Any) -> Optional[str]:
    return None if value is None else json.dumps(value, ensure_ascii=False, sort_keys=True)


def _template_hash(snapshot: str) -> str:
    return hashlib.sha256(snapshot.encode("utf-8")).hexdigest()


# --- Templates ----------------------------------------------------------------
# Full import validation is the #30 format/validator's job (spec §6); the store only
# requires the identity fields and refuses garbage that cannot identify a template.

def import_template(conn: sqlite3.Connection, template: dict, *, now: Optional[int] = None) -> str:
    """Store (or replace) a template identified by ``(id, version)`` and return its id.
    Re-importing the same pair replaces the stored JSON — runs are unaffected, they hold
    their own snapshot."""
    if not isinstance(template, dict):
        raise ValueError("template must be a JSON object")
    template_id = template.get("id")
    version = template.get("version")
    if not isinstance(template_id, str) or not template_id.strip():
        raise ValueError("template.id must be a non-empty string")
    if not isinstance(version, str) or not version.strip():
        raise ValueError("template.version must be a non-empty string")
    ts = now if now is not None else _now()
    with write_txn(conn):
        conn.execute(
            "INSERT INTO scenario_templates (id, version, name, description, json, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(id, version) DO UPDATE SET name = excluded.name, description = excluded.description, "
            "json = excluded.json, updated_at = excluded.updated_at",
            (template_id, version, template.get("name"), template.get("description"),
             _dumps(template), ts, ts),
        )
    return str(template_id)


def _template_from_row(row: sqlite3.Row) -> ScenarioTemplate:
    keys = row.keys()
    detail: Optional[List[str]] = None
    if "readiness_detail" in keys and row["readiness_detail"]:
        try:
            loaded = json.loads(row["readiness_detail"])
            if isinstance(loaded, list):
                detail = loaded
        except (TypeError, ValueError):
            detail = None
    return ScenarioTemplate(
        id=row["id"], version=row["version"], name=row["name"], description=row["description"],
        template=json.loads(row["json"]), created_at=row["created_at"], updated_at=row["updated_at"],
        readiness_status=row["readiness"] if "readiness" in keys and row["readiness"] else "ready",
        readiness_detail=detail,
    )


# "Latest" needs a total order. ``created_at`` and ``updated_at`` are integer
# seconds, so saving two versions inside the same second leaves the choice to
# SQLite — and the reader can then be shown the version the author just replaced.
# ``rowid`` is monotonic with insertion, so it is the tiebreak that matches what
# "latest" means: last written wins.
_TEMPLATE_NEWEST_FIRST = "ORDER BY created_at DESC, updated_at DESC, rowid DESC"


def get_template(conn: sqlite3.Connection, template_id: str, version: Optional[str] = None) -> Optional[ScenarioTemplate]:
    """The template by ``(id, version)``, or its latest version when ``version`` is None."""
    if version is not None:
        row = conn.execute(
            "SELECT * FROM scenario_templates WHERE id = ? AND version = ?", (template_id, version)
        ).fetchone()
        return None if row is None else _template_from_row(row)
    row = conn.execute(
        f"SELECT * FROM scenario_templates WHERE id = ? {_TEMPLATE_NEWEST_FIRST} LIMIT 1",
        (template_id,),
    ).fetchone()
    return None if row is None else _template_from_row(row)


def list_templates(conn: sqlite3.Connection) -> List[ScenarioTemplate]:
    """Every template version, newest first."""
    return [
        _template_from_row(r) for r in conn.execute(
            f"SELECT * FROM scenario_templates {_TEMPLATE_NEWEST_FIRST}"
        ).fetchall()
    ]


def list_template_versions(conn: sqlite3.Connection, template_id: str) -> List[ScenarioTemplate]:
    return [
        _template_from_row(r) for r in conn.execute(
            f"SELECT * FROM scenario_templates WHERE id = ? {_TEMPLATE_NEWEST_FIRST}",
            (template_id,),
        ).fetchall()
    ]


def delete_template(conn: sqlite3.Connection, template_id: str, version: Optional[str] = None) -> bool:
    """Delete one version, or every version of ``template_id``. In-flight runs keep their
    snapshots; this only affects future runs."""
    with write_txn(conn):
        if version is None:
            cur = conn.execute("DELETE FROM scenario_templates WHERE id = ?", (template_id,))
        else:
            cur = conn.execute("DELETE FROM scenario_templates WHERE id = ? AND version = ?", (template_id, version))
    return cur.rowcount > 0


# --- Rows ---------------------------------------------------------------------

@dataclass
class ScenarioTemplate:
    id: str
    version: str
    template: dict
    created_at: int
    updated_at: int
    name: Optional[str] = None
    description: Optional[str] = None
    # Import readiness (#30, spec §6). ``readiness_status`` is 'ready' or
    # 'unavailable'; ``readiness_detail`` carries the missing profile/tool
    # reasons. A run may only start from a 'ready' template.
    readiness_status: str = "ready"
    readiness_detail: Optional[List[str]] = None

    def to_dict(self) -> dict:
        return {
            "id": self.id, "version": self.version, "name": self.name,
            "description": self.description, "template": self.template,
            "created_at": self.created_at, "updated_at": self.updated_at,
            "readiness_status": self.readiness_status, "readiness_detail": self.readiness_detail,
        }


@dataclass
class PipelineRun:
    id: str
    template_id: str
    template_version: str
    template_snapshot: dict
    template_hash: str
    status: str
    created_at: int
    updated_at: int
    current_step_id: Optional[str] = None
    next_attempt_at: Optional[int] = None
    deadline: Optional[int] = None
    step_executions: int = 0
    rework_cycles: int = 0
    inputs: Optional[dict] = None
    result: Optional[dict] = None
    error: Optional[str] = None
    error_code: Optional[str] = None
    card_id: Optional[str] = None
    started_at: Optional[int] = None
    ended_at: Optional[int] = None

    def to_dict(self) -> dict:
        return {
            "id": self.id, "template_id": self.template_id, "template_version": self.template_version,
            "template_snapshot": self.template_snapshot, "template_hash": self.template_hash,
            "status": self.status, "current_step_id": self.current_step_id,
            "next_attempt_at": self.next_attempt_at, "deadline": self.deadline,
            "step_executions": self.step_executions, "rework_cycles": self.rework_cycles,
            "inputs": self.inputs, "result": self.result,
            "error": self.error, "error_code": self.error_code, "card_id": self.card_id,
            "created_at": self.created_at, "started_at": self.started_at, "ended_at": self.ended_at,
            "updated_at": self.updated_at,
        }


@dataclass
class StepAttempt:
    id: str
    run_id: str
    step_id: str
    ordinal: int
    iteration: int
    attempt_no: int
    status: str
    created_at: int
    execution_id: Optional[str] = None
    idempotency_key: Optional[str] = None
    input_snapshot: Optional[dict] = None
    output: Optional[dict] = None
    error: Optional[str] = None
    error_code: Optional[str] = None
    lease_owner: Optional[str] = None
    lease_expires: Optional[int] = None
    started_at: Optional[int] = None
    ended_at: Optional[int] = None

    def to_dict(self) -> dict:
        return {
            "id": self.id, "run_id": self.run_id, "step_id": self.step_id,
            "ordinal": self.ordinal, "iteration": self.iteration, "attempt_no": self.attempt_no,
            "status": self.status, "execution_id": self.execution_id,
            "idempotency_key": self.idempotency_key, "input_snapshot": self.input_snapshot,
            "output": self.output, "error": self.error, "error_code": self.error_code,
            "lease_owner": self.lease_owner, "lease_expires": self.lease_expires,
            "created_at": self.created_at, "started_at": self.started_at, "ended_at": self.ended_at,
        }


@dataclass
class InputRequest:
    id: str
    run_id: str
    status: str
    created_at: int
    step_id: Optional[str] = None
    attempt_id: Optional[str] = None
    prompt: Optional[str] = None
    response_schema: Optional[dict] = None
    chat: Optional[dict] = None
    wait_timeout_seconds: Optional[int] = None
    deadline: Optional[int] = None
    accepted_response: Optional[dict] = None
    responded_at: Optional[int] = None
    closed_at: Optional[int] = None

    def to_dict(self) -> dict:
        return {
            "id": self.id, "run_id": self.run_id, "step_id": self.step_id, "attempt_id": self.attempt_id,
            "status": self.status, "prompt": self.prompt, "response_schema": self.response_schema,
            "chat": self.chat, "wait_timeout_seconds": self.wait_timeout_seconds, "deadline": self.deadline,
            "accepted_response": self.accepted_response, "responded_at": self.responded_at,
            "created_at": self.created_at, "closed_at": self.closed_at,
        }


@dataclass
class RunEvent:
    seq: int
    event_id: str
    run_id: str
    type: str
    schema_version: str
    occurred_at: int
    step_id: Optional[str] = None
    attempt_id: Optional[str] = None
    request_id: Optional[str] = None
    payload: Optional[dict] = None

    def to_dict(self) -> dict:
        return {
            "event_id": self.event_id, "schema_version": self.schema_version, "run_id": self.run_id,
            "step_id": self.step_id, "attempt_id": self.attempt_id, "request_id": self.request_id,
            "seq": self.seq, "occurred_at": self.occurred_at, "type": self.type, "payload": self.payload,
        }


@dataclass
class Artifact:
    id: str
    run_id: str
    filename: str
    size: int
    storage_ref: str
    created_at: int
    mime_type: Optional[str] = None
    checksum: Optional[str] = None
    owner: Optional[str] = None

    def to_dict(self, *, include_storage_ref: bool = False) -> dict:
        """``storage_ref`` is server-side only; the default payload never carries a filesystem
        path — the protected route resolves it (spec §12)."""
        return {
            "id": self.id, "run_id": self.run_id, "filename": self.filename,
            "mime_type": self.mime_type, "size": self.size, "checksum": self.checksum,
            "owner": self.owner, "created_at": self.created_at,
            **({"storage_ref": self.storage_ref} if include_storage_ref else {}),
        }


# --- Row loaders ----------------------------------------------------------------

def _run_from_row(row: sqlite3.Row) -> PipelineRun:
    keys = row.keys()
    return PipelineRun(
        id=row["id"], template_id=row["template_id"], template_version=row["template_version"],
        template_snapshot=json.loads(row["template_snapshot"]), template_hash=row["template_hash"],
        status=row["status"],
        current_step_id=row["current_step_id"] if "current_step_id" in keys else None,
        next_attempt_at=row["next_attempt_at"] if "next_attempt_at" in keys else None,
        deadline=row["deadline"] if "deadline" in keys else None,
        step_executions=row["step_executions"] if "step_executions" in keys else 0,
        rework_cycles=row["rework_cycles"] if "rework_cycles" in keys else 0,
        inputs=json.loads(row["inputs"]) if row["inputs"] else None,
        result=json.loads(row["result"]) if row["result"] else None,
        error=row["error"] if "error" in keys else None,
        error_code=row["error_code"] if "error_code" in keys else None,
        card_id=row["card_id"] if "card_id" in keys else None,
        created_at=row["created_at"],
        started_at=row["started_at"] if "started_at" in keys else None,
        ended_at=row["ended_at"] if "ended_at" in keys else None,
        updated_at=row["updated_at"],
    )


def _attempt_from_row(row: sqlite3.Row) -> StepAttempt:
    return StepAttempt(
        id=row["id"], run_id=row["run_id"], step_id=row["step_id"], ordinal=row["ordinal"],
        iteration=row["iteration"], attempt_no=row["attempt_no"], status=row["status"],
        execution_id=row["execution_id"], idempotency_key=row["idempotency_key"],
        input_snapshot=json.loads(row["input_snapshot"]) if row["input_snapshot"] else None,
        output=json.loads(row["output"]) if row["output"] else None,
        error=row["error"], error_code=row["error_code"],
        lease_owner=row["lease_owner"], lease_expires=row["lease_expires"],
        created_at=row["created_at"], started_at=row["started_at"], ended_at=row["ended_at"],
    )


def _request_from_row(row: sqlite3.Row) -> InputRequest:
    return InputRequest(
        id=row["id"], run_id=row["run_id"], status=row["status"], created_at=row["created_at"],
        step_id=row["step_id"], attempt_id=row["attempt_id"], prompt=row["prompt"],
        response_schema=json.loads(row["response_schema"]) if row["response_schema"] else None,
        chat=json.loads(row["chat"]) if row["chat"] else None,
        wait_timeout_seconds=row["wait_timeout_seconds"], deadline=row["deadline"],
        accepted_response=json.loads(row["accepted_response"]) if row["accepted_response"] else None,
        responded_at=row["responded_at"], closed_at=row["closed_at"],
    )


def _event_from_row(row: sqlite3.Row) -> RunEvent:
    return RunEvent(
        seq=row["seq"], event_id=row["event_id"], run_id=row["run_id"], type=row["type"],
        schema_version=row["schema_version"], occurred_at=row["occurred_at"],
        step_id=row["step_id"], attempt_id=row["attempt_id"], request_id=row["request_id"],
        payload=json.loads(row["payload"]) if row["payload"] else None,
    )


def _artifact_from_row(row: sqlite3.Row) -> Artifact:
    return Artifact(
        id=row["id"], run_id=row["run_id"], filename=row["filename"], size=row["size"],
        storage_ref=row["storage_ref"], created_at=row["created_at"], mime_type=row["mime_type"],
        checksum=row["checksum"], owner=row["owner"],
    )


def _require_run_row(conn: sqlite3.Connection, run_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM pipeline_runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        raise ValueError(f"run {run_id} not found")
    return row


def _require_attempt_row(conn: sqlite3.Connection, attempt_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM step_attempts WHERE id = ?", (attempt_id,)).fetchone()
    if row is None:
        raise ValueError(f"attempt {attempt_id} not found")
    return row


# --- Events --------------------------------------------------------------------

def append_event(
    conn: sqlite3.Connection, run_id: str, type: str, *, payload: Optional[dict] = None,
    step_id: Optional[str] = None, attempt_id: Optional[str] = None, request_id: Optional[str] = None,
    occurred_at: Optional[int] = None, event_id: Optional[str] = None, txn_open: bool = False,
) -> int:
    """Append one run event and return its ``seq``. With ``txn_open=True`` the caller owns
    the surrounding ``write_txn`` (composed state+event transitions); otherwise this is its
    own atomic txn. ``type`` must be a non-empty string; the known vocabulary is #43's and
    stays open for additive types."""
    if not isinstance(type, str) or not type.strip():
        raise ValueError("event type must be a non-empty string")
    event_id = event_id or _new_id("evt")
    occurred = occurred_at if occurred_at is not None else _now()
    params = (event_id, run_id, step_id, attempt_id, request_id, type, _dumps(payload),
              EVENT_SCHEMA_VERSION, occurred)
    insert_sql = (
        "INSERT INTO run_events (event_id, run_id, step_id, attempt_id, request_id, type, payload, "
        "schema_version, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    if txn_open:
        cur = conn.execute(insert_sql, params)
        seq = cur.lastrowid
        assert seq is not None
        return seq
    with write_txn(conn):
        _require_run_row(conn, run_id)
        cur = conn.execute(insert_sql, params)
        seq = cur.lastrowid
    assert seq is not None
    return seq


def get_event(conn: sqlite3.Connection, event_id: str) -> Optional[RunEvent]:
    row = conn.execute("SELECT * FROM run_events WHERE event_id = ?", (event_id,)).fetchone()
    return None if row is None else _event_from_row(row)


def list_events(
    conn: sqlite3.Connection, run_id: str, *, after_seq: int = 0, limit: Optional[int] = None,
) -> List[RunEvent]:
    """Events of ``run_id`` after ``after_seq`` in strictly ascending ``seq`` order — the
    catch-up read a client uses to rebuild after a break and dedupe on ``event_id``/``seq``
    (#43)."""
    sql = "SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC"
    params: list[Any] = [run_id, int(after_seq)]
    if limit is not None:
        sql += " LIMIT ?"
        params.append(int(limit))
    return [_event_from_row(r) for r in conn.execute(sql, params).fetchall()]


# --- Runs ----------------------------------------------------------------------

def create_run(
    conn: sqlite3.Connection, template: dict, *, inputs: Optional[dict] = None,
    card_id: Optional[str] = None, run_id: Optional[str] = None, now: Optional[int] = None,
) -> str:
    """Create a queued run holding an immutable snapshot of ``template`` plus its hash
    (spec §4). One card = one run; the card link lives on this side. Emits ``run.created``.
    Later edits to ``template`` (or its stored row) cannot change this run."""
    if not isinstance(template, dict):
        raise ValueError("template must be a JSON object")
    template_id, template_version = template.get("id"), template.get("version")
    if not isinstance(template_id, str) or not template_id.strip():
        raise ValueError("template.id must be a non-empty string")
    if not isinstance(template_version, str) or not template_version.strip():
        raise ValueError("template.version must be a non-empty string")
    ts = now if now is not None else _now()
    run_id = run_id or _new_id("run")
    snapshot = json.dumps(template, ensure_ascii=False, sort_keys=True)
    with write_txn(conn):
        conn.execute(
            "INSERT INTO pipeline_runs (id, template_id, template_version, template_snapshot, template_hash, "
            "status, inputs, card_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)",
            (run_id, template_id, template_version, snapshot, _template_hash(snapshot),
             _dumps(inputs), card_id, ts, ts),
        )
        append_event(conn, run_id, "run.created", payload={"template_id": template_id,
                                                           "template_version": template_version},
                     txn_open=True, occurred_at=ts)
    return run_id


def get_run(conn: sqlite3.Connection, run_id: str) -> Optional[PipelineRun]:
    row = conn.execute("SELECT * FROM pipeline_runs WHERE id = ?", (run_id,)).fetchone()
    return None if row is None else _run_from_row(row)


def list_runs(
    conn: sqlite3.Connection, *, status: Optional[str] = None, template_id: Optional[str] = None,
) -> List[PipelineRun]:
    sql, params = "SELECT * FROM pipeline_runs", []
    clauses = []
    if status is not None:
        clauses.append("status = ?")
        params.append(status)
    if template_id is not None:
        clauses.append("template_id = ?")
        params.append(template_id)
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY created_at ASC"
    return [_run_from_row(r) for r in conn.execute(sql, params).fetchall()]


def runs_for_card(conn: sqlite3.Connection, card_id: str) -> List[PipelineRun]:
    """Runs linked to a kanban card. A card holds at most one live run in MVP; history
    (cancelled/failed predecessors) stays queryable."""
    return [
        _run_from_row(r) for r in conn.execute(
            "SELECT * FROM pipeline_runs WHERE card_id = ? ORDER BY created_at ASC", (card_id,)
        ).fetchall()
    ]


def set_run_status(
    conn: sqlite3.Connection, run_id: str, status: str, *, error: Optional[str] = None,
    error_code: Optional[str] = None, payload: Optional[dict] = None, occurred_at: Optional[int] = None,
) -> int:
    """Transition the run's status and append the matching ``run.<status>`` event in ONE
    transaction (spec §7: state, sequence number and transition are written atomically).
    Returns the new event ``seq``. A terminal status stamps ``ended_at``; ``started_at`` is
    stamped on the first ``running``."""
    if status not in RUN_STATUSES:
        raise ValueError(f"invalid run status: {status!r}")
    ts = occurred_at if occurred_at is not None else _now()
    with write_txn(conn):
        row = _require_run_row(conn, run_id)
        started_at = row["started_at"]
        if status == "running" and started_at is None:
            conn.execute("UPDATE pipeline_runs SET status = ?, started_at = ?, updated_at = ? WHERE id = ?",
                         (status, ts, ts, run_id))
        else:
            conn.execute("UPDATE pipeline_runs SET status = ?, updated_at = ? WHERE id = ?",
                         (status, ts, run_id))
        if status in TERMINAL_RUN_STATUSES:
            ended = conn.execute("SELECT ended_at FROM pipeline_runs WHERE id = ?", (run_id,)).fetchone()
            if ended["ended_at"] is None:
                conn.execute("UPDATE pipeline_runs SET ended_at = ? WHERE id = ?", (ts, run_id))
        if error is not None:
            conn.execute("UPDATE pipeline_runs SET error = ?, error_code = ? WHERE id = ?",
                         (error, error_code, run_id))
        seq = append_event(conn, run_id, f"run.{status}", payload=payload, txn_open=True, occurred_at=ts)
    return seq


def set_run_scheduling(
    conn: sqlite3.Connection, run_id: str, *, next_attempt_at: Optional[int] = None,
    deadline: Optional[int] = None, current_step_id: Optional[str] = None,
) -> None:
    """Update the wait/retry bookkeeping (spec §7): ``next_attempt_at`` for deferred technical
    retries, ``deadline`` for a wait timeout, ``current_step_id`` for the step strip. ``None``
    clears a field."""
    with write_txn(conn):
        _require_run_row(conn, run_id)
        conn.execute(
            "UPDATE pipeline_runs SET next_attempt_at = ?, deadline = ?, current_step_id = ?, updated_at = ? "
            "WHERE id = ?",
            (next_attempt_at, deadline, current_step_id, _now(), run_id),
        )


def set_run_result(conn: sqlite3.Connection, run_id: str, result: dict) -> None:
    if not isinstance(result, dict):
        raise ValueError("run result must be a JSON object")
    with write_txn(conn):
        _require_run_row(conn, run_id)
        conn.execute("UPDATE pipeline_runs SET result = ?, updated_at = ? WHERE id = ?",
                     (_dumps(result), _now(), run_id))


def finish_run(
    conn: sqlite3.Connection, run_id: str, status: str, *, result: Optional[dict] = None,
    error: Optional[str] = None, error_code: Optional[str] = None, occurred_at: Optional[int] = None,
) -> int:
    """Land the run in a terminal state (``completed``/``failed``/``cancelled``) with its
    result or error, atomically with the terminal event. Late responses from cancelled/old
    attempts must not change the run afterwards (spec §14 check 9) — see
    ``require_active_run_status``."""
    if status not in TERMINAL_RUN_STATUSES:
        raise ValueError(f"finish_run requires a terminal status, got {status!r}")
    if result is not None:
        set_run_result(conn, run_id, result)
    return set_run_status(conn, run_id, status, error=error, error_code=error_code, occurred_at=occurred_at)


def require_active_run_status(conn: sqlite3.Connection, run_id: str, *active: str) -> PipelineRun:
    """The run in one of ``active`` statuses, else refused — the guard that makes a stale
    response a no-op: a late answer to a cancelled run raises instead of advancing it."""
    run = get_run(conn, run_id)
    if run is None or run.status not in active:
        raise ValueError(f"run {run_id} is {run.status if run else 'missing'}, not in {sorted(active)}")
    return run


def bump_step_executions(conn: sqlite3.Connection, run_id: str) -> int:
    """Count one step activation.

    ``create_attempt`` already does this for steps that get an attempt. A
    ``condition`` does not get one — it has no output to record — but spec §7
    counts it anyway ("max_step_executions ... including conditions"), so it
    needs its own increment rather than a fake attempt row.
    """
    with write_txn(conn):
        _require_run_row(conn, run_id)
        conn.execute("UPDATE pipeline_runs SET step_executions = step_executions + 1, updated_at = ? "
                     "WHERE id = ?", (_now(), run_id))
        row = conn.execute("SELECT step_executions FROM pipeline_runs WHERE id = ?", (run_id,)).fetchone()
    return row["step_executions"]


def bump_rework_cycles(conn: sqlite3.Connection, run_id: str) -> int:
    """Increase the rework counter (spec §7: returning for rework bumps it; the executor
    compares against ``max_rework_cycles``)."""
    with write_txn(conn):
        _require_run_row(conn, run_id)
        conn.execute("UPDATE pipeline_runs SET rework_cycles = rework_cycles + 1, updated_at = ? WHERE id = ?",
                     (_now(), run_id))
        row = conn.execute("SELECT rework_cycles FROM pipeline_runs WHERE id = ?", (run_id,)).fetchone()
    return row["rework_cycles"]


# --- Attempts --------------------------------------------------------------------

def create_attempt(
    conn: sqlite3.Connection, run_id: str, step_id: str, *, iteration: int = 0,
    attempt_no: int = 1, input_snapshot: Optional[dict] = None, idempotency_key: Optional[str] = None,
    attempt_id: Optional[str] = None, occurred_at: Optional[int] = None,
) -> str:
    """Record a queued attempt for ``step_id``. A new activation (``attempt_no == 1``) bumps
    the run's ``step_executions`` counter (spec §7: technical retries count against the
    separate retry limit, not this one) and moves ``current_step_id`` — atomically."""
    ts = occurred_at if occurred_at is not None else _now()
    attempt_id = attempt_id or _new_id("att")
    with write_txn(conn):
        _require_run_row(conn, run_id)
        ordinal = conn.execute(
            "SELECT COALESCE(MAX(ordinal), 0) + 1 FROM step_attempts WHERE run_id = ?", (run_id,)
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO step_attempts (id, run_id, step_id, ordinal, iteration, attempt_no, status, "
            "idempotency_key, input_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
            (attempt_id, run_id, step_id, ordinal, iteration, attempt_no, idempotency_key,
             _dumps(input_snapshot), ts),
        )
        if attempt_no == 1:
            conn.execute(
                "UPDATE pipeline_runs SET step_executions = step_executions + 1, current_step_id = ?, "
                "updated_at = ? WHERE id = ?", (step_id, ts, run_id),
            )
    return attempt_id


def get_attempt(conn: sqlite3.Connection, attempt_id: str) -> Optional[StepAttempt]:
    row = conn.execute("SELECT * FROM step_attempts WHERE id = ?", (attempt_id,)).fetchone()
    return None if row is None else _attempt_from_row(row)


def list_attempts(conn: sqlite3.Connection, run_id: str) -> List[StepAttempt]:
    return [
        _attempt_from_row(r) for r in conn.execute(
            "SELECT * FROM step_attempts WHERE run_id = ? ORDER BY ordinal ASC, attempt_no ASC", (run_id,)
        ).fetchall()
    ]


def start_attempt(conn: sqlite3.Connection, attempt_id: str, *, execution_id: Optional[str] = None,
                  occurred_at: Optional[int] = None) -> int:
    """Mark the attempt ``running`` with its ``execution_id`` and emit ``step.started`` —
    atomically. ``execution_id`` is what restart reconciliation checks (spec §14 check 8)."""
    ts = occurred_at if occurred_at is not None else _now()
    with write_txn(conn):
        _require_attempt_row(conn, attempt_id)
        row = conn.execute("SELECT run_id FROM step_attempts WHERE id = ?", (attempt_id,)).fetchone()
        conn.execute(
            "UPDATE step_attempts SET status = 'running', execution_id = ?, started_at = ? WHERE id = ?",
            (execution_id, ts, attempt_id),
        )
        seq = append_event(conn, row["run_id"], "step.started", step_id=_require_step_of(conn, attempt_id),
                           attempt_id=attempt_id, payload={"execution_id": execution_id},
                           txn_open=True, occurred_at=ts)
    return seq


def _require_step_of(conn: sqlite3.Connection, attempt_id: str) -> Optional[str]:
    row = conn.execute("SELECT step_id FROM step_attempts WHERE id = ?", (attempt_id,)).fetchone()
    return row["step_id"] if row else None


def finish_attempt(
    conn: sqlite3.Connection, attempt_id: str, status: str, *, output: Optional[dict] = None,
    error: Optional[str] = None, error_code: Optional[str] = None, occurred_at: Optional[int] = None,
) -> int:
    """Land the attempt in a terminal-or-``unknown`` state with its output or error, and emit
    the matching ``step.<status>`` event, atomically. ``unknown`` records that the outcome of
    the external call could not be established (restart reconciliation, spec §7)."""
    if status not in ATTEMPT_STATUSES - {"queued", "running", "waiting_input"}:
        raise ValueError(f"finish_attempt requires a terminal or unknown status, got {status!r}")
    ts = occurred_at if occurred_at is not None else _now()
    with write_txn(conn):
        row = _require_attempt_row(conn, attempt_id)
        conn.execute(
            "UPDATE step_attempts SET status = ?, output = ?, error = ?, error_code = ?, ended_at = ? WHERE id = ?",
            (status, _dumps(output), error, error_code, ts, attempt_id),
        )
        event_type = "step.completed" if status == "completed" else "step.failed"
        seq = append_event(conn, row["run_id"], event_type,
                           step_id=row["step_id"], attempt_id=attempt_id,
                           payload={"status": status, "error_code": error_code},
                           txn_open=True, occurred_at=ts)
    return seq


# --- Leases -------------------------------------------------------------------------

def claim_attempt(
    conn: sqlite3.Connection, attempt_id: str, owner: str, *, ttl_seconds: int = 60,
    now: Optional[int] = None,
) -> bool:
    """Take the attempt's execution lease, or report that someone else holds it.

    Spec §7: a lease with a heartbeat and an owner check is what stops two
    dispatchers running one run at the same time. ``False`` means either another
    live owner holds it, or — the case that matters on restart — the recorded
    owner is gone and the lease has expired, in which case the caller is
    entitled to take it.

    Re-claiming a lease we already hold succeeds, so a dispatcher that lost its
    own connection mid-step can resume rather than deadlock against its
    previous self.
    """
    if not owner:
        raise ValueError("lease owner must be a non-empty string")
    ts = now if now is not None else _now()
    expires = ts + int(ttl_seconds)
    with write_txn(conn):
        row = _require_attempt_row(conn, attempt_id)
        held, held_until = row["lease_owner"], row["lease_expires"]
        if held is not None and held != owner and (held_until is None or held_until > ts):
            return False
        conn.execute(
            "UPDATE step_attempts SET lease_owner = ?, lease_expires = ? WHERE id = ?",
            (owner, expires, attempt_id),
        )
    return True


def heartbeat_attempt(
    conn: sqlite3.Connection, attempt_id: str, owner: str, *, ttl_seconds: int = 60,
    now: Optional[int] = None,
) -> bool:
    """Extend a lease we hold; ``False`` if we no longer hold it.

    A heartbeat that returns ``False`` is the signal to stop working on the
    step: another dispatcher has taken over, and continuing would be the exact
    double-execution the lease exists to prevent.
    """
    ts = now if now is not None else _now()
    with write_txn(conn):
        row = _require_attempt_row(conn, attempt_id)
        if row["lease_owner"] != owner:
            return False
        conn.execute("UPDATE step_attempts SET lease_expires = ? WHERE id = ?",
                     (ts + int(ttl_seconds), attempt_id))
    return True


def release_attempt(conn: sqlite3.Connection, attempt_id: str, owner: str) -> bool:
    """Drop the lease if we still hold it. ``False`` if someone else took it."""
    with write_txn(conn):
        row = _require_attempt_row(conn, attempt_id)
        if row["lease_owner"] != owner:
            return False
        conn.execute("UPDATE step_attempts SET lease_owner = NULL, lease_expires = NULL WHERE id = ?",
                     (attempt_id,))
    return True


# --- Input requests ---------------------------------------------------------------

def open_input_request(
    conn: sqlite3.Connection, run_id: str, step_id: str, attempt_id: str, *, prompt: str,
    response_schema: Optional[dict] = None, chat: Optional[dict] = None,
    wait_timeout_seconds: Optional[int] = None, request_id: Optional[str] = None,
    occurred_at: Optional[int] = None,
) -> str:
    """Open an InputRequest and put the run into ``waiting_input`` — one transaction, so the
    run can never be ``waiting_input`` without its request row (or the reverse). Any still
    open request of the same run is invalidated first: one run executes one active step in
    MVP (spec §7), so a repeated user_input step — a retry or a rework return — creates a
    new ``request_id`` and kills the old one. Waiting occupies no worker and issues no LLM
    calls; the deadline (when any) is the executor's timer, not a poll loop."""
    ts = occurred_at if occurred_at is not None else _now()
    request_id = request_id or _new_id("req")
    deadline = ts + wait_timeout_seconds if wait_timeout_seconds is not None else None
    with write_txn(conn):
        _require_run_row(conn, run_id)
        _require_attempt_row(conn, attempt_id)
        conn.execute(
            "UPDATE input_requests SET status = 'invalidated', closed_at = ? "
            "WHERE run_id = ? AND status = 'open'", (ts, run_id),
        )
        conn.execute(
            "INSERT INTO input_requests (id, run_id, step_id, attempt_id, status, prompt, response_schema, "
            "chat, wait_timeout_seconds, deadline, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)",
            (request_id, run_id, step_id, attempt_id, prompt, _dumps(response_schema), _dumps(chat),
             wait_timeout_seconds, deadline, ts),
        )
        conn.execute("UPDATE pipeline_runs SET status = 'waiting_input', updated_at = ? WHERE id = ?",
                     (ts, run_id))
        append_event(conn, run_id, "input.requested", step_id=step_id, attempt_id=attempt_id,
                     request_id=request_id, payload={"prompt": prompt, "deadline": deadline},
                     txn_open=True, occurred_at=ts)
    return request_id


def get_input_request(conn: sqlite3.Connection, request_id: str) -> Optional[InputRequest]:
    row = conn.execute("SELECT * FROM input_requests WHERE id = ?", (request_id,)).fetchone()
    return None if row is None else _request_from_row(row)


def list_input_requests(
    conn: sqlite3.Connection, run_id: str, *, status: Optional[str] = None,
) -> List[InputRequest]:
    sql, params = "SELECT * FROM input_requests WHERE run_id = ?", [run_id]
    if status is not None:
        sql += " AND status = ?"
        params.append(status)
    sql += " ORDER BY created_at ASC"
    return [_request_from_row(r) for r in conn.execute(sql, params).fetchall()]


def answer_input_request(
    conn: sqlite3.Connection, request_id: str, response: dict, *, responded_by: Optional[str] = None,
    occurred_at: Optional[int] = None,
) -> InputRequest:
    """Accept the first response for an open request, atomically with the ``input.received``
    event: record the accepted response, ``responded_at`` and ``closed_at`` (spec §12). A
    replay or a race on the same request_id is refused — only an ``open`` request accepts;
    an already-answered, invalidated, expired or cancelled request raises. Advancing the run
    stays in the executor's transaction (#32/#44), which reads the accepted response here."""
    if not isinstance(response, dict):
        raise ValueError("response must be a JSON object")
    ts = occurred_at if occurred_at is not None else _now()
    with write_txn(conn):
        row = conn.execute("SELECT * FROM input_requests WHERE id = ?", (request_id,)).fetchone()
        if row is None:
            raise ValueError(f"input request {request_id} not found")
        if row["status"] != "open":
            raise ValueError(
                f"input request {request_id} is {row['status']}, only an open request accepts a response"
            )
        conn.execute(
            "UPDATE input_requests SET status = 'answered', accepted_response = ?, responded_at = ?, "
            "closed_at = ? WHERE id = ?",
            (_dumps(response), ts, ts, request_id),
        )
        append_event(conn, row["run_id"], "input.received", step_id=row["step_id"],
                     attempt_id=row["attempt_id"], request_id=request_id,
                     payload={"responded_by": responded_by}, txn_open=True, occurred_at=ts)
    answered = get_input_request(conn, request_id)
    assert answered is not None
    return answered


def expire_input_deadlines(conn: sqlite3.Connection, *, now: Optional[int] = None) -> list[str]:
    """Fail runs whose ``user_input`` wait hit its deadline.

    ``waiting_input`` holds no worker, so nothing is around to notice the
    deadline passing — the executor's rule that no transaction spans a model
    call is also why there is no timer thread. The deadline is a stored
    timestamp and this sweep is what acts on it; it is idempotent and safe to
    call from a tick, a request, or a test.

    Only a run with a stored deadline expires. ``wait_timeout_seconds: null``
    means "wait as long as it takes" and must never be swept.
    """
    ts = now if now is not None else _now()
    expired: list[str] = []
    rows = conn.execute(
        "SELECT id, current_step_id FROM pipeline_runs "
        "WHERE status = 'waiting_input' AND deadline IS NOT NULL AND deadline <= ?",
        (ts,),
    ).fetchall()
    for row in rows:
        run_id = row["id"]
        with write_txn(conn):
            # Re-read under the write lock: a response may have landed between
            # the scan and here, and an answered run must not be failed.
            current = conn.execute(
                "SELECT status, deadline FROM pipeline_runs WHERE id = ?", (run_id,),
            ).fetchone()
            if current is None or current["status"] != "waiting_input":
                continue
            if current["deadline"] is None or current["deadline"] > ts:
                continue
            closed = conn.execute(
                "UPDATE input_requests SET status = 'expired', closed_at = ? "
                "WHERE run_id = ? AND status = 'open'", (ts, run_id),
            ).rowcount
            # The UPDATE is written out rather than delegated to
            # finish_attempt: that helper opens its own write_txn, and
            # sqlite_util.write_txn does not nest. The event is appended with
            # txn_open=True so the attempt failure and the run failure land in
            # this one transaction.
            waiting = conn.execute(
                "SELECT id FROM step_attempts WHERE run_id = ? AND status = 'waiting_input'",
                (run_id,),
            ).fetchall()
            for attempt in waiting:
                conn.execute(
                    "UPDATE step_attempts SET status = 'failed', error = ?, error_code = ?, ended_at = ? "
                    "WHERE id = ?", ("input_timeout", "input_timeout", ts, attempt["id"]),
                )
                append_event(conn, run_id, "step.failed", step_id=row["current_step_id"],
                             attempt_id=attempt["id"],
                             payload={"error": "input_timeout", "error_code": "input_timeout"},
                             txn_open=True, occurred_at=ts)
            conn.execute(
                "UPDATE pipeline_runs SET status = 'failed', error = ?, error_code = 'input_timeout', "
                "updated_at = ? WHERE id = ?",
                (f"no response by the deadline on step {row['current_step_id']!r}", ts, run_id),
            )
            append_event(conn, run_id, "input.expired", step_id=row["current_step_id"],
                         payload={"requests_expired": closed, "deadline": current["deadline"]},
                         txn_open=True, occurred_at=ts)
        expired.append(run_id)
    return expired


def invalidate_input_requests(
    conn: sqlite3.Connection, *, run_id: Optional[str] = None, attempt_id: Optional[str] = None,
    status: str = "invalidated", reason: Optional[str] = None, occurred_at: Optional[int] = None,
) -> int:
    """Close still-open requests (Stop, timeout, retry). ``status`` is one of
    ``expired``/``invalidated``/``cancelled``. Returns the number closed."""
    if status not in {"expired", "invalidated", "cancelled"}:
        raise ValueError(f"invalid closed status: {status!r}")
    ts = occurred_at if occurred_at is not None else _now()
    clauses, params = ["status = 'open'"], []
    if run_id is not None:
        clauses.append("run_id = ?")
        params.append(run_id)
    if attempt_id is not None:
        clauses.append("attempt_id = ?")
        params.append(attempt_id)
    with write_txn(conn):
        cur = conn.execute(
            f"UPDATE input_requests SET status = ?, closed_at = ? WHERE {' AND '.join(clauses)}",
            [status, ts, *params],
        )
        closed = cur.rowcount
        if closed and run_id is not None:
            append_event(conn, run_id, "input.message", request_id=None,
                         payload={"invalidated": closed, "reason": reason or status},
                         txn_open=True, occurred_at=ts)
    return closed


# --- Artifacts ----------------------------------------------------------------------

def register_artifact(
    conn: sqlite3.Connection, run_id: str, *, filename: str, storage_ref: str, size: int,
    mime_type: Optional[str] = None, checksum: Optional[str] = None, owner: Optional[str] = None,
    artifact_id: Optional[str] = None, occurred_at: Optional[int] = None,
) -> str:
    """Record an artefact: metadata + a RELATIVE storage reference under ``artifacts_root()``
    (spec §12: metadata apart from large JSON columns; served through a protected route,
    never a raw filesystem path). ``owner`` is the scope that may read it — the external
    credential's scope format lands with #42; until then it is informational."""
    if not isinstance(filename, str) or not filename.strip():
        raise ValueError("artifact filename must be a non-empty string")
    if not isinstance(storage_ref, str) or not storage_ref.strip():
        raise ValueError("storage_ref must be a non-empty string")
    if Path(storage_ref).is_absolute() or ".." in Path(storage_ref).parts:
        raise ValueError("storage_ref must be relative and cannot traverse upward")
    ts = occurred_at if occurred_at is not None else _now()
    artifact_id = artifact_id or _new_id("art")
    with write_txn(conn):
        _require_run_row(conn, run_id)
        conn.execute(
            "INSERT INTO artifacts (id, run_id, filename, mime_type, size, checksum, owner, storage_ref, "
            "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (artifact_id, run_id, filename, mime_type, int(size), checksum, owner, storage_ref, ts),
        )
    return artifact_id


def list_artifacts(conn: sqlite3.Connection, run_id: str) -> List[Artifact]:
    return [
        _artifact_from_row(r) for r in conn.execute(
            "SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC", (run_id,)
        ).fetchall()
    ]
