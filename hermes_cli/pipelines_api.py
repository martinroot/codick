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
import hmac
import json
import sqlite3
import time
from contextlib import closing
from typing import Any, Optional

from fastapi import (APIRouter, Body, Depends, Header, HTTPException, Query, Request,
                      Response)

from gateway.platforms.api_server_run_idempotency import RunIdempotencyStore
from pydantic import BaseModel, Field

from hermes_cli import pipeline_board
from hermes_cli import pipeline_credentials as credentials
from hermes_cli import pipelines_db as db
from hermes_cli.pipeline_template import response_schema_errors, validate_template

log = logging.getLogger(__name__)

# --- per-run ownership (#42) ----------------------------------------------
#
# The gateway's property, kept verbatim: run state that exists without an owner
# stamp is an unanswered authorisation question, not a run anyone may control.
# Admitting it would make the boundary allow-all. So this refuses, and the
# refusal is what the negative tests pin.
#
# Requests and artifacts are reachable only through their run, so they inherit
# the run's owner and are not separately stamped; a request_id belonging to
# another run is refused by the same check, which is why a forged id is not a
# way around it.

# The dashboard's own session token is one shared secret and therefore one
# principal, so it maps to a reserved local scope. It is not a credential in
# the table and can never be presented to another site.
LOCAL_SCOPE = "local"


