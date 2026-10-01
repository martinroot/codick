"""#56 — dispatch starts the work once, and writes back what happened.

The properties that matter operationally are all about *restraint*: one delivery
does not start two runs, an unroutable task does not get an invented owner, and
a replayed writeback does not ask the same question twice.
"""

import json
from dataclasses import replace

import pytest

from hermes_cli import task_dispatch as dispatch
from hermes_cli.sqlite_util import write_txn
from hermes_cli import task_ingress as ingress
from hermes_cli import task_routing as routing
from hermes_cli.task_routing import Rule

TEMPLATE = {"id": "tpl", "version": "1", "steps": []}


@pytest.fixture()
def conn(tmp_path):
    """A private database per test.

    The sandbox ``HERMES_HOME`` is per *session*, so the default ingress path is
    shared by every test in the run -- and keying them all on ('todo', 'e1')
    let one test's state leak into the next. Same isolation ``test_task_ingress``
    uses.
    """
    with ingress.connect_closing(tmp_path / "ingress.db") as connection:
        yield connection


@pytest.fixture()
def run_factory():
    """A stand-in for ``pipelines_db.create_run``.

    The ingress connection has no pipelines schema, and this layer is not what
    should be testing run creation -- that belongs to the pipeline tests. What
    belongs here is that dispatch calls it once, with the enriched inputs.
    """
    calls = []

    def create(connection, template, *, inputs=None, now=None, **kwargs):
        calls.append({"template": template, "inputs": inputs})
        return f"run_stub_{len(calls)}"

    create.calls = calls
    return create


def claim(conn, **fields):
    """A durable task plus the event that delivered it, via the real API."""
    return ingress.upsert_task(conn, platform="todo", external_id="e1", **fields)


def reloaded(conn):
    return ingress.get_task(conn, platform="todo", external_id="e1")


def test_a_routed_task_starts_exactly_one_run(conn, run_factory):
    task = claim(conn, profile="ops-agent")
    result = dispatch.dispatch(conn, task, TEMPLATE, create_run=run_factory)
    assert result.created is True
    assert result.run_id
    assert result.dispatch_reason == "dispatched from a routed delivery"
    assert len(run_factory.calls) == 1


def test_a_redelivery_does_not_start_a_second_run(conn, run_factory):
    """Webhooks repeat and users re-save. Two runs means paying for two."""
    task = claim(conn, profile="ops-agent")
    first = dispatch.dispatch(conn, task, TEMPLATE, create_run=run_factory)
    again = dispatch.dispatch(conn, task, TEMPLATE, create_run=run_factory)
    assert again.run_id == first.run_id
    assert again.created is False
    assert "already" in again.dispatch_reason


def test_a_redelivery_that_reclaims_from_scratch_still_reuses_the_run(conn, run_factory):
    """The retry arrives as a new process with an empty object; the binding is
    in the database, not in memory."""
    task = claim(conn, profile="ops-agent")
    first = dispatch.dispatch(conn, task, TEMPLATE, create_run=run_factory)
    fresh = reloaded(conn)
    again = dispatch.dispatch(conn, fresh, TEMPLATE, create_run=run_factory)
    assert again.run_id == first.run_id
    assert again.created is False


# --- enrichment is recorded, not inferred ------------------------------------


def test_the_routed_profile_travels_into_the_inputs(conn, run_factory):
    task = claim(conn)
    task = replace(task, profile=None)
    result = dispatch.dispatch(
        conn, task, TEMPLATE,
        rules=[Rule(name="channel:ops", channel=None, profile="ops-agent")],
        default_profile="house-agent",
        create_run=run_factory,
    )
    assert result.inputs["profile"] == "house-agent"
    assert result.routing_source == "default"


def test_the_routing_decision_travels_with_the_result(conn, run_factory):
    task = claim(conn, profile="named-agent")
    result = dispatch.dispatch(conn, task, TEMPLATE, create_run=run_factory)
    assert result.routing_source == "task.profile"
    assert "named a profile" in result.routing_reason


def test_sender_detail_is_kept_under_a_reserved_key(conn, run_factory):
    """A key collision must not make a routing decision look like the sender
    chose it."""
    task = claim(conn, profile="ops-agent")
    # `write_txn`, not a bare execute: a raw UPDATE opens an implicit
    # transaction, and the next `write_txn` refuses to nest.
    with write_txn(conn):
        conn.execute(
            "UPDATE external_tasks SET detail_json = ? "
            "WHERE platform='todo' AND external_id='e1'",
            (json.dumps({"profile": "spoofed"}),),
        )
    task = reloaded(conn)
    result = dispatch.dispatch(conn, task, TEMPLATE, create_run=run_factory)
    assert result.inputs["profile"] == "ops-agent", "the route wins, not the payload"
    assert result.inputs["task_detail"] == {"profile": "spoofed"}


def test_the_correlation_id_travels_with_the_run(conn, run_factory):
    task = claim(conn, profile="ops-agent")
    result = dispatch.dispatch(conn, task, TEMPLATE, create_run=run_factory)
    assert result.inputs["correlation_id"] == task.correlation_id
    assert result.correlation_id == task.correlation_id


