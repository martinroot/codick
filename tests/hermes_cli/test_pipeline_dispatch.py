"""A run must move without anyone driving it (spec §7, issue #35 readiness).

Every pipeline test until now called `drive_run` itself, which meant the loop
was green and the product was not: `drive_run` had no production caller, so a run
created from the board sat in `queued` forever. This file creates runs through
the API only — no `drive_run`, no adapter, no manual advance — and waits for the
run to reach the state a person would expect.

The adapter is injected because a test cannot spend a provider call, but note
*where* it is injected: into the dispatcher's factory, which is production code.
The point of these tests is not that the model is fake, it is that nobody is
turning the crank.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
os.environ.setdefault("HERMES_HOME", tempfile.mkdtemp(prefix="pipeline-drive-test-"))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from hermes_cli import pipeline_credentials as pipeline_credentials  # noqa: E402
from hermes_cli import pipeline_dispatch as dispatch  # noqa: E402
from hermes_cli import pipelines_db as db  # noqa: E402
from hermes_cli.web_routers import pipelines as pipelines_api  # noqa: E402

SCENARIO = os.path.join(os.path.dirname(__file__), "scenarios", "word-report.json")

#: Generous, because a thread has to start, open SQLite and run two agent steps.
#: A short timeout would make this test flaky in the direction that hides bugs.
WAIT_SECONDS = 20.0


@pytest.fixture(autouse=True)
def _isolated_home(monkeypatch, tmp_path):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.chdir(tmp_path)


class CountingAgent:
    def __init__(self, session_id=None, **kwargs):
        self.session_id = session_id

    def run_conversation(self, prompt, conversation_history=None):
        reply = json.dumps({"facts": ["a fact"]} if "Research" in prompt
                           else {"body": "a body"})
        return reply, {"final_response": reply}

    def close(self):
        pass


@pytest.fixture(autouse=True)
def _injected_adapter(monkeypatch):
    """Production code builds the adapter; the test only supplies the agent.

    Dispatch is off suite-wide (`tests/conftest.py`); these tests are the ones
    that must have it on, so they say so.
    """
    from hermes_cli.pipeline_hermes_adapter import HermesStepAdapter

    dispatch.set_enabled(True)
    monkeypatch.setattr(
        dispatch, "_default_adapter",
        lambda: HermesStepAdapter(agent_factory=CountingAgent),
    )
    yield
    dispatch.shutdown_drivers(timeout=WAIT_SECONDS)


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(pipelines_api.router)
    with TestClient(app) as c:
        conn = db.connect()
        try:
            pipeline_credentials.ensure_schema(conn)
            conn.commit()
            _cred, secret = pipeline_credentials.create_credential(conn, "drive-site")
        finally:
            conn.close()
        c.headers.update({"Authorization": f"Bearer {secret}"})
        yield c


def _template() -> dict:
    with open(SCENARIO, encoding="utf-8") as handle:
        return json.load(handle)


def _await_status(client, run_id, wanted, timeout=WAIT_SECONDS):
    """Poll the API — not the database — so this tests what a client sees."""
    deadline = time.monotonic() + timeout
    seen = None
    while time.monotonic() < deadline:
        detail = client.get(f"/api/pipelines/runs/{run_id}").json()
        seen = detail["status"]
        if seen in wanted:
            return detail
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} was {seen!r} after {timeout}s, wanted {sorted(wanted)}")


def test_a_run_created_through_the_api_moves_on_its_own(client):
    template = _template()
    client.post("/api/pipelines/templates", json={"template": template})
    created = client.post(
        "/api/pipelines/runs",
        json={"template_id": template["id"], "inputs": {"topic": "t", "author": "m"}},
        headers={"Idempotency-Key": "drive-1"},
    )
    assert created.status_code == 201, created.text
    run_id = created.json()["id"]

    # Nobody calls drive_run. The dispatcher started when the run was created.
    detail = _await_status(client, run_id, {"waiting_input"})
    assert detail["current_step_id"] == "approve", detail["current_step_id"]
    assert [r for r in detail["input_requests"] if r["status"] == "open"], detail


def test_answering_through_the_api_drives_the_rest_of_the_run(client):
    template = _template()
    client.post("/api/pipelines/templates", json={"template": template})
    run_id = client.post(
        "/api/pipelines/runs",
        json={"template_id": template["id"], "inputs": {"topic": "t", "author": "m"}},
        headers={"Idempotency-Key": "drive-2"},
    ).json()["id"]

    detail = _await_status(client, run_id, {"waiting_input"})
    request_id = [r for r in detail["input_requests"] if r["status"] == "open"][0]["id"]
    answered = client.post(
        f"/api/pipelines/runs/{run_id}/input-requests/{request_id}/response",
        json={"response": {"ok": True}}, headers={"Idempotency-Key": "drive-2-answer"},
    )
    assert answered.status_code == 200, answered.text

    # The answer is the second moment that starts a driver; the run finishes
    # with nobody left holding the crank.
    final = _await_status(client, run_id, {"completed", "failed"})
    assert final["status"] == "completed", final


def test_two_runs_do_not_share_one_driver(client):
    """Two runs at once means two drivers, not one thread fighting itself."""
    template = _template()
    client.post("/api/pipelines/templates", json={"template": template})
    run_ids = []
    for index in (1, 2):
        run_id = client.post(
            "/api/pipelines/runs",
            json={"template_id": template["id"],
                  "inputs": {"topic": f"t{index}", "author": "m"}},
            headers={"Idempotency-Key": f"drive-3-{index}"},
        ).json()["id"]
        run_ids.append(run_id)

    for run_id in run_ids:
        _await_status(client, run_id, {"waiting_input"})

    # Answer both, then confirm neither run's steps were advanced by the other's
    # driver: each has exactly one approved input and its own attempts.
    for index, run_id in enumerate(run_ids):
        detail = client.get(f"/api/pipelines/runs/{run_id}").json()
        request_id = [r for r in detail["input_requests"] if r["status"] == "open"][0]["id"]
        client.post(
            f"/api/pipelines/runs/{run_id}/input-requests/{request_id}/response",
            json={"response": {"ok": True}}, headers={"Idempotency-Key": f"drive-3-a-{index}"},
        )
    for run_id in run_ids:
        _await_status(client, run_id, {"completed", "failed"})

    conn = db.connect()
    for run_id in run_ids:
        answered = [r for r in db.list_input_requests(conn, run_id) if r.status == "answered"]
        assert len(answered) == 1, (run_id, answered)
        assert db.get_run(conn, run_id).status == "completed"


def test_a_driver_that_raises_leaves_the_run_recoverable_not_failed(client):
    """A dead driver is not a failed run.

    The run's own state lives in SQLite; a driver that dies is a gap in the
    process, not an outcome of the run. Reporting it as `failed` would tell an
    operator the scenario is broken when it is only un-driven.
    """
    from hermes_cli.pipeline_hermes_adapter import HermesStepAdapter

    def exploding_factory():
        raise RuntimeError("the model provider is unreachable")

    dispatch._default_adapter = exploding_factory
    try:
        template = _template()
        client.post("/api/pipelines/templates", json={"template": template})
        created = client.post(
            "/api/pipelines/runs",
            json={"template_id": template["id"], "inputs": {"topic": "t", "author": "m"}},
            headers={"Idempotency-Key": "drive-4"},
        )
        run_id = created.json()["id"]

        # The route still answered 201: creating a run is not driving it.
        assert created.status_code == 201

        deadline = time.monotonic() + WAIT_SECONDS
        while dispatch.is_driving(run_id) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not dispatch.is_driving(run_id), "the driver never released its slot"

        conn = db.connect()
        run = db.get_run(conn, run_id)
        assert run.status in ("queued", "running"), run.status
        # And a later driver can still finish it.
        from hermes_cli.pipeline_runner import drive_run

        assert drive_run(
            conn, run_id, HermesStepAdapter(agent_factory=CountingAgent), owner="test",
        ).status == "waiting_input"
    finally:
        dispatch._default_adapter = lambda: HermesStepAdapter(agent_factory=CountingAgent)

def test_a_finished_run_leaves_its_card_in_the_column_it_earned(client):
    """A completed run must not leave its card sitting in Blocked.

    The card is born in `blocked` because `ready` is derived rather than set,
    so a run that completes without ever moving its card reads as blocked
    forever -- including one that produced an artifact. The board is the run's
    only public face; the run's own status is not on the card.
    """
    from hermes_cli import kanban_db as kb
    from hermes_cli import kanban_db_connect

    template = _template()
    client.post("/api/pipelines/templates", json={"template": template})
    created = client.post(
        "/api/pipelines/runs",
        json={"template_id": template["id"], "inputs": {"topic": "t", "author": "m"}},
        headers={"Idempotency-Key": "drive-card"},
    )
    assert created.status_code == 201, created.text
    card_id = created.json()["card_id"]
    run_id = created.json()["id"]

    detail = _await_status(client, run_id, {"waiting_input"})
    request_id = [r for r in detail["input_requests"] if r["status"] == "open"][0]["id"]
    client.post(
        f"/api/pipelines/runs/{run_id}/input-requests/{request_id}/response",
        json={"response": {"ok": True}}, headers={"Idempotency-Key": "drive-card-answer"},
    )
    final = _await_status(client, run_id, {"completed", "failed"})
    assert final["status"] == "completed", final

    deadline = time.monotonic() + WAIT_SECONDS
    column, completed_at = None, None
    while time.monotonic() < deadline:
        conn = kanban_db_connect.connect()
        try:
            task = kb.get_task(conn, card_id)
        finally:
            conn.close()
        column = task.status if task else None
        completed_at = task.completed_at if task else None
        if column == "done" and completed_at:
            break
        time.sleep(0.05)
    assert column == "done", f"card {card_id} stayed in {column!r} after the run completed"
    assert completed_at, f"card {card_id} reached Done with no completed_at"
    # INTEGER epoch seconds: the board sorts this column arithmetically, so a
    # formatted date is not a cosmetic difference -- it is a 500 on the board.
    assert isinstance(completed_at, int), (
        f"card {card_id} stored completed_at as {type(completed_at).__name__}, "
        f"not an epoch int"
    )