def request_owns_run(conn: sqlite3.Connection, run_id: str, scope: Optional[str]) -> bool:
    """Whether ``scope`` owns ``run_id``. Denies when the run has no owner."""
    if not scope:
        return False
    row = conn.execute(
        "SELECT owner_scope FROM pipeline_runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        return False
    return row["owner_scope"] is not None and hmac.compare_digest(row["owner_scope"], scope)


def _authenticate(request: Request) -> str:
    """Router-level: every route needs a valid credential.

    Authentication is not authorisation. This only establishes *who* is asking;
    whether that principal may touch a given run is a separate check that the
    run-scoped routes make themselves, because that check needs the run id.
    """
    cached = getattr(request.state, "pipeline_scope", None)
    if cached is None:
        cached = _scope_for_request(request)
        request.state.pipeline_scope = cached
    return cached


def _scope_for_request(request: Request) -> str:
    """The scope this request is acting as, or a 401.

    A bearer credential is the external path. The dashboard's session token is
    accepted for the local scope only, so the SPA keeps working without being
    able to present itself as anyone else.
    """
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        presented = header[7:].strip()
        conn = _connect()
        with closing(conn):
            credentials.ensure_schema(conn)
            conn.commit()
            scope = credentials.resolve_scope(conn, presented)
        if not scope:
            # Unknown, revoked, expired and malformed are one answer. Telling them
            # apart is a free oracle.
            raise HTTPException(status_code=401, detail={"message": "credential is not valid"})
        return scope
    from hermes_cli.web_server import _has_valid_session_token
    if _has_valid_session_token(request):
        return LOCAL_SCOPE
    raise HTTPException(status_code=401, detail={"message": "no credential presented"})


def _require_owned_run(conn: sqlite3.Connection, run_id: str, scope: str) -> None:
    """404 for a run you do not own, not 403.

    A 403 confirms the run exists, which is itself an answer about someone
    else's data. 404 is what a caller who cannot see the run should get.
    """
    if not request_owns_run(conn, run_id, scope):
        raise _not_found("run", run_id)


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
        # The card this run is anchored to. The board's panel needs it to move
        # the selection across to the card it just made.
        "card_id": run.card_id,
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


# Declared after the auth helpers, so the dependency resolves at import time,
# and before the first route, which every route decorator needs.
router = APIRouter(dependencies=[Depends(_authenticate)])


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
def create_run(body: CreateRunBody, response: Response, request: Request,
               idempotency_key: str | None = Header(None)) -> dict:
    """Create a run. ``Idempotency-Key`` is required (spec §12).

    Required rather than optional because the alternative is a caller with no way
    to tell a lost response from a lost run, retrying into a second run and a
    second card. A missing key is 400, not a silent pass-through.
    """
    if not idempotency_key or not idempotency_key.strip():
        raise HTTPException(status_code=400,
                            detail={"message": "Idempotency-Key header is required to create a run"})
    key = idempotency_key.strip()
    caller_scope = _scope_for_request(request)
    idem_scope = "pipelines:run"

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
        # The card and the run are created as one operation, not a run with a
        # card attached later: spec §9 says a card without a run, or a run
        # without a card, is a broken pair, and this is the route the board's Run
        # button actually calls.
        try:
            started = pipeline_board.start_run_with_card(
                conn, template=row.template, inputs=body.inputs,
                owner_scope=caller_scope, idempotency_key=None)
        except pipeline_board.StartError as exc:
            raise HTTPException(status_code=500, detail={"message": str(exc)}) from exc
        except ValueError as exc:
            # start_run_with_card re-validates; a stored template that has since
            # stopped validating is the caller's 422, not a 500.
            raise HTTPException(
                status_code=422,
                detail={"message": "template does not validate", "errors": [
                    {"path": "$", "message": str(exc)}]}) from exc
        run_id = started["run_id"]
        # Reserved after the run exists, following the gateway: a reservation is
        # keyed on the run it admitted, and `reserve` will not rewrite an
        # existing row, so reserving against a placeholder id would both lose the
        # real run id and collide on the store's UNIQUE(run_id) index the moment
        # a second key arrived. The loser is rolled back below.
        outcome, stored = _reserve(idem_scope, key, body.model_dump(), run_id,
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
def get_run(run_id: str, request: Request) -> dict:
    scope = _scope_for_request(request)
    conn = _connect()
    with closing(conn):
        _require_owned_run(conn, run_id, scope)
    return _run_detail(run_id)


# --- credentials (#42) -----------------------------------------------------
#
# Operator-only, and deliberately not on the read path of a run: a credential
# is minted by a human or a provisioning job, never fetched by a client. The
# plaintext appears in exactly one response — the create — and there is no
# route that returns it again, because the table stores a hash and not a secret.


class CreateCredentialBody(BaseModel):
    scope: str
    label: str = ""
    expires_at: Optional[int] = None


def _require_local(http_request: Request) -> None:
    if _scope_for_request(http_request) != LOCAL_SCOPE:
        raise HTTPException(status_code=403,
                            detail={"message": "credentials are managed by the operator"})


@router.post("/credentials")
def create_credential(body: CreateCredentialBody, http_request: Request) -> dict:
    _require_local(http_request)
    conn = _connect()
    with closing(conn):
        credentials.ensure_schema(conn)
        conn.commit()
        try:
            credential, secret = credentials.create_credential(
                conn, body.scope, body.label, body.expires_at)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail={"message": str(exc)}) from exc
    # The only response that ever carries the secret.
    return {"credential": credential._asdict(), "secret": secret}


@router.get("/credentials")
def list_credentials(http_request: Request) -> dict:
    _require_local(http_request)
    conn = _connect()
    with closing(conn):
        credentials.ensure_schema(conn)
        conn.commit()
        rows = [c._asdict() for c in credentials.list_credentials(conn)]
    return {"credentials": rows}


@router.delete("/credentials/{credential_id}")
def revoke_credential(credential_id: str, http_request: Request) -> dict:
    _require_local(http_request)
    conn = _connect()
    with closing(conn):
        credentials.ensure_schema(conn)
        conn.commit()
        changed = credentials.revoke_credential(conn, credential_id)
    if not changed:
        raise _not_found("credential", credential_id)
    return {"revoked": credential_id}


# --- the response surface --------------------------------------------------


@router.post("/runs/{run_id}/input-requests/{request_id}/response")
def submit_input_response(run_id: str, request_id: str, body: SubmitResponseBody,
                          http_request: Request,
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
    # Ownership first, and before the idempotency pre-check: a caller that does
    # not own this run must not learn that its key was already spent, or that the
    # request is closed, or anything else about it.
    caller_scope = _scope_for_request(http_request)
    _check = _connect()
    with closing(_check):
        _require_owned_run(_check, run_id, caller_scope)

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
def run_events(run_id: str, http_request: Request, after_seq: int = Query(default=0)) -> dict:
    conn = _connect()
    with closing(conn):
        _require_owned_run(conn, run_id, _scope_for_request(http_request))
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
def expire_inputs(http_request: Request, now: Optional[int] = Query(default=None)) -> dict:
    """Run the deadline sweep on demand.

    Idempotent, and safe to call from anywhere: the poll that renders the board
    calls it, so a run past its deadline stops presenting itself as waiting
    even if no dispatcher is running.

    Local scope only, unlike the other routes. The sweep is not scoped to a run
    at all — it touches every run past its deadline — so an external credential
    has no business calling it, and a per-run ownership check could not express
    the restriction even if it wanted to.
    """
    if _scope_for_request(http_request) != LOCAL_SCOPE:
        raise HTTPException(status_code=403,
                            detail={"message": "the deadline sweep is operator-only"})
    conn = _connect()
    with closing(conn):
        expired = db.expire_input_deadlines(conn, now=now)
    return {"expired": expired, "count": len(expired), "at": int(time.time())}
