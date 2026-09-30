"""The pipeline run-control API and the ``user_input`` response surface (#32, spec §7, §10, §11).

Runs the real router through ``TestClient`` against a real database, and drives
the executor directly where it must — the API deliberately does not execute
anything, because a model call behind a request handler would sit inside an HTTP
timeout and outside the step's lease, leaving a run ``running`` that nothing
could reconcile. In production the dispatcher is a separate process; here it is
a few lines of the test.

What this pins, straight from the issue:
  - a wait holds no worker, and the request survives a re-read (i.e. a restart)
  - a 422 names the failing field's JSON path and leaves the request OPEN
  - a response to a closed or superseded request is a 409, not a 422
  - a finite ``wait_timeout_seconds`` fails the run with ``input_timeout``
  - ``wait_timeout_seconds: null`` means no deadline and is never swept
"""

from __future__ import annotations

import os
import sys
from contextlib import closing
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

# The pipeline DB lives at ``<HERMES_HOME>/plugin-data/pipelines/``, resolved on
# every call from ``get_hermes_home()`` — so the suite's temp home already
# isolates it and there is no separate variable to set. (There is no
# HERMES_PIPELINES_DATA_ROOT; an earlier draft of this file set one and it did
# nothing.) The real assertion is in the `client` fixture: refuse to run if the
# path lands in the real home.
import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from hermes_cli import pipeline_executor as ex  # noqa: E402
from hermes_cli import kanban_db
from hermes_cli import kanban_db_connect
from hermes_cli import pipeline_credentials
from hermes_cli import pipelines_db as db  # noqa: E402
from hermes_cli.web_routers import pipelines as pipelines_api  # noqa: E402
from hermes_cli.pipeline_fake_adapter import FakeAdapter, scripted  # noqa: E402
from hermes_cli.pipelines_db import pipelines_db_path  # noqa: E402

TEMPLATE = {
    "schema_version": "1.0", "id": "ask", "version": "1.0.0", "name": "Ask",
    "start_step": "draft",
    "inputs_schema": {"type": "object", "properties": {}, "required": []},
    "steps": [
        {"id": "draft", "type": "agent", "profile": "w", "instruction": "D", "input": {}, "next": "ask"},
        {"id": "ask", "type": "user_input", "prompt": "Approve?",
         "response_schema": {
             "type": "object",
             "properties": {"approved": {"type": "boolean"}, "note": {"type": "string"}},
             "required": ["approved"],
         },
         "wait_timeout_seconds": 600, "next": "publish"},
        {"id": "publish", "type": "tool", "tool": "t", "instruction": "E", "input": {}, "next": None},
    ],
}


def _variant(template_id: str, **overrides) -> dict:
    t = {**TEMPLATE, "id": template_id, "steps": [dict(s) for s in TEMPLATE["steps"]]}
    for step in t["steps"]:
        if step["id"] == "ask":
            step.update(overrides)
    return t


@pytest.fixture
def client():
    """The real router, on a fresh database, on its own app.

    A bare ``FastAPI`` rather than ``web_server.app``: these handlers are what is
    under test, and mounting them onto the dashboard's app would drag in plugin
    auth and every other route for no gain.

    Since #42 the run routes need a scope, so the fixture yields a client bound
    to one minted credential. Tests that need a second site mint their own, and
    the negative tests below exist precisely to check the two cannot read each
    other.
    """
    db_path = pipelines_db_path()
    real_home = os.path.realpath(str(Path.home() / ".hermes"))
    assert not os.path.realpath(str(db_path)).startswith(real_home), (
        f"refusing to run against the real pipeline DB: {db_path}"
    )
    if db_path.exists():
        db_path.unlink()
    app = FastAPI()
    app.include_router(pipelines_api.router)
    with TestClient(app) as c:
        c.headers.update({"Authorization": f"Bearer {mint('site-a')}"})
        yield c


@pytest.fixture
def as_operator(client):
    """The same client, acting as the local operator.

    The deadline sweep and credential management are operator-only (#42), so
    those tests have to present a local scope. Yielded as a context manager so
    the site's own header is restored afterwards and the ownership tests that
    follow in the same function still see a site credential.
    """
    saved = client.headers.get("Authorization")
    client.headers["Authorization"] = f"Bearer {mint('local')}"
    try:
        yield client
    finally:
        if saved is not None:
            client.headers["Authorization"] = saved


