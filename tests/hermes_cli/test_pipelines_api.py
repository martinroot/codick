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
from hermes_cli import pipelines_db as db  # noqa: E402
from hermes_cli import pipelines_api  # noqa: E402
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
    """
    db_path = pipelines_db_path()
    real_home = os.path.realpath(str(Path.home() / ".hermes"))
    assert not os.path.realpath(str(db_path)).startswith(real_home), (
        f"refusing to run against the real pipeline DB: {db_path}"
    )
    if db_path.exists():
        db_path.unlink()
    app = FastAPI()
    app.include_router(pipelines_api.router, prefix="/api/pipelines")
    with TestClient(app) as c:
        yield c


def _store(client, template: dict) -> dict:
    r = client.post("/api/pipelines/templates", json={"template": template})
    assert r.status_code == 200, r.text
    return r.json()


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


def test_a_finite_deadline_fails_the_run_and_is_swept(client):
    tpl = _variant("deadline", wait_timeout_seconds=600)
    run_id, request_id = _run_to_waiting(client, tpl)
    assert client.get(f"/api/pipelines/runs/{run_id}").json()["deadline"] is not None

    # Nothing sweeps it yet: the wait is genuinely stored, not self-firing.
    assert client.get(f"/api/pipelines/runs/{run_id}").json()["status"] == "waiting_input"

    swept = client.post(f"/api/pipelines/maintenance/expire-inputs?now={10 ** 12}").json()
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


def test_a_null_wait_timeout_has_no_deadline_and_is_never_swept(client):
    tpl = _variant("forever", wait_timeout_seconds=None)
    run_id, _ = _run_to_waiting(client, tpl)
    assert client.get(f"/api/pipelines/runs/{run_id}").json()["deadline"] is None
    swept = client.post(f"/api/pipelines/maintenance/expire-inputs?now={10 ** 12}").json()
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
