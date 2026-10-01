"""#58 — the turn's cost reaches the report.

The storage layer landed in `a23ec6cdaa` and the turn snapshot in
`732b1485aa`. This is the wire between them: the executor writes what the
adapter measured, and a step that measured nothing still appears — marked
unknown — because a missing row and a measured zero are different facts.
"""

import pytest

from hermes_cli import pipeline_executor as executor
from hermes_cli import pipeline_usage as usage
from hermes_cli.pipeline_executor import ExecutionResult


TEMPLATE = {
    "id": "tpl", "version": "1",
    "steps": [{"id": "draft", "type": "agent", "instruction": "write",
               "output_schema": {"type": "object", "properties": {"ok": {"type": "boolean"}}}}],
}


@pytest.fixture()
def conn(tmp_path):
    from hermes_cli import pipelines_db as db

    c = db.connect(db_path=tmp_path / "pipelines.db")
    yield c
    c.close()


def attempt_for(conn, run_id, step_id="draft"):
    """A real `StepAttempt`, as the executor holds it -- `create_attempt` on
    its own only returns the id."""
    from hermes_cli import pipelines_db as db

    attempt_id = db.create_attempt(conn, run_id, step_id, iteration=0, attempt_no=1)
    return db.get_attempt(conn, attempt_id)


def run_for(conn):
    from hermes_cli import pipelines_db as db

    return db.create_run(conn, TEMPLATE, inputs={})


# --- the shape the adapter hands over -----------------------------------------


def test_a_delta_becomes_a_usage_record():
    from hermes_cli.pipeline_hermes_adapter import usage_record

    record = usage_record({"input": 120, "output": 40, "cache_read": 900},
                          step_id="draft", model="m", provider="p")
    assert record.input_tokens == 120
    assert record.output_tokens == 40
    assert record.cached_input == 900, "a cache hit is not fresh input"
    assert record.is_known is True


def test_no_delta_becomes_an_unknown_record_not_a_zero_one():
    from hermes_cli.pipeline_hermes_adapter import usage_record

    record = usage_record(None, step_id="draft")
    assert record is not None, "the row is still worth writing"
    assert record.input_tokens is None
    assert record.is_known is False


# --- persistence ---------------------------------------------------------------


def test_a_measured_attempt_is_recorded(conn):
    run_id = run_for(conn)
    attempt = attempt_for(conn, run_id)
    executor._record_usage(conn, run_id, attempt, ExecutionResult(
        state="completed", output={"ok": True},
        usage={"kind": "model", "input": 120, "output": 40, "cache_read": 0},
    ))
    report = usage.run_usage(conn, run_id)
    assert len(report["steps"]) == 1
    assert report["steps"][0]["input_tokens"] == 120
    assert report["steps"][0]["output_tokens"] == 40


def test_an_unmeasured_attempt_still_appears_in_the_report(conn):
    """The whole point: a step that measured nothing must not vanish.

    The report alone cannot tell "recorded as zero" from "not recorded", because
    both leave the cost unknown when the rate is unknown too. So the stored row
    is asserted directly: the token columns must be NULL, because a zero there
    is a number the system never measured, and it will eventually be priced as
    one.
    """
    run_id = run_for(conn)
    attempt = attempt_for(conn, run_id)
    executor._record_usage(conn, run_id, attempt, ExecutionResult(
        state="completed", output={"ok": True}, usage=None,
    ))
    report = usage.run_usage(conn, run_id)
    assert len(report["steps"]) == 1
    assert report["steps"][0]["cost_status"] == "unknown"
    assert report["cost_micros"] is None, "unmeasured must not read as free"

    row = conn.execute(
        "SELECT input_tokens, output_tokens, cached_input FROM step_usage "
        "WHERE run_id = ?", (run_id,),
    ).fetchone()
    assert row["input_tokens"] is None, "a fabricated zero would be priced later"
    assert row["output_tokens"] is None
    assert row["cached_input"] is None


def test_a_result_without_a_usage_attribute_at_all_is_handled(conn):
    """An adapter from before #58 has no `usage` attribute. It must not raise."""
    run_id = run_for(conn)
    attempt = attempt_for(conn, run_id)
    legacy = ExecutionResult(state="completed", output={"ok": True})
    del legacy.usage
    executor._record_usage(conn, run_id, attempt, legacy)
    assert usage.run_usage(conn, run_id)["steps"][0]["cost_status"] == "unknown"


def test_a_tool_result_is_not_recorded_as_a_model_turn(conn):
    run_id = run_for(conn)
    attempt = attempt_for(conn, run_id)
    executor._record_usage(conn, run_id, attempt, ExecutionResult(
        state="completed", output={"ok": True},
        usage={"kind": "tool", "tool_cost_micros": 0},
    ))
    assert usage.run_usage(conn, run_id)["steps"] == []


def test_recording_the_same_attempt_twice_replaces_rather_than_adds(conn):
    run_id = run_for(conn)
    attempt = attempt_for(conn, run_id)
    for value in (100, 250):
        executor._record_usage(conn, run_id, attempt, ExecutionResult(
            state="completed", output={"ok": True},
            usage={"kind": "model", "input": value, "output": 10, "cache_read": 0},
        ))
    report = usage.run_usage(conn, run_id)
    assert len(report["steps"]) == 1
    assert report["steps"][0]["input_tokens"] == 250


def test_accounting_failure_does_not_fail_the_run(conn):
    """A missing cost is a reporting gap; a lost artifact is a lost result."""
    run_id = run_for(conn)
    attempt = attempt_for(conn, run_id)

    def explode(*args, **kwargs):
        raise RuntimeError("usage table is gone")

    original = usage.price_and_record
    usage.price_and_record = explode
    try:
        executor._record_usage(conn, run_id, attempt, ExecutionResult(
            state="completed", output={"ok": True},
            usage={"kind": "model", "input": 10, "output": 1, "cache_read": 0},
        ))
    finally:
        usage.price_and_record = original


# --- the end-to-end shape ------------------------------------------------------


def test_two_attempts_of_a_rework_cycle_both_appear(conn):
    """A reworked step ran twice, so it is charged twice -- and says so."""
    from hermes_cli import pipelines_db as db

    run_id = run_for(conn)
    for attempt_no in (1, 2):
        attempt = db.get_attempt(conn, db.create_attempt(
            conn, run_id, "draft", iteration=attempt_no, attempt_no=1))
        executor._record_usage(conn, run_id, attempt, ExecutionResult(
            state="completed", output={"ok": True},
            usage={"kind": "model", "input": 100 * attempt_no, "output": 10,
                   "cache_read": 0},
        ))
    report = usage.run_usage(conn, run_id)
    assert len(report["steps"]) == 2
    assert sum(s["input_tokens"] for s in report["steps"]) == 300


def test_a_run_with_no_attempts_reports_unknown_not_zero(conn):
    run_id = run_for(conn)
    report = usage.run_usage(conn, run_id)
    assert report["cost_micros"] is None
    assert report["cost_status"] == "unknown"