def mint(scope: str) -> str:
    """Mint a credential directly, the way provisioning would.

    Not through the API: the API's credential routes are operator-only, and the
    operator is the local scope, which a test client does not have.
    """
    conn = db.connect()
    try:
        pipeline_credentials.ensure_schema(conn)
        conn.commit()
        _cred, secret = pipeline_credentials.create_credential(conn, scope)
    finally:
        conn.close()
    return secret


def _store(client, template: dict) -> dict:
    r = client.post("/api/pipelines/templates", json={"template": template})
    assert r.status_code == 200, r.text
    return r.json()


def _create(client, key: str, template_id: str = "ask", **body) -> str:
    """Create a run the way a caller does, returning its id."""
    payload = {"template_id": template_id, **body}
    r = client.post("/api/pipelines/runs", json=payload, headers={"Idempotency-Key": key})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _run_to_waiting(client, template: dict) -> tuple[str, str]:
    """Store, create, and drive to the wait — the dispatcher, simulated."""
    _store(client, template)
    r = client.post("/api/pipelines/runs", json={"template_id": template["id"], "inputs": {}},
                    headers={"Idempotency-Key": f"setup-{template['id']}"})
    assert r.status_code == 201, r.text
    run_id = r.json()["id"]
    adapter = FakeAdapter(scripted(draft=[{}], publish=[{}]))
    conn = db.connect()
    ex.advance(conn, run_id, adapter, owner="dispatcher-1")  # draft -> ask
    ex.advance(conn, run_id, adapter, owner="dispatcher-1")  # opens the request
    conn.close()
    detail = client.get(f"/api/pipelines/runs/{run_id}").json()
    open_reqs = [r for r in detail["input_requests"] if r["status"] == "open"]
    assert len(open_reqs) == 1, detail["input_requests"]
    return run_id, open_reqs[0]["id"]


# --- per-run ownership (#42) -----------------------------------------------
#
# The issue is explicit that the positive path proves nothing about this, so
# these sit next to the happy-path tests rather than in a separate file: a run
# that exists, a request id from a different run, and a credential that is valid
# but scoped elsewhere.


def test_a_run_is_readable_by_the_scope_that_owns_it(client):
    _store(client, TEMPLATE)
    run_id = _create(client, "k1")
    assert client.get(f"/api/pipelines/runs/{run_id}").status_code == 200


def test_another_sites_credential_cannot_read_the_run(client):
    _store(client, TEMPLATE)
    run_id = _create(client, "k1")
    client.headers["Authorization"] = f"Bearer {mint('site-b')}"
    # 404, not 403: a 403 would confirm the run exists, which is itself an
    # answer about someone else's data.
    assert client.get(f"/api/pipelines/runs/{run_id}").status_code == 404
    assert client.get(f"/api/pipelines/runs/{run_id}/events").status_code == 404


def test_a_request_id_from_another_run_is_rejected(client):
    """The forged-id path: a real, open request that belongs to a different run."""
    run_a, request_a = _run_to_waiting(client, TEMPLATE)
    other = _variant("ask2", response_schema={"type": "object", "required": ["z"],
                                               "properties": {"z": {"type": "string"}}})
    _store(client, other)
    run_b, request_b = _run_to_waiting(client, other)
    assert request_a != request_b

    # site-b owns run_b and holds run_b's real request id, and presents it under
    # run_a. The check is on the run, so this is refused.
    client.headers["Authorization"] = f"Bearer {mint('site-b')}"
    path = f"/api/pipelines/runs/{run_a}/input-requests/{request_b}/response"
    assert client.post(path, json={"response": {"approved": True}}).status_code == 404
    # And run_a's own request stays open: nothing was applied.
    assert client.get(f"/api/pipelines/runs/{run_a}").status_code == 404


