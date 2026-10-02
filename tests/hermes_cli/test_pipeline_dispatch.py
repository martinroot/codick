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
from pathlib import Path

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
        # Recoverable, and saying why. This used to assert "queued" or
        # "running" -- which is a run that reads on the board as still working,
        # with nothing left to move it and no reason given.
        assert run.status == "blocked", run.status
        assert "driver stopped" in (run.error or ""), run.error
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


def test_a_finished_run_attaches_its_deliverable_to_the_card(client):
    """The Files tab must show what the run produced.

    A run can finish, the download endpoint can answer 200, and the card still
    show no files: the artifact lives in the pipeline store and nothing ever
    copied it onto the card. The board is where a person looks, so an artifact
    that never reaches the card does not exist as far as the board is concerned.
    """
    from hermes_cli import kanban_db as kb
    from hermes_cli import kanban_db_connect

    template = _template()
    client.post("/api/pipelines/templates", json={"template": template})
    created = client.post(
        "/api/pipelines/runs",
        json={"template_id": template["id"], "inputs": {"topic": "t", "author": "m"}},
        headers={"Idempotency-Key": "drive-files"},
    )
    assert created.status_code == 201, created.text
    run_id, card_id = created.json()["id"], created.json()["card_id"]

    detail = _await_status(client, run_id, {"waiting_input"})
    request_id = [r for r in detail["input_requests"] if r["status"] == "open"][0]["id"]
    client.post(
        f"/api/pipelines/runs/{run_id}/input-requests/{request_id}/response",
        json={"response": {"ok": True}}, headers={"Idempotency-Key": "drive-files-answer"},
    )
    assert _await_status(client, run_id, {"completed", "failed"})["status"] == "completed"

    def attachments():
        conn = kanban_db_connect.connect()
        try:
            return kb.list_attachments(conn, card_id)
        finally:
            conn.close()

    deadline = time.monotonic() + WAIT_SECONDS
    found = []
    while time.monotonic() < deadline:
        found = attachments()
        if found:
            break
        time.sleep(0.05)
    assert found, f"card {card_id} finished with no files attached"

    stored = Path(found[0].stored_path)
    assert stored.is_file(), f"attachment row points at a missing file: {stored}"
    assert stored.read_bytes(), "attached file is empty"


def _delay_template(seconds: int) -> dict:
    """A template whose only work is to take time."""
    return {
        "schema_version": "1.0",
        "id": "delay-check",
        "version": "1.0.0",
        "name": "Delay check",
        "inputs_schema": {"type": "object", "properties": {}},
        "start_step": "pause",
        "steps": [
            {"id": "pause", "type": "delay", "title": "Pause", "seconds": seconds, "next": None},
        ],
    }


def test_a_delay_step_waits_and_reports_no_usage(client, tmp_path):
    """A delay spends wall-clock time and nothing else.

    It must not report a cost: nothing was consumed, and a zero here would be
    indistinguishable from a free tool that did real work.
    """
    template = _delay_template(2)
    client.post("/api/pipelines/templates", json={"template": template})
    run_id = client.post(
        "/api/pipelines/runs", json={"template_id": template["id"], "inputs": {}},
        headers={"Idempotency-Key": "delay-1"},
    ).json()["id"]

    started = time.monotonic()
    detail = _await_status(client, run_id, {"completed", "failed"}, timeout=30.0)
    elapsed = time.monotonic() - started

    assert detail["status"] == "completed", detail
    assert elapsed >= 1.5, f"delay of 2s finished in {elapsed:.2f}s"

    conn = db.connect()
    try:
        usage = conn.execute(
            "SELECT kind, cost_micros FROM step_usage WHERE run_id = ?", (run_id,)
        ).fetchall()
    finally:
        conn.close()
    assert usage == [], f"a delay recorded usage: {usage}"


def test_a_delay_counts_against_the_step_budget(client):
    """Otherwise a delay loop is the one step type that can run for ever."""
    template = _delay_template(0)
    template["limits"] = {"max_step_executions": 2}
    client.post("/api/pipelines/templates", json={"template": template})
    run_id = client.post(
        "/api/pipelines/runs", json={"template_id": template["id"], "inputs": {}},
        headers={"Idempotency-Key": "delay-budget"},
    ).json()["id"]

    detail = _await_status(client, run_id, {"completed", "failed"}, timeout=30.0)
    assert detail["status"] == "completed", detail

    conn = db.connect()
    try:
        run = db.get_run(conn, run_id)
    finally:
        conn.close()
    assert run.step_executions == 1, run.step_executions


def test_a_driver_that_dies_does_not_leave_the_run_running_forever():
    """A driver that stops mid-run used to log and move on. The run kept its
    "running" status with no error and nothing left to move it, which reads on
    the board as a run that is still working. It must land in a state a person
    can act on, and say why."""
    from hermes_cli import pipeline_dispatch as dispatch
    from hermes_cli import pipelines_db as pdb
    from hermes_cli import pipeline_runner as runner

    with tempfile.TemporaryDirectory() as tmp:
        os.environ["HERMES_PIPELINES_DB"] = str(Path(tmp) / "p.db")
        try:
            conn = dispatch._connect()
            template = {
                "schema_version": "1.0", "id": "t", "version": "1", "start_step": "work",
                "steps": [{"id": "work", "type": "agent", "profile": "p", "instruction": "x"}],
            }
            run_id = pdb.create_run(conn, template, inputs={})
            pdb.set_run_status(conn, run_id, "running")

            def explode(*a, **k):
                raise RuntimeError("the driver exploded mid-run")

            original = runner.drive_run
            runner.drive_run = explode
            try:
                dispatch._drive(run_id, "test-owner", lambda: None)
            finally:
                runner.drive_run = original

            run = pdb.get_run(conn, run_id)
            assert run.status == "blocked", run.status
            assert "driver stopped" in (run.error or ""), run.error
        finally:
            os.environ.pop("HERMES_PIPELINES_DB", None)


def test_a_condition_naming_data_that_is_not_there_fails_the_run():
    """A branch whose guard reads a ref that is unavailable used to propagate
    out of the driver and kill the dispatch loop, leaving the run "running" with
    no error. It must fail, and say what is missing."""
    from hermes_cli import pipeline_executor as ex
    from hermes_cli import pipelines_db as pdb

    with tempfile.TemporaryDirectory() as tmp:
        os.environ["HERMES_PIPELINES_DB"] = str(Path(tmp) / "p.db")
        try:
            conn = dispatch_conn()
            template = {
                "schema_version": "1.0", "id": "t", "version": "1", "start_step": "gate",
                "steps": [
                    {"id": "gate", "type": "condition",
                     "cases": [{"when": {"op": "gt",
                                         "left": {"ref": "steps.missing.output.n"},
                                         "right": 1},
                                "next": "later"}],
                     "default": {"next": "later"}},
                    {"id": "later", "type": "agent", "profile": "p", "instruction": "x"},
                ],
            }
            run_id = pdb.create_run(conn, template, inputs={})
            pdb.set_run_status(conn, run_id, "running")
            result = ex.advance(conn, run_id, adapter=None, owner="test-owner")
            assert result.status == "failed", result.status
            run = pdb.get_run(conn, run_id)
            assert run.status == "failed", run.status
            assert "not available" in (run.error or ""), run.error
        finally:
            os.environ.pop("HERMES_PIPELINES_DB", None)


def dispatch_conn():
    from hermes_cli import pipeline_dispatch as dispatch
    return dispatch._connect()
