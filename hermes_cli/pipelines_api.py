"""Pipeline API — run control and the ``user_input`` response surface (spec §7, §10, §11).

Mounted at ``/api/pipelines`` in core, alongside ``/api/kanban``.

Scope note, because the placement was a real decision. ``/api/kanban`` moved
into core the same way, and the reason carries over: these routes are the
product, not a plugin's, and #41/#42 (Idempotency-Key, per-run ownership) are
written against this prefix.

What this surface deliberately does *not* do is run anything. A run is created
here and is advanced by the executor's dispatcher, which owns the adapter and
the lease. Putting a model call behind a request handler would put one inside
an HTTP timeout and outside the lease, and the run would be left ``running``
with nobody able to reconcile it — the exact shape ``recover`` exists to clean
up. So the write routes mutate state and return; execution is the dispatcher's
job.

On ``Idempotency-Key``: the response route does not need one to be safe, because
accepting a response is a compare-and-set on ``status = 'open'`` — a duplicate
submit loses the race and gets a 409, not a second advance. Durable key storage
for *run creation* is #41 and is not faked here: there is no key table yet, and
accepting a header without honouring it would be worse than not taking one.
"""

from __future__ import annotations

import json
import logging
import hashlib
import json
import sqlite3
import time
from contextlib import closing
from typing import Any, Optional

from fastapi import APIRouter, Body, Header, HTTPException, Query, Response

from gateway.platforms.api_server_run_idempotency import RunIdempotencyStore
from pydantic import BaseModel, Field

from hermes_cli import pipelines_db as db
from hermes_cli.pipeline_template import response_schema_errors, validate_template

log = logging.getLogger(__name__)

router = APIRouter()


def _connect() -> sqlite3.Connection:
    return db.connect()


# --- Idempotency-Key (#41) ------------------------------------------------
#
# This is a port, not a build. The gateway already has a durable store with the
# exact semantics the spec wants: rows keyed (scope, key, fingerprint), a replay
# classified `reused` on a fingerprint match and `conflict` on a mismatch via
# hmac.compare_digest, and fingerprints and public status only — never request
# bodies or credentials, which section 12 independently requires. Reimplementing
# it would be a second store to keep in step with the first, so this reuses it.
#
# What is adapted: the scope. The gateway keys by authenticated principal; the
# dashboard surface has no such principal, so the scope is the operation itself,
# which is what keeps a key from one operation from colliding with another.

_IDEMPOTENCY_STORE: Optional["RunIdempotencyStore"] = None
_IDEMPOTENCY_STORE_PATH: Optional[str] = None


def _idempotency_store() -> "RunIdempotencyStore":
    """The shared store, created on first use.

    Deliberately not process state: the whole point of the donor store is that a
    replay survives a restart, and an in-process cache would be a different,
    weaker guarantee wearing its name.

    It is cached against the path it was opened for, not just once per process.
    A bare ``if store is None`` would keep serving whichever home opened the
    store first, which hands a later caller a store for a database that is no
    longer the one it is writing to.
    """
    global _IDEMPOTENCY_STORE, _IDEMPOTENCY_STORE_PATH
    path = str(db.pipelines_data_root() / "runs_idempotency.db")
    if _IDEMPOTENCY_STORE is None or _IDEMPOTENCY_STORE_PATH != path:
        _IDEMPOTENCY_STORE = RunIdempotencyStore(db_path=path)
        _IDEMPOTENCY_STORE_PATH = path
    return _IDEMPOTENCY_STORE


def _fingerprint(payload: Any) -> str:
    """A stable digest of the request body.

    Canonical JSON (sorted keys, no whitespace) so that two byte-different but
    semantically identical bodies do not read as a conflict, then hashed rather
    than stored: the row keeps a fingerprint, so the request body is not retained
    anywhere.
    """
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _reserve(scope: str, key: str, payload: Any, run_id: str, status: dict) -> tuple[str, dict]:
    """Reserve an idempotency key, returning ``(outcome, stored_record)``.

    Outcomes are the donor's: ``created`` for a fresh key, ``reused`` when the
    same key carries the same payload (replay the stored result), ``conflict``
    when it carries a different one (409). The whole record is returned because
    a replay has to name the run the key originally admitted.
    """
    return _idempotency_store().reserve(scope, key, _fingerprint(payload), run_id, status)