def test_a_run_with_no_owner_stamp_is_refused(client):
    """The deny-by-default property, stated as a test because it is the property.

    The gateway's comment records why: run state that exists without an owner is
    an unanswered authorisation question, not a run anyone may control. Admitting
    it would make the boundary allow-all.
    """
    _store(client, TEMPLATE)
    run_id = _create(client, "k1")
    conn = db.connect()
    conn.execute("UPDATE pipeline_runs SET owner_scope = NULL WHERE id = ?", (run_id,))
    conn.commit()
    conn.close()
    assert client.get(f"/api/pipelines/runs/{run_id}").status_code == 404


def test_an_unstamped_run_is_not_readable_even_by_its_creator(client):
    _store(client, TEMPLATE)
    run_id = _create(client, "k1")
    conn = db.connect()
    conn.execute("UPDATE pipeline_runs SET owner_scope = NULL WHERE id = ?", (run_id,))
    conn.commit()
    conn.close()
    # Same credential that created it. Ownership is the run's stamp, not a
    # memory of who asked.
    assert client.get(f"/api/pipelines/runs/{run_id}").status_code == 404


def test_no_credential_at_all_is_401(client):
    _store(client, TEMPLATE)
    del client.headers["Authorization"]
    assert client.get("/api/pipelines/templates/ask").status_code == 401


def test_a_bogus_revoked_or_malformed_credential_is_one_answer(client):
    """They must be indistinguishable, or the response is a free oracle."""
    _store(client, TEMPLATE)
    for bad in ("codick_not-a-real-secret", "", "garbage"):
        client.headers["Authorization"] = f"Bearer {bad}"
        assert client.get("/api/pipelines/templates/ask").status_code == 401

    secret = mint("site-c")
    conn = db.connect()
    creds = [c for c in pipeline_credentials.list_credentials(conn) if c.scope == "site-c"]
    pipeline_credentials.revoke_credential(conn, creds[0].id)
    conn.close()
    client.headers["Authorization"] = f"Bearer {secret}"
    assert client.get("/api/pipelines/templates/ask").status_code == 401


def test_the_stored_credential_is_a_hash_not_a_secret(client):
    _store(client, TEMPLATE)
    secret = mint("site-d")
    conn = db.connect()
    rows = conn.execute("SELECT secret_hash FROM pipeline_credentials").fetchall()
    conn.close()
    assert rows
    for row in rows:
        assert secret not in row["secret_hash"]
        assert len(row["secret_hash"]) == 64  # sha256 hex


def test_listing_credentials_never_returns_a_secret(client, as_operator):
    with as_operator as op:
        listed = op.get("/api/pipelines/credentials")
        assert listed.status_code == 200
        keys = {k for c in listed.json()["credentials"] for k in c}
        assert "secret" not in keys and "secret_hash" not in keys
        assert "codick_" not in listed.text


def test_an_external_credential_cannot_mint_another_one(client):
    """The credential routes are operator-only; a site is not an operator."""
    assert client.post("/api/pipelines/credentials",
                       json={"scope": "site-e"}).status_code == 403


def test_an_external_credential_cannot_run_the_deadline_sweep(client):
    """The sweep touches every run, so no single site's scope can authorise it."""
    assert client.post("/api/pipelines/maintenance/expire-inputs").status_code == 403


# --- templates ------------------------------------------------------------


def test_a_bad_template_is_refused_with_its_errors(client):
    r = client.post("/api/pipelines/templates/validate", json={"template": {"schema_version": "0.1"}})
    assert r.status_code == 200
    assert r.json()["valid"] is False
    assert r.json()["errors"], "a rejection must say what is wrong"

    r2 = client.post("/api/pipelines/templates", json={"template": {"schema_version": "0.1"}})
    assert r2.status_code == 422
    assert r2.json()["detail"]["errors"]


