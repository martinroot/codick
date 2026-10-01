"""The run loop (spec §8, #34).

The interesting assertions are about *stopping*, not about progressing: a loop
that only ever advances is easy, and the four ways it can spin — against a
person who is not there, against a step whose outcome is unknown, against a
step that does not move, and forever — are the whole reason this module is not
a `while True`.
"""

from __future__ import annotations

import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
os.environ.setdefault("HERMES_HOME", tempfile.mkdtemp(prefix="pipeline-runner-test-"))

from hermes_cli import pipelines_db as db  # noqa: E402
from hermes_cli import pipeline_executor as ex  # noqa: E402
from hermes_cli import pipeline_runner as runner  # noqa: E402
from hermes_cli.pipeline_executor import ExecutionResult, UnknownOutcome  # noqa: E402
from hermes_cli.pipeline_fake_adapter import FakeAdapter, scripted  # noqa: E402
from hermes_cli.pipeline_template import validate_template  # noqa: E402

TEMPLATE = {
    "schema_version": "1.0",
    "id": "report",
    "version": "1.0.0",
    "name": "Report",
    "start_step": "draft",
    "inputs_schema": {
        "type": "object",
        "properties": {"topic": {"type": "string"}},
        "required": ["topic"],
    },
    "limits": {"max_rework_cycles": 3, "max_step_executions": 40},
    "steps": [
        {
            "id": "draft", "type": "agent", "profile": "writer",
            "instruction": "Write it",
            "input": {"topic": {"ref": "inputs.topic"}},
            "output_schema": {"type": "object", "properties": {"body": {"type": "string"}}},
            "next": "ask",
        },
        {
            "id": "ask", "type": "user_input",
            "prompt": "Approve the draft?",
            "response_schema": {"type": "object", "properties": {"ok": {"type": "boolean"}},
                                "required": ["ok"]},
            "next": "publish",
        },
        {
            "id": "publish", "type": "agent", "profile": "writer",
            "instruction": "Publish it",
            "output_schema": {"type": "object", "properties": {"url": {"type": "string"}}},
            "next": None,
        },
    ],
}

#: No person in this one, so the loop can be shown reaching a terminal state.
#: `draft.next` is rewired, not inherited — pointing it at the `ask` step that
#: was dropped is exactly the kind of dangling reference the executor refuses.
TWO_STEP = {
    **TEMPLATE,
    "id": "two-step",
    "start_step": "draft",
    "steps": [
        {**TEMPLATE["steps"][0], "next": "second"},
        {**TEMPLATE["steps"][2], "id": "second", "next": None},
    ],
}
assert validate_template(TWO_STEP) == []


@pytest.fixture(autouse=True)
def _isolated_home(monkeypatch, tmp_path):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))


def test_the_template_is_valid():
    assert validate_template(TEMPLATE) == []


def test_the_loop_drives_a_run_to_completion():
    conn = db.connect()
    run_id = db.create_run(conn, TWO_STEP, inputs={"topic": "kanban"})
    adapter = FakeAdapter(scripted(draft=[{"body": "x"}], second=[{"url": "u"}]))
    report = runner.drive_run(conn, run_id, adapter, owner="runner-1")
    assert report.status == "completed"
    assert report.stop_reason.startswith("parked")
    assert report.parked is True
    assert db.get_run(conn, run_id).status == "completed"


def test_a_live_attempt_is_never_submitted_twice():
    """A lease you already hold may be re-claimed, so the lease does not stop this.

    That re-claim is deliberate — it lets a dispatcher resume after losing its
    own connection — and it is exactly what let a second `advance` submit the
    same attempt again. Two Hermes turns then interleaved on one session, the
    transcript interleaved with them, and the step never completed. Seen live as
    three concurrent turns on one `session_id`.
    """
    conn = db.connect()
    run_id = db.create_run(conn, TWO_STEP, inputs={"topic": "kanban"})
    submitted = []

    class SlowAdapter(FakeAdapter):
        def submit(self, request):
            submitted.append(request["attempt_id"])
            return super().submit(request)

    adapter = SlowAdapter(scripted(draft=[{"body": "x"}], second=[{"url": "u"}]))
    runner.drive_run(conn, run_id, adapter, owner="runner-1")

    # One submission per attempt. A repeat is a second turn on the same session.
    assert len(submitted) == len(set(submitted)), submitted
    assert db.get_run(conn, run_id).status == "completed"


def test_the_driver_waits_for_a_submitted_turn_rather_than_leaving_it_orphaned():
    """A driver that returns mid-turn strands a `running` attempt forever.

    Nothing else collects the answer: `recover` is a restart path, not a
    poller. The observed symptom was a run that sat on `running` for ten
    minutes with an attempt nobody would ever read.
    """
    import threading

    conn = db.connect()
    run_id = db.create_run(conn, TWO_STEP, inputs={"topic": "kanban"})

    release = threading.Event()

    class SlowAdapter(FakeAdapter):
        def submit(self, request):
            execution_id = super().submit(request)
            timer = threading.Timer(0.4, release.set)
            timer.start()
            return execution_id

        def result(self, execution_id):
            # Hold the answer until the driver has demonstrably waited for it.
            if not release.is_set():
                release.wait(2.0)
            return super().result(execution_id)

    adapter = SlowAdapter(scripted(draft=[{"body": "x"}], second=[{"url": "u"}]))
    report = runner.drive_run(conn, run_id, adapter, owner="runner-1", in_flight_timeout=5.0)
    assert report.status == "completed", (report.status, report.details)
    assert release.is_set(), "the driver returned before the turn landed"