def _template_errors(errors) -> list[dict]:
    """``validate_template`` returns ``TemplateError`` dataclasses.

    Putting them straight into an ``HTTPException`` detail yields an
    unserialisable body and a 500 on the one request that exists to explain a
    problem, so they are converted here rather than at every call site.
    """
    return [{"path": getattr(e, "path", "$"), "message": getattr(e, "message", str(e))}
            for e in errors]


def _not_found(kind: str, ident: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"{kind} {ident} not found")


# --- bodies ----------------------------------------------------------------


class SubmitResponseBody(BaseModel):
    response: dict[str, Any] = Field(default_factory=dict)
    responded_by: Optional[str] = None


class CreateRunBody(BaseModel):
    template_id: str
    version: Optional[str] = None
    inputs: dict[str, Any] = Field(default_factory=dict)
    title: Optional[str] = None


class StoreTemplateBody(BaseModel):
    template: dict[str, Any]


# --- helpers ---------------------------------------------------------------


def _template_detail(template_id: str, version: Optional[str]) -> dict:
    conn = _connect()
    with closing(conn):
        # `get_template` with no version already means "latest".
        row = db.get_template(conn, template_id, version)
    if row is None:
        raise _not_found("template", template_id if version is None else f"{template_id}@{version}")
    # `to_dict` already renders the row, including readiness; duplicating the
    # field list here is how the two drift apart.
    return row.to_dict()


def _run_detail(run_id: str) -> dict:
    """The run plus what a client needs to render and to answer a prompt."""
    conn = _connect()
    with closing(conn):
        # Act on a passed deadline before reporting: a client that polls must
        # not see a run that is already past due and still claims to be waiting.
        db.expire_input_deadlines(conn)
        run = db.get_run(conn, run_id)
        if run is None:
            raise _not_found("run", run_id)
        attempts = [a for a in db.list_attempts(conn, run_id)]
        requests = [r for r in db.list_input_requests(conn, run_id)]
        events = [e for e in db.list_events(conn, run_id)][-50:]
    return {
        "id": run.id,
        "template_id": run.template_id,
        "template_version": run.template_version,
        "status": run.status,
        "current_step_id": run.current_step_id,
        "error": run.error,
        "error_code": run.error_code,
        "result": run.result,
        "inputs": run.inputs,
        "deadline": run.deadline,
        "next_attempt_at": run.next_attempt_at,
        "rework_cycles": run.rework_cycles,
        "step_executions": run.step_executions,
        "created_at": run.created_at,
        "updated_at": run.updated_at,
        "attempts": [
            {"id": a.id, "step_id": a.step_id, "attempt_no": a.attempt_no, "status": a.status,
             "error": a.error, "error_code": a.error_code, "output": a.output,
             "execution_id": a.execution_id, "started_at": a.started_at, "ended_at": a.ended_at,
             "lease_owner": a.lease_owner, "lease_expires": a.lease_expires}
            for a in attempts
        ],
        "input_requests": [
            {"id": r.id, "step_id": r.step_id, "attempt_id": r.attempt_id, "status": r.status,
             "prompt": r.prompt, "response_schema": r.response_schema, "chat": r.chat,
             "wait_timeout_seconds": r.wait_timeout_seconds, "deadline": r.deadline,
             "accepted_response": r.accepted_response, "responded_at": r.responded_at,
             "closed_at": r.closed_at, "created_at": r.created_at}
            for r in requests
        ],
        "events": [
            {"seq": e.seq, "event_id": e.event_id, "type": e.type, "step_id": e.step_id,
             "attempt_id": e.attempt_id, "request_id": e.request_id, "payload": e.payload,
             "occurred_at": e.occurred_at}
            for e in events
        ],
    }


# --- templates -------------------------------------------------------------


@router.get("/templates")
def list_templates() -> dict:
    conn = _connect()
    with closing(conn):
        templates = db.list_templates(conn)
    return {"templates": [t.to_dict() for t in templates]}


@router.get("/templates/{template_id}")
def get_template(template_id: str, version: Optional[str] = Query(default=None)) -> dict:
    return _template_detail(template_id, version)


@router.get("/templates/{template_id}/versions")
def list_template_versions(template_id: str) -> dict:
    conn = _connect()
    with closing(conn):
        versions = [t.version for t in db.list_template_versions(conn, template_id)]
        if not versions and db.get_template(conn, template_id) is None:
            raise _not_found("template", template_id)
    return {"id": template_id, "versions": versions}