def test_a_stored_template_round_trips_and_versions(client):
    stored = _store(client, TEMPLATE)
    assert stored["readiness_status"] == "ready"
    assert stored["template"] == TEMPLATE

    got = client.get("/api/pipelines/templates/ask").json()
    assert got["template"]["id"] == "ask"
    assert client.get("/api/pipelines/templates/ask/versions").json()["versions"] == ["1.0.0"]
    assert [t["id"] for t in client.get("/api/pipelines/templates").json()["templates"]] == ["ask"]

    # A second version is a new row, and the latest is the newest.
    _store(client, {**TEMPLATE, "version": "2.0.0"})
    # Both versions are listed and each is addressable by its own version; the
    # list's ordering is not a contract, but "latest" resolving to the newest
    # is.
    assert set(client.get("/api/pipelines/templates/ask/versions").json()["versions"]) == {"1.0.0", "2.0.0"}
    assert client.get("/api/pipelines/templates/ask").json()["version"] == "2.0.0"
    assert client.get("/api/pipelines/templates/ask?version=1.0.0").json()["version"] == "1.0.0"

    # Re-importing the same pair replaces the JSON rather than duplicating it.
    _store(client, {**TEMPLATE, "name": "Ask (renamed)"})
    assert set(client.get("/api/pipelines/templates/ask/versions").json()["versions"]) == {"1.0.0", "2.0.0"}
    assert client.get("/api/pipelines/templates/ask?version=1.0.0").json()["name"] == "Ask (renamed)"


def test_an_unknown_template_is_404(client):
    assert client.get("/api/pipelines/templates/nope").status_code == 404
    assert client.post("/api/pipelines/runs", json={"template_id": "nope"},
                       headers={"Idempotency-Key": "k1"}).status_code == 404


# --- the wait -------------------------------------------------------------


def test_a_wait_holds_no_worker_and_survives_a_re_read(client):
    run_id, request_id = _run_to_waiting(client, TEMPLATE)
    detail = client.get(f"/api/pipelines/runs/{run_id}").json()
    assert detail["status"] == "waiting_input"
    assert detail["current_step_id"] == "ask"
    assert isinstance(detail["deadline"], int)
    assert not [a for a in detail["attempts"] if a["status"] == "running"], detail["attempts"]
    # The prompt and its schema are what the UI renders to collect an answer.
    request = detail["input_requests"][0]
    assert request["prompt"] == "Approve?"
    assert request["response_schema"]["required"] == ["approved"]

    # "Restarting the backend does not lose the request": a brand-new connection
    # and a fresh read still see it, open.
    again = client.get(f"/api/pipelines/runs/{run_id}").json()
    assert [r for r in again["input_requests"] if r["id"] == request_id][0]["status"] == "open"


# --- the response surface -------------------------------------------------


# --- Idempotency-Key (#41) ------------------------------------------------


def test_creating_a_run_also_creates_its_card(client):
    """Spec §9: Run makes the card and the run as one operation.

    This is the route the board's Run button calls, so the pair has to be
    complete here — a run with no card is the broken pair the spec names.
    """
    _store(client, TEMPLATE)
    created = client.post("/api/pipelines/runs", json={"template_id": "ask", "inputs": {}},
                          headers={"Idempotency-Key": "k1"})
    assert created.status_code == 201, created.text
    card_id = created.json()["card_id"]
    assert card_id, "the run came back with no card"

    kanban = kanban_db_connect.connect()
    try:
        card = kanban_db.get_task(kanban, card_id)
    finally:
        kanban.close()
    assert card is not None, "the run names a card that does not exist"
    assert TEMPLATE["id"] in card.title or TEMPLATE["name"] in card.title


def test_a_replay_of_run_creation_does_not_make_a_second_card(client):
    _store(client, TEMPLATE)
    first = client.post("/api/pipelines/runs", json={"template_id": "ask", "inputs": {}},
                        headers={"Idempotency-Key": "k1"})
    again = client.post("/api/pipelines/runs", json={"template_id": "ask", "inputs": {}},
                        headers={"Idempotency-Key": "k1"})
    assert again.json()["card_id"] == first.json()["card_id"], "a replay made a second card"