def test_the_loop_stops_at_a_person_and_says_so():
    """The property that matters most: it must not spin against a human."""
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "kanban"})
    adapter = FakeAdapter(scripted(draft=[{"body": "x"}]))
    report = runner.drive_run(conn, run_id, adapter, owner="runner-1")
    assert report.status == "waiting_input"
    assert "waiting_input" in report.stop_reason
    # Two advances: one runs the draft, the next reaches the request and parks.
    assert report.steps == 2


def test_the_declared_ceiling_is_reported_not_hidden():
    conn = db.connect()
    run_id = db.create_run(conn, TWO_STEP, inputs={"topic": "kanban"})
    adapter = FakeAdapter(scripted(draft=[{"body": "x"}], second=[{"url": "u"}]))
    report = runner.drive_run(conn, run_id, adapter, owner="runner-1", max_steps=1)
    assert "ceiling of 1" in report.stop_reason
    assert db.get_run(conn, run_id).status != "completed"


def test_a_step_that_never_moves_is_stopped_before_it_is_paid_for_twice(monkeypatch):
    """The backstop: success reported without advancing must not loop.

    A stubbed `advance` stands in for the failure this guards — a step that
    reports success while leaving `current_step_id` where it was. The real
    executor is not patched, so nothing else about the run is being faked.
    """
    conn = db.connect()
    run_id = db.create_run(conn, TWO_STEP, inputs={"topic": "kanban"})

    def always_progressing(*args, **kwargs):
        # Reports progress while the run itself never moves.
        return ex._AdvanceResult("running", "", step_id="draft")

    monkeypatch.setattr(runner, "advance", always_progressing)
    report = runner.drive_run(conn, run_id, FakeAdapter(), owner="runner-1")
    assert "changed neither the step" in report.stop_reason
    # The first advance establishes the baseline the rest fail to beat, so the
    # limit is one higher than the stall count itself.
    assert report.steps == runner._NO_PROGRESS_LIMIT + 1


def test_an_unknown_outcome_parks_the_run_instead_of_retrying_it():
    """`UnknownOutcome` is the absence of a failure, not a failure.

    `advance` is what turns it into `blocked` — the loop never sees the
    exception, and that is the point: the distinction is the executor's, and a
    second caller cannot turn "we do not know" into "it did not work".
    """
    from hermes_cli.pipeline_fake_adapter import unknown_outcome

    conn = db.connect()
    run_id = db.create_run(conn, TWO_STEP, inputs={"topic": "kanban"})
    adapter = FakeAdapter(scripted(draft=[unknown_outcome]))
    report = runner.drive_run(conn, run_id, adapter, owner="runner-1")
    assert report.status == "blocked"
    assert report.parked is True
    # One attempt, not retried into a second paid call on an unknown outcome.
    assert adapter.count_for("draft") == 1


def test_the_report_says_whether_a_person_is_needed():
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "kanban"})
    report = runner.drive_run(
        conn, run_id, FakeAdapter(scripted(draft=[{"body": "x"}])), owner="runner-1",
    )
    assert report.parked is True
    assert "waiting_input" in report.stop_reason


def test_a_second_owner_reruns_no_agent_work_on_a_parked_run():
    """A run parked at a person must not be paid for again by whoever calls next.

    `advance` does accept `waiting_input` — it has to, so an answered request
    can be consumed — so the guard here is that re-asking parks it again without
    submitting an agent turn. Asserting the second adapter made no calls is what
    distinguishes "parked again" from "ran the draft twice".
    """
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "kanban"})
    runner.drive_run(conn, run_id, FakeAdapter(scripted(draft=[{"body": "x"}])), owner="runner-1")
    second = FakeAdapter(scripted(draft=[{"body": "y"}]))
    runner.drive_run(conn, run_id, second, owner="runner-2")
    assert second.calls == []
    assert db.get_run(conn, run_id).status == "waiting_input"


def test_the_production_adapter_is_the_real_one():
    """There is exactly one place that decides which adapter is real."""
    from hermes_cli.pipeline_hermes_adapter import HermesStepAdapter

    assert isinstance(runner.build_default_adapter(), HermesStepAdapter)


def test_the_adapter_factory_is_used_when_given():
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "kanban"})
    built = []

    def factory():
        adapter = FakeAdapter(scripted(draft=[{"body": "x"}]))
        built.append(adapter)
        return adapter

    report = runner.drive_run(conn, run_id, None, owner="runner-1", adapter_factory=factory)
    assert built and report.status == "waiting_input"


def test_an_unknown_run_is_reported_not_silently_ok():
    conn = db.connect()
    with pytest.raises(Exception):
        runner.drive_run(conn, "run_does_not_exist", FakeAdapter(), owner="runner-1")