@router.post("/templates")
def store_template(body: StoreTemplateBody) -> dict:
    """Store a template after validating it.

    Validation is the point of the round trip: an author needs to know the JSON
    is runnable *before* it reaches a run, and the same ``validate_template``
    the executor relies on is what answers, so a template that validates here
    is a template the executor will accept.
    """
    errors = validate_template(body.template)
    if errors:
        raise HTTPException(
            status_code=422,
            detail={"message": "template is not valid", "errors": _template_errors(errors)},
        )
    conn = _connect()
    with closing(conn):
        db.import_template(conn, body.template)
    return _template_detail(body.template["id"], body.template["version"])


@router.post("/templates/validate")
def validate_only(body: StoreTemplateBody) -> dict:
    """Validate without storing — the editor's live check."""
    errors = validate_template(body.template)
    return {"valid": not errors, "errors": _template_errors(errors)}


# --- runs ------------------------------------------------------------------


@router.post("/runs")
def create_run(body: CreateRunBody, response: Response, idempotency_key: str | None = Header(None)) -> dict:
    """Create a run. ``Idempotency-Key`` is required (spec §12).

    Required rather than optional because the alternative is a caller with no way
    to tell a lost response from a lost run, retrying into a second run and a
    second card. A missing key is 400, not a silent pass-through.
    """
    if not idempotency_key or not idempotency_key.strip():
        raise HTTPException(status_code=400,
                            detail={"message": "Idempotency-Key header is required to create a run"})
    key = idempotency_key.strip()
    scope = "pipelines:run"

    conn = _connect()
    with closing(conn):
        row = db.get_template(conn, body.template_id, body.version)
        if row is None:
            raise _not_found("template", body.template_id if body.version else f"{body.template_id}@{body.version}")
        if row.readiness_status != "ready":
            # A stored-but-unavailable template may exist and must not be runnable.
            raise HTTPException(
                status_code=409,
                detail={"message": "template is not runnable",
                        "readiness": row.readiness_status, "detail": row.readiness_detail},
            )
        errors = validate_template(row.template)
        if errors:
            raise HTTPException(status_code=422,
                                detail={"message": "stored template no longer validates",
                                        "errors": _template_errors(errors)})
        run_id = db.create_run(conn, row.template, inputs=body.inputs)
        # Reserved after the run exists, following the gateway: a reservation is
        # keyed on the run it admitted, and `reserve` will not rewrite an
        # existing row, so reserving against a placeholder id would both lose the
        # real run id and collide on the store's UNIQUE(run_id) index the moment
        # a second key arrived. The loser is rolled back below.
        outcome, stored = _reserve(scope, key, body.model_dump(), run_id,
                                   {"status": "queued", "template_id": body.template_id})
        if outcome != "created":
            db.delete_unstarted_run(conn, run_id)
            if outcome == "conflict":
                raise HTTPException(
                    status_code=409,
                    detail={"message": "Idempotency-Key was already used with a different payload"})
            # A replay returns the originally admitted run, not a second one.
            replayed = _run_detail(stored["run_id"]) if stored.get("run_id") else stored.get("status", {})
            response.status_code = 200
            response.headers["Idempotency-Key"] = key
            return replayed
        detail = _run_detail(run_id)
    response.status_code = 201
    response.headers["Idempotency-Key"] = key
    return detail


@router.get("/runs/{run_id}")
def get_run(run_id: str) -> dict:
    return _run_detail(run_id)


# --- the response surface --------------------------------------------------