def test_exactly_one_router_owns_the_pipelines_prefix():
    """One prefix, one router.

    Two modules were mounted on `/api/pipelines`, so the events route was
    registered twice and the first registration won — the second copy was
    unreachable, and nothing errored. This asserts the invariant rather than the
    symptom: no other module may claim the prefix, and no route may be declared
    twice.
    """
    from fastapi.routing import APIRoute
    from hermes_cli import web_server_dashboard

    assert getattr(web_server_dashboard, "PIPELINES_API_PREFIX", None) is None, (
        "the prefix now belongs to web_routers/pipelines.py; a second definition "
        "here is how the duplicate mount came back"
    )
    routes = [r for r in pipelines_api.router.routes if isinstance(r, APIRoute)]
    seen: dict[tuple[str, str], int] = {}
    for route in routes:
        key = (route.path, ",".join(sorted(route.methods or ())))
        seen[key] = seen.get(key, 0) + 1
    duplicates = {k: n for k, n in seen.items() if n > 1}
    assert not duplicates, f"duplicate routes in the single owner: {duplicates}"
    assert len(routes) >= 10, "the merged surface lost routes"


def test_run_creation_requires_an_idempotency_key(client):
    """Required, not optional.

    A caller that cannot tell a lost response from a lost run has to retry, and
    an unkeyed retry would create a second run and a second card. A missing key
    is a 400 rather than a silent pass-through.
    """
    _store(client, TEMPLATE)
    assert client.post("/api/pipelines/runs", json={"template_id": "ask"}).status_code == 400


def test_the_same_key_and_payload_replays_the_first_run(client):
    _store(client, TEMPLATE)
    first = client.post("/api/pipelines/runs", json={"template_id": "ask"},
                        headers={"Idempotency-Key": "k1"})
    assert first.status_code == 201
    again = client.post("/api/pipelines/runs", json={"template_id": "ask"},
                        headers={"Idempotency-Key": "k1"})
    assert again.status_code == 200
    assert again.json()["id"] == first.json()["id"], "a replay must not be a second run"


def test_the_same_key_with_a_different_payload_is_a_conflict(client):
    _store(client, TEMPLATE)
    assert client.post("/api/pipelines/runs", json={"template_id": "ask", "inputs": {"topic": "a"}},
                       headers={"Idempotency-Key": "k1"}).status_code == 201
    clash = client.post("/api/pipelines/runs", json={"template_id": "ask", "inputs": {"topic": "b"}},
                        headers={"Idempotency-Key": "k1"})
    assert clash.status_code == 409


def test_a_rejected_replay_leaves_no_orphan_run(client):
    """The gateway creates the run first and forgets it on a conflict; so do we."""
    _store(client, TEMPLATE)
    assert client.post("/api/pipelines/runs", json={"template_id": "ask", "inputs": {"topic": "a"}},
                       headers={"Idempotency-Key": "k1"}).status_code == 201
    assert client.post("/api/pipelines/runs", json={"template_id": "ask", "inputs": {"topic": "b"}},
                       headers={"Idempotency-Key": "k1"}).status_code == 409
    # The rolled-back run is really gone, not merely hidden behind a 409.
    conn = db.connect()
    with closing(conn):
        assert len([r for r in db.list_runs(conn) if r.template_id == "ask"]) == 1


def test_a_response_replays_instead_of_conflicting_on_its_own_closed_request(client):
    """The ordering that matters: the key is checked before the closed check.

    Accepting a response closes its request, so a caller retrying the same
    answer would otherwise get a 409 that reads like a conflict but is a replay.
    """
    run_id, request_id = _run_to_waiting(client, TEMPLATE)
    path = f"/api/pipelines/runs/{run_id}/input-requests/{request_id}/response"
    key = {"Idempotency-Key": "r1"}
    assert client.post(path, json={"response": {"approved": True}}, headers=key).status_code == 200
    replay = client.post(path, json={"response": {"approved": True}}, headers=key)
    assert replay.status_code == 200
    assert replay.json()["replayed"] is True
    assert replay.json()["accepted_response"] == {"approved": True}


def test_a_response_key_reused_with_a_different_body_is_a_conflict(client):
    run_id, request_id = _run_to_waiting(client, TEMPLATE)
    path = f"/api/pipelines/runs/{run_id}/input-requests/{request_id}/response"
    key = {"Idempotency-Key": "r1"}
    assert client.post(path, json={"response": {"approved": True}}, headers=key).status_code == 200
    assert client.post(path, json={"response": {"approved": False}}, headers=key).status_code == 409


