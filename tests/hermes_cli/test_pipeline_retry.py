"""Retry a failed step by hand (spec §7, spec §14).

The distinction this file is about is between a run that **failed** and a run
that is **blocked**. A failed run is one whose step returned an error; a blocked
run is one whose outcome could not be established. Re-running a failed step is
what a retry button is for. Re-running a blocked step is the blind repeat of a
side effect that the runtime forbids everywhere else, and permitting it here
would make a retry button a way to double a customer's charge.

No step in this file declares a `retry` block, so the first failure is terminal
— which is the situation an operator is actually looking at when they reach for
Retry.
"""

from __future__ import annotations

import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
os.environ.setdefault("HERMES_HOME", tempfile.mkdtemp(prefix="pipeline-retry-test-"))

from hermes_cli import pipelines_db as db  # noqa: E402
from hermes_cli import pipeline_runner as runner  # noqa: E402
from hermes_cli.pipeline_executor import AdapterError  # noqa: E402
from hermes_cli.pipeline_fake_adapter import FakeAdapter, scripted  # noqa: E402
from hermes_cli.pipeline_template import validate_template  # noqa: E402

TEMPLATE = {
    "schema_version": "1.0",
    "id": "retryable",
    "version": "1.0.0",
    "name": "Retryable",
    "start_step": "first",
    "inputs_schema": {"type": "object", "properties": {"topic": {"type": "string"}}},
    "limits": {"max_rework_cycles": 2, "max_step_executions": 20},
    "steps": [
        {
            "id": "first", "type": "agent", "profile": "writer",
            "instruction": "First",
            "output_schema": {"type": "object", "properties": {"a": {"type": "string"}}},
            "next": None,
        },
    ],
}


@pytest.fixture(autouse=True)
def _isolated_home(monkeypatch, tmp_path):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))


def test_the_template_is_valid():
    assert validate_template(TEMPLATE) == []


def _failed_run(conn) -> str:
    """A run that genuinely failed *on a step*.

    Failing a run that never advanced leaves `current_step_id` NULL — the
    executor only sets it on the first advance — and a retry asked to re-run
    "nothing" is not the situation an operator is ever in.
    """
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "t"})
    runner.drive_run(
        conn, run_id,
        FakeAdapter(scripted(first=[AdapterError("the tool said no")])), owner="runner-1",
    )
    assert db.get_run(conn, run_id).status == "failed"
    return run_id


def test_re_arming_returns_the_run_to_queued():
    conn = db.connect()
    run_id = _failed_run(conn)
    retried, step_id = db.retry_failed_step(conn, run_id, reason="operator")
    assert (retried, step_id) == (True, "first")
    assert db.get_run(conn, run_id).status == "queued"


def test_re_arming_produces_a_fresh_attempt_and_a_finished_run():
    """The executor creates the new attempt itself; re-arming is enough.

    `_pending_attempt` only returns a `queued`/`running` attempt and a failed
    step has none, so the retry starts a new attempt rather than resurrecting
    the one that failed. The step declares no retry budget, so the first
    failure is terminal — which is the state an operator sees when they reach
    for Retry.
    """
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "t"})
    failing = FakeAdapter(scripted(first=[AdapterError("provider refused")]))
    assert runner.drive_run(conn, run_id, failing, owner="runner-1").status == "failed"
    # The default budget is two: the call plus one technical retry (spec §7).
    assert len(db.list_attempts(conn, run_id)) == 2

    assert db.retry_failed_step(conn, run_id) == (True, "first")

    # Whatever the operator fixed, a working adapter now finishes the run.
    working = FakeAdapter(scripted(first=[{"a": "this time"}]))
    report = runner.drive_run(conn, run_id, working, owner="runner-1")
    assert report.status == "completed"
    # A third attempt — the re-armed run started its own budget rather than
    # picking up the exhausted one where it left off.
    assert len(db.list_attempts(conn, run_id)) == 3


def test_a_retried_run_loses_the_old_error():
    """The failure text is stale the moment the run is re-armed; leaving it
    would show the operator a failed run that is queued."""
    conn = db.connect()
    run_id = _failed_run(conn)
    db.retry_failed_step(conn, run_id)
    run = db.get_run(conn, run_id)
    assert run.error is None
    assert run.ended_at is None


def test_a_blocked_run_is_not_retried():
    """The whole point: `blocked` means the outcome is unknown."""
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "t"})
    db.set_run_status(conn, run_id, "blocked", error="unknown", error_code="unknown")
    assert db.retry_failed_step(conn, run_id)[0] is False
    assert db.get_run(conn, run_id).status == "blocked"


def test_a_running_run_is_not_retried():
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "t"})
    db.set_run_status(conn, run_id, "running")
    assert db.retry_failed_step(conn, run_id)[0] is False


def test_retrying_twice_is_refused_the_second_time():
    """Once-only by state rather than by a second guard: the first call moves
    the run to `queued`, so the second call no longer sees `failed`."""
    conn = db.connect()
    run_id = _failed_run(conn)
    assert db.retry_failed_step(conn, run_id) == (True, "first")
    assert db.retry_failed_step(conn, run_id)[0] is False
    assert db.get_run(conn, run_id).status == "queued"


def test_the_retry_is_recorded_as_an_event():
    """A re-armed run has to say so in the feed, or the history lies."""
    conn = db.connect()
    run_id = _failed_run(conn)
    db.retry_failed_step(conn, run_id, reason="operator")
    retried = [e for e in db.list_events(conn, run_id) if e.type == "run.retried"]
    assert retried
    assert retried[-1].payload.get("reason") == "operator"


def test_retrying_an_unknown_run_is_refused():
    conn = db.connect()
    assert db.retry_failed_step(conn, "run_nope") == (False, None)