@router.post("/runs/{run_id}/input-requests/{request_id}/response")
def submit_input_response(run_id: str, request_id: str, body: SubmitResponseBody,
                          idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key")) -> dict:
    """Answer an open ``user_input`` request.

    Three outcomes, and which one you get is the whole contract:

    * **422** — the response does not match the step's ``response_schema``. The
      body names the JSON path of each offending field, and the request stays
      ``open``: a wrong answer is not an answer, and closing the request on a
      typo would force a re-run to get it right.
    * **409** — the request is answered, invalidated, expired or cancelled.
      Only an ``open`` request accepts, so a late duplicate or a superseded
      request is refused rather than silently applied to a run that has moved on.
    * **200** — accepted.

    This route records the response and nothing else. Advancing the next step is
    the executor's job, taken under the step's lease; a second caller cannot
    advance the run twice because the ``status = 'open'`` compare-and-set admits
    exactly one of them, and the loser's 409 says which request already won.
    """
    # The donor's store holds UNIQUE(run_id) across the whole table, and run
    # creation already reserved the pipeline run's own id. A response is
    # therefore reserved under a distinct, request-scoped identity.
    reservation_id = f"input:{request_id}"
    if idempotency_key and idempotency_key.strip():
        # lookup, not reserve: the pre-check must not consume the key, because
        # the reservation written at the end carries the real result and
        # `reserve` will not rewrite an existing row.
        outcome, record = _idempotency_store().lookup(
            f"pipelines:response:{run_id}", idempotency_key.strip(),
            _fingerprint(body.model_dump()))
        if outcome == "conflict":
            raise HTTPException(
                status_code=409,
                detail={"message": "Idempotency-Key was already used with a different payload",
                        "request_id": request_id})
        if outcome == "reused":
            # A legitimate retry of an accepted response. The request is closed
            # by now, so without this the caller would get a 409 that looks like
            # a conflict when it is in fact a replay.
            return {"request_id": request_id,
                    "status": record["status"].get("status"),
                    "accepted_response": record["status"].get("accepted_response"),
                    "responded_at": record["status"].get("responded_at"),
                    "replayed": True}

    conn = _connect()
    with closing(conn):
        db.expire_input_deadlines(conn)
        request = db.get_input_request(conn, request_id)
        if request is None or request.run_id != run_id:
            raise _not_found("input request", request_id)

        # 409 before 422: a closed request is closed whatever the payload says.
        # Reporting a schema error on a superseded request would invite the
        # caller to fix a message that will never be read.
        if request.status != "open":
            raise HTTPException(
                status_code=409,
                detail={"message": f"input request is {request.status}, only an open request accepts a response",
                        "request_id": request_id, "status": request.status},
            )

        errors = response_schema_errors(body.response, request.response_schema)
        if errors:
            raise HTTPException(
                status_code=422,
                detail={"message": "response does not match the step's response_schema",
                        "errors": errors, "request_id": request_id, "still_open": True},
            )

        try:
            accepted = db.answer_input_request(
                conn, request_id, body.response, responded_by=body.responded_by,
            )
        except ValueError as exc:
            # Lost the compare-and-set to a concurrent submit between the read
            # above and this write. The loser must be told so, not 500.
            raise HTTPException(
                status_code=409,
                detail={"message": str(exc), "request_id": request_id},
            ) from exc
        run = db.get_run(conn, run_id)
    result = {
        "request_id": request_id,
        "status": accepted.status,
        "accepted_response": accepted.accepted_response,
        "responded_at": accepted.responded_at,
        "run_status": run.status if run else None,
        "current_step_id": run.current_step_id if run else None,
        "deadline": run.deadline if run else None,
    }
    if idempotency_key and idempotency_key.strip():
        # Recorded after acceptance, and stored as the *result* so a replay can
        # return it verbatim. Only the public outcome is kept — never the body.
        _reserve(f"pipelines:response:{run_id}", idempotency_key.strip(),
                 body.model_dump(), reservation_id,
                 {"status": accepted.status, "accepted_response": accepted.accepted_response,
                  "responded_at": accepted.responded_at})
    return result


@router.get("/runs/{run_id}/events")
def run_events(run_id: str, after_seq: int = Query(default=0)) -> dict:
    conn = _connect()
    with closing(conn):
        if db.get_run(conn, run_id) is None:
            raise _not_found("run", run_id)
        events = db.list_events(conn, run_id, after_seq=after_seq)
    return {
        "events": [
            {"seq": e.seq, "event_id": e.event_id, "type": e.type, "step_id": e.step_id,
             "attempt_id": e.attempt_id, "request_id": e.request_id, "payload": e.payload,
             "occurred_at": e.occurred_at}
            for e in events
        ],
    }


@router.post("/maintenance/expire-inputs")
def expire_inputs(now: Optional[int] = Query(default=None)) -> dict:
    """Run the deadline sweep on demand.

    Idempotent, and safe to call from anywhere: the poll that renders the board
    calls it, so a run past its deadline stops presenting itself as waiting
    even if no dispatcher is running.
    """
    conn = _connect()
    with closing(conn):
        expired = db.expire_input_deadlines(conn, now=now)
    return {"expired": expired, "count": len(expired), "at": int(time.time())}
