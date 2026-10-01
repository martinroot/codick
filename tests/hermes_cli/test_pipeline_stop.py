"""Stop (spec §14 check 9, spec §7).

Two properties, and the second is the one that is easy to get wrong:

1. Stop forbids new steps.
2. A late result from a cancelled or stale attempt does not change the run.

The second exists because a model call takes minutes. A user who presses Stop
at second ten has not stopped the call already in flight — it will still report
its result, and if that write lands the run has quietly resumed after being
cancelled. That is the bug this file exists to prevent.
"""

from __future__ import annotations

import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
os.environ.setdefault("HERMES_HOME", tempfile.mkdtemp(prefix="pipeline-stop-test-"))

from hermes_cli import pipeline_executor as ex  # noqa: E402
from hermes_cli import pipelines_db as db  # noqa: E402
from hermes_cli import pipeline_runner as runner  # noqa: E402
from hermes_cli.pipeline_fake_adapter import FakeAdapter, scripted  # noqa: E402
from hermes_cli.pipeline_template import validate_template  # noqa: E402

TEMPLATE = {
    "schema_version": "1.0",
    "id": "stoppable",
    "version": "1.0.0",
    "name": "Stoppable",
    "start_step": "first",
    "inputs_schema": {"type": "object", "properties": {"topic": {"type": "string"}}},
    "limits": {"max_rework_cycles": 2, "max_step_executions": 20},
    "steps": [
        {
            "id": "first", "type": "agent", "profile": "writer",
            "instruction": "First",
            "output_schema": {"type": "object", "properties": {"a": {"type": "string"}}},
            "next": "second",
        },
        {
            "id": "second", "type": "agent", "profile": "writer",
            "instruction": "Second",
            "output_schema": {"type": "object", "properties": {"b": {"type": "string"}}},
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


def test_stop_puts_the_run_in_a_terminal_state():
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "t"})
    assert db.cancel_run(conn, run_id, reason="user pressed stop") is True
    assert db.get_run(conn, run_id).status == "cancelled"


def test_stop_forbids_new_steps():
    """The property that makes Stop mean something."""
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "t"})
    db.cancel_run(conn, run_id)
    adapter = FakeAdapter(scripted(first=[{"a": "x"}], second=[{"b": "y"}]))
    with pytest.raises(Exception):
        ex.advance(conn, run_id, adapter, owner="runner-1")
    assert adapter.calls == [], "a cancelled run must not pay for a step"
    assert db.get_run(conn, run_id).status == "cancelled"


def test_the_loop_reports_a_stopped_run_instead_of_crashing_on_it():
    """Cancelling is an outcome. A runner that raises on it takes the dispatcher
    with it and reports a failure nobody caused."""
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "t"})
    db.cancel_run(conn, run_id)
    adapter = FakeAdapter(scripted(first=[{"a": "x"}]))
    report = runner.drive_run(conn, run_id, adapter, owner="runner-1")
    assert report.status == "cancelled"
    assert "cancelled" in report.stop_reason
    assert adapter.calls == []
    assert db.get_run(conn, run_id).status == "cancelled"


class InFlightAdapter:
    """Answers `None` once, then hands the result over.

    `FakeAdapter` is synchronous — it answers the moment it is asked — so it
    cannot produce the situation check 9 is about: a call already in flight when
    the user presses Stop.
    """

    def __init__(self, output):
        self.output = output
        self.submitted = []
        self.answered = False

    def submit(self, request):
        self.submitted.append(dict(request))
        return "exec_inflight"

    def result(self, execution_id):
        if not self.answered:
            self.answered = True
            return None
        return ex.ExecutionResult(state="completed", output=self.output)

    def cancel(self, execution_id):
        return True


def test_a_late_result_cannot_revive_a_cancelled_run():
    """The core of check 9.

    The adapter was already in flight when Stop was pressed. Its answer arrives
    afterwards and must not complete the attempt, move the run, or start the
    next step.
    """
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "t"})
    adapter = InFlightAdapter({"a": "late answer"})

    # First advance submits and leaves the attempt running.
    outcome = ex.advance(conn, run_id, adapter, owner="runner-1")
    assert outcome.status == "in_flight"

    db.cancel_run(conn, run_id, reason="user pressed stop")

    # The adapter now has the answer. advance refuses the run outright, so the
    # late arrival has to be judged by what it did NOT manage to do.
    with pytest.raises(ValueError):
        ex.advance(conn, run_id, adapter, owner="runner-1")

    run = db.get_run(conn, run_id)
    assert run.status == "cancelled"
    assert [r["step_id"] for r in adapter.submitted] == ["first"], "only the step already in flight"
    assert all(a.status == "cancelled" for a in db.list_attempts(conn, run_id))


def test_a_terminal_attempt_is_never_rewritten():
    """The invariant, stated directly rather than through a run.

    Every late path — success, failure, unknown, restart reconciliation — ends
    at `finish_attempt`, so this one check covers all of them.
    """
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "t"})
    attempt_id = db.create_attempt(conn, run_id, "first")
    db.finish_attempt(conn, attempt_id, "completed", output={"a": "first answer"})

    # A late arrival with a different answer.
    db.finish_attempt(conn, attempt_id, "completed", output={"a": "different answer"})

    stored = db.get_attempt(conn, attempt_id)
    assert stored.output == {"a": "first answer"}
    assert stored.status == "completed"


def test_stop_marks_an_in_flight_attempt_cancelled():
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "t"})
    adapter = InFlightAdapter({"a": "x"})
    ex.advance(conn, run_id, adapter, owner="runner-1")  # leaves it running
    assert any(a.status == "running" for a in db.list_attempts(conn, run_id))
    db.cancel_run(conn, run_id)

    attempts = db.list_attempts(conn, run_id)
    assert all(a.status == "cancelled" for a in attempts)


def test_stopping_a_finished_run_is_refused_rather_than_pretending():
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "t"})
    adapter = FakeAdapter(scripted(first=[{"a": "x"}], second=[{"b": "y"}]))
    runner.drive_run(conn, run_id, adapter, owner="runner-1")
    assert db.get_run(conn, run_id).status == "completed"

    assert db.cancel_run(conn, run_id) is False
    assert db.get_run(conn, run_id).status == "completed", "a completed run stays completed"


def test_stopping_an_unknown_run_is_refused():
    conn = db.connect()
    assert db.cancel_run(conn, "run_nope") is False


def test_the_stop_is_recorded_as_an_event():
    """A run that stopped has to say why, to whoever reads the feed later."""
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "t"})
    db.cancel_run(conn, run_id, reason="user pressed stop")
    events = db.list_events(conn, run_id)
    assert any(event.type == "run.cancelled" for event in events)