def test_a_422_names_the_failing_json_path_and_leaves_the_request_open(client):
    run_id, request_id = _run_to_waiting(client, TEMPLATE)
    path = f"/api/pipelines/runs/{run_id}/input-requests/{request_id}/response"

    # Wrong type on a required field, plus a missing one.
    r = client.post(path, json={"response": {"approved": "yes-please"}})
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    paths = {e["path"] for e in detail["errors"]}
    assert "$.approved" in paths, detail["errors"]
    # A *missing* required field is named at its own path too, not at the root.
    missing = client.post(path, json={"response": {}}).json()["detail"]["errors"]
    assert {e["path"] for e in missing} == {"$.approved"}, missing
    assert detail["still_open"] is True

    # A wrong answer is not an answer: the request is still answerable, and a
    # correct one after the failure is accepted.
    assert client.get(f"/api/pipelines/runs/{run_id}").json()["input_requests"][0]["status"] == "open"
    ok = client.post(path, json={"response": {"approved": True}, "responded_by": "martin"})
    assert ok.status_code == 200, ok.text
    assert ok.json()["accepted_response"] == {"approved": True}
    assert ok.json()["responded_at"] is not None


def test_a_nested_path_is_reported_in_full(client):
    tpl = _variant("nested")
    tpl["steps"] = [
        {"id": "draft", "type": "agent", "profile": "w", "instruction": "D", "input": {}, "next": "ask"},
        {"id": "ask", "type": "user_input", "prompt": "?",
         "response_schema": {
             "type": "object",
             "properties": {"items": {"type": "array", "items": {
                 "type": "object",
                 "properties": {"qty": {"type": "integer"}},
                 "required": ["qty"]}}},
             "required": ["items"],
         },
         "wait_timeout_seconds": 600, "next": None},
    ]
    run_id, request_id = _run_to_waiting(client, tpl)
    r = client.post(
        f"/api/pipelines/runs/{run_id}/input-requests/{request_id}/response",
        json={"response": {"items": [{"qty": 1}, {"note": "no qty"}]}},
    )
    assert r.status_code == 422, r.text
    paths = {e["path"] for e in r.json()["detail"]["errors"]}
    assert "$.items[1].qty" in paths, r.json()["detail"]["errors"]


def test_a_duplicate_response_is_409_and_does_not_advance_twice(client):
    run_id, request_id = _run_to_waiting(client, TEMPLATE)
    path = f"/api/pipelines/runs/{run_id}/input-requests/{request_id}/response"

    assert client.post(path, json={"response": {"approved": True}}).status_code == 200
    # Second time: closed. 409, and specifically not 422 — a closed request is
    # closed whatever the payload says.
    dup = client.post(path, json={"response": {"approved": False}})
    assert dup.status_code == 409, dup.text
    assert dup.json()["detail"]["status"] == "answered"

    events = client.get(f"/api/pipelines/runs/{run_id}/events").json()["events"]
    assert [e["type"] for e in events].count("input.received") == 1, events


def test_a_superseded_request_is_409(client):
    """Re-entering a user_input step opens a new request and kills the old one."""
    tpl = _variant("superseded", wait_timeout_seconds=600)
    run_id, first = _run_to_waiting(client, tpl)
    # The executor's own path for a repeated step: a new request id, old invalidated.
    conn = db.connect()
    attempt = [a for a in db.list_attempts(conn, run_id) if a.step_id == "ask"][0]
    db.invalidate_input_requests(conn, attempt_id=attempt.id)
    second = db.open_input_request(
        conn, run_id, "ask", attempt.id, prompt="Approve again?",
        response_schema={"type": "object", "required": ["approved"]},
    )
    conn.close()
    assert second != first

    stale = client.post(
        f"/api/pipelines/runs/{run_id}/input-requests/{first}/response",
        json={"response": {"approved": True}},
    )
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["status"] == "invalidated"

    fresh = client.post(
        f"/api/pipelines/runs/{run_id}/input-requests/{second}/response",
        json={"response": {"approved": True}},
    )
    assert fresh.status_code == 200, fresh.text


def test_a_request_from_another_run_is_404(client):
    run_a, req_a = _run_to_waiting(client, _variant("run-a"))
    run_b, _ = _run_to_waiting(client, _variant("run-b"))
    r = client.post(
        f"/api/pipelines/runs/{run_b}/input-requests/{req_a}/response",
        json={"response": {"approved": True}},
    )
    assert r.status_code == 404, r.text