# --- the refusal -------------------------------------------------------------


def test_an_unroutable_task_raises_rather_than_guessing(conn, run_factory):
    task = claim(conn)
    task = replace(task, profile=None)
    with pytest.raises(dispatch.DispatchError) as excinfo:
        dispatch.dispatch(conn, task, TEMPLATE, create_run=run_factory)
    assert "no rule matched" in str(excinfo.value)


def test_an_unroutable_task_is_left_visible_as_unrouted(conn, run_factory):
    task = claim(conn)
    task = replace(task, profile=None)
    with pytest.raises(dispatch.DispatchError):
        dispatch.dispatch(conn, task, TEMPLATE, create_run=run_factory)
    stored = ingress.get_task(conn, platform="todo", external_id="e1")
    assert stored.state == dispatch.STATE_UNROUTED
    assert stored.run_id is None


def test_a_creation_failure_is_raised_not_swallowed(conn):
    task = claim(conn, profile="ops-agent")

    def broken(connection, template, *, inputs=None, now=None):
        return ""

    with pytest.raises(dispatch.DispatchError) as excinfo:
        dispatch.dispatch(conn, task, TEMPLATE, create_run=broken)
    assert "no run id" in str(excinfo.value)


# --- writeback ---------------------------------------------------------------


def test_a_state_writeback_is_idempotent(conn):
    task = claim(conn, profile="ops-agent")
    running = dispatch.writeback_state(conn, task, dispatch.STATE_RUNNING)
    assert running.state == dispatch.STATE_RUNNING
    # The same state again is a no-op, not a redundant write.
    assert dispatch.writeback_state(conn, running, dispatch.STATE_RUNNING) is running
    assert reloaded(conn).state == dispatch.STATE_RUNNING


def test_a_state_change_is_applied_once_and_sticks(conn):
    task = claim(conn, profile="ops-agent")
    running = dispatch.writeback_state(conn, task, dispatch.STATE_RUNNING)
    dispatch.writeback_state(conn, running, dispatch.STATE_WAITING)
    assert reloaded(conn).state == dispatch.STATE_WAITING


def test_a_question_is_asked_once(conn):
    """A user answering the same prompt twice is a bug report, not a feature."""
    task = claim(conn, profile="ops-agent")
    first = dispatch.writeback_question(conn, task, "Which account?", now=1.0)
    assert first is not task, "the first ask should change something"
    # The same prompt again returns the same object: nothing was written.
    assert dispatch.writeback_question(conn, first, "Which account?", now=2.0) is first
    stored = reloaded(conn)
    assert len(stored.detail["questions"]) == 1


def test_a_different_question_is_asked_separately(conn):
    task = claim(conn, profile="ops-agent")
    first = dispatch.writeback_question(conn, task, "Which account?", now=1.0)
    dispatch.writeback_question(conn, first, "Which region?", now=2.0)
    stored = reloaded(conn)
    assert [q["prompt"] for q in stored.detail["questions"]] == [
        "Which account?", "Which region?"]


def test_a_question_carries_the_correlation_id(conn):
    task = claim(conn, profile="ops-agent")
    dispatch.writeback_question(conn, task, "Which account?", now=1.0)
    stored = reloaded(conn)
    assert stored.detail["questions"][0]["correlation_id"] == task.correlation_id


def test_an_artifact_is_recorded_once(conn):
    task = claim(conn, profile="ops-agent")
    recorded = dispatch.writeback_artifact(conn, task, "art_1", "report.pdf")
    assert recorded is not task, "recording should change something"
    assert dispatch.writeback_artifact(conn, recorded, "art_1", "report.pdf") is recorded
    stored = reloaded(conn)
    assert len(stored.detail["artifacts"]) == 1
    assert stored.detail["artifacts"][0]["name"] == "report.pdf"


def test_two_artifacts_are_both_recorded(conn):
    task = claim(conn, profile="ops-agent")
    first = dispatch.writeback_artifact(conn, task, "art_1", "a.pdf")
    dispatch.writeback_artifact(conn, first, "art_2", "b.pdf")
    stored = reloaded(conn)
    assert [a["artifact_id"] for a in stored.detail["artifacts"]] == ["art_1", "art_2"]


def test_an_artifact_falls_back_to_its_id_for_a_name(conn):
    task = claim(conn, profile="ops-agent")
    dispatch.writeback_artifact(conn, task, "art_1")  # no name given
    stored = reloaded(conn)
    assert stored.detail["artifacts"][0]["name"] == "art_1"


def test_questions_and_artifacts_share_one_detail_without_clobbering(conn):
    task = claim(conn, profile="ops-agent")
    asked = dispatch.writeback_question(conn, task, "Which account?", now=1.0)
    dispatch.writeback_artifact(conn, asked, "art_1", "a.pdf", now=1.0)
    stored = reloaded(conn)
    assert len(stored.detail["questions"]) == 1
    assert len(stored.detail["artifacts"]) == 1