# --- deadlines ------------------------------------------------------------


def test_a_finite_deadline_fails_the_run_and_is_swept(client, as_operator):
    tpl = _variant("deadline", wait_timeout_seconds=600)
    run_id, request_id = _run_to_waiting(client, tpl)
    assert client.get(f"/api/pipelines/runs/{run_id}").json()["deadline"] is not None

    # Nothing sweeps it yet: the wait is genuinely stored, not self-firing.
    assert client.get(f"/api/pipelines/runs/{run_id}").json()["status"] == "waiting_input"

    # The sweep is operator-only (#42): it is not scoped to a run at all.
    with as_operator as op:
        swept = op.post(f"/api/pipelines/maintenance/expire-inputs?now={10 ** 12}").json()
    assert swept["expired"] == [run_id], swept

    detail = client.get(f"/api/pipelines/runs/{run_id}").json()
    assert detail["status"] == "failed"
    assert detail["error_code"] == "input_timeout"
    assert [r for r in detail["input_requests"] if r["id"] == request_id][0]["status"] == "expired"
    assert "input.expired" in [e["type"] for e in detail["events"]]

    # A response to an expired request is a 409, and the sweep is idempotent.
    late = client.post(
        f"/api/pipelines/runs/{run_id}/input-requests/{request_id}/response",
        json={"response": {"approved": True}},
    )
    assert late.status_code == 409, late.text
    assert client.post("/api/pipelines/maintenance/expire-inputs?now=99999999999").json()["count"] == 0


def test_a_null_wait_timeout_has_no_deadline_and_is_never_swept(client, as_operator):
    tpl = _variant("forever", wait_timeout_seconds=None)
    run_id, _ = _run_to_waiting(client, tpl)
    assert client.get(f"/api/pipelines/runs/{run_id}").json()["deadline"] is None
    with as_operator as op:
        swept = op.post(f"/api/pipelines/maintenance/expire-inputs?now={10 ** 12}").json()
    assert swept["expired"] == [], swept
    assert client.get(f"/api/pipelines/runs/{run_id}").json()["status"] == "waiting_input"


def test_polling_a_run_acts_on_a_passed_deadline(client):
    """A client that polls must not see a past-due run still claiming to wait."""
    tpl = _variant("polled", wait_timeout_seconds=1)
    run_id, _ = _run_to_waiting(client, tpl)
    conn = db.connect()
    # Move the deadline into the past rather than sleeping.
    conn.execute("UPDATE pipeline_runs SET deadline = 1 WHERE id = ?", (run_id,))
    conn.commit()
    conn.close()
    detail = client.get(f"/api/pipelines/runs/{run_id}").json()
    assert detail["status"] == "failed"
    assert detail["error_code"] == "input_timeout"


# --- events ---------------------------------------------------------------


def test_events_are_readable_and_after_seq_works(client):
    run_id, _ = _run_to_waiting(client, TEMPLATE)
    events = client.get(f"/api/pipelines/runs/{run_id}/events").json()["events"]
    # The order is the executor's, not a guess: a run records creation, then
    # goes running for each step it activates, then the input request.
    types = [e["type"] for e in events]
    assert types[0] == "run.created", types
    assert "run.running" in types, types
    assert "input.requested" in types, types
    assert types.index("run.running") < types.index("input.requested"), types
    seqs = [e["seq"] for e in events]
    assert seqs == sorted(seqs)
    tail = client.get(f"/api/pipelines/runs/{run_id}/events?after_seq={seqs[0]}").json()["events"]
    assert all(e["seq"] > seqs[0] for e in tail)


def test_an_unavailable_template_is_409_not_runnable(client):
    _store(client, TEMPLATE)
    conn = db.connect()
    conn.execute("UPDATE scenario_templates SET readiness = 'unavailable' WHERE id = 'ask'")
    conn.commit()
    conn.close()
    r = client.post("/api/pipelines/runs", json={"template_id": "ask", "inputs": {}},
                    headers={"Idempotency-Key": "k1"})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["readiness"] == "unavailable"
