"""#58 — what a run actually cost.

The contract this file defends is the difference between a measurement and a
plausible-looking number:

- unknown is never zero;
- cached input is priced apart from ordinary input;
- the rate that applied is kept with the number it priced;
- a tool step appears even when it costs nothing.

Each of those has a test that fails if the property is removed, and the
unknown-vs-zero ones are checked through the **reported total**, because that is
where a wrong value would actually mislead.
"""

import pytest

from hermes_cli import pipelines_db as db
from hermes_cli import pipeline_usage as usage


@pytest.fixture()
def conn(tmp_path):
    connection = db.connect(db_path=tmp_path / "pipelines.db")
    try:
        yield connection
    finally:
        connection.close()


TEMPLATE = {
    "id": "tpl", "version": "1", "start_step": "a",
    "steps": [{"id": "a", "kind": "agent", "prompt": "x",
               "output_schema": {"type": "object"}}],
}


@pytest.fixture()
def run(conn):
    return db.create_run(conn, TEMPLATE, inputs={})


def attempt(conn, run_id, *, step_id="draft", attempt_no=1):
    """A real attempt row. Usage rows reference it, and the FK is doing its job:
    a fabricated attempt id is refused rather than silently accepted."""
    return db.create_attempt(conn, run_id, step_id, iteration=0, attempt_no=attempt_no)


RATE = dict(rate_key="or-sb-1", provider="openrouter", model="stealth/space-bunny-alpha",
            input_micros=100, cached_micros=10, output_micros=300, effective_from=1_000_000)


def model_step(**over) -> usage.Usage:
    base = dict(step_id="draft", kind="model", model="stealth/space-bunny-alpha",
                provider="openrouter", input_tokens=1000, cached_input=0, output_tokens=500)
    base.update(over)
    return usage.Usage(**base)


# --- unknown is not zero ------------------------------------------------------


def test_a_silent_provider_is_unknown_not_zero(conn, run):
    usage.upsert_rate(conn, **RATE)
    usage.price_and_record(
        conn, run_id=run, attempt_id=None,
        usage=model_step(input_tokens=None, cached_input=None, output_tokens=None),
    )
    report = usage.run_usage(conn, run)
    assert report["cost_status"] == "unknown"
    assert report["cost_micros"] is None
    assert report["unpriced_steps"] == 1
    assert report["steps"][0]["input_tokens"] is None


def test_a_missing_rate_is_unknown_not_free(conn, run):
    # Tokens are known, the tariff is not. Pricing them at zero would put a
    # real cost into the world as a free run.
    usage.price_and_record(conn, run_id=run, attempt_id=None, usage=model_step())
    report = usage.run_usage(conn, run)
    assert report["cost_status"] == "unknown"
    assert report["cost_micros"] is None


def test_an_unknown_step_does_not_poison_a_known_total_into_a_false_claim(conn, run):
    usage.upsert_rate(conn, **RATE)
    usage.price_and_record(conn, run_id=run, attempt_id=None, usage=model_step(step_id="a"))
    usage.price_and_record(conn, run_id=run, attempt_id=None,
                           usage=model_step(step_id="b", input_tokens=None, cached_input=None,
                                            output_tokens=None))
    report = usage.run_usage(conn, run)
    assert report["cost_status"] == "unknown"
    # The known part is still reported, but the run total refuses to claim a
    # number that would be wrong by an unknown amount.
    assert report["steps_counted"] == 1
    assert report["steps"][0]["cost_micros"] is not None


# --- cached input is not input ----------------------------------------------


def test_cached_tokens_are_priced_at_their_own_rate(conn, run):
    usage.upsert_rate(conn, **RATE)
    u = model_step(input_tokens=0, cached_input=1000, output_tokens=0)
    usage.price_and_record(conn, run_id=run, attempt_id=None, usage=u)
    step = usage.run_usage(conn, run)["steps"][0]
    assert step["cost_micros"] == 1000 * 10


def test_cached_and_input_totals_are_reported_separately(conn, run):
    usage.upsert_rate(conn, **RATE)
    usage.price_and_record(conn, run_id=run, attempt_id=None,
                           usage=model_step(input_tokens=1000, cached_input=400))
    report = usage.run_usage(conn, run)
    assert report["input_tokens_total"] == 1000
    assert report["cached_input_total"] == 400


def test_a_run_without_a_cached_rate_does_not_under_report(conn, run):
    no_cached = dict(RATE)
    no_cached.pop("cached_micros")
    usage.upsert_rate(conn, **no_cached)
    usage.price_and_record(conn, run_id=run, attempt_id=None,
                           usage=model_step(input_tokens=0, cached_input=1000, output_tokens=0))
    # Priced as ordinary input rather than dropped: under-reporting is worse.
    assert usage.run_usage(conn, run)["steps"][0]["cost_micros"] == 1000 * 100


# --- the applied rate is kept ------------------------------------------------


def test_the_rate_is_snapshotted_onto_the_row(conn, run):
    usage.upsert_rate(conn, **RATE)
    usage.price_and_record(conn, run_id=run, attempt_id=None, usage=model_step())
    step = usage.run_usage(conn, run)["steps"][0]
    assert step["rate_key"] == "or-sb-1"


def test_changing_the_rate_does_not_rewrite_a_past_run(conn, run):
    usage.upsert_rate(conn, **RATE)
    usage.price_and_record(conn, run_id=run, attempt_id=None, usage=model_step())
    before = usage.run_usage(conn, run)["steps"][0]["cost_micros"]

    usage.upsert_rate(conn, **dict(RATE, input_micros=999, output_micros=999))
    after = usage.run_usage(conn, run)["steps"][0]["cost_micros"]
    assert before == after


def test_the_newest_rate_is_the_one_applied(conn, run):
    usage.upsert_rate(conn, **RATE)
    usage.upsert_rate(conn, **dict(RATE, rate_key="new", input_micros=200,
                                   effective_from=2_000_000))
    usage.price_and_record(conn, run_id=run, attempt_id=None, usage=model_step())
    assert usage.run_usage(conn, run)["steps"][0]["rate_key"] == "new"


# --- tool steps ---------------------------------------------------------------


def test_a_free_tool_step_still_appears(conn, run):
    """A DOCX export has no token cost. It must not vanish, or the run looks
    cheaper than it was."""
    usage.price_and_record(
        conn, run_id=run, attempt_id=None,
        usage=usage.Usage(step_id="publish", kind="tool", tool_cost_micros=0),
    )
    report = usage.run_usage(conn, run)
    assert report["cost_status"] == "known"
    assert report["cost_micros"] == 0
    assert report["tool_steps"] == 1
    assert report["steps"][0]["step_id"] == "publish"


def test_a_tool_with_an_uncosted_result_is_unknown(conn, run):
    usage.price_and_record(
        conn, run_id=run, attempt_id=None,
        usage=usage.Usage(step_id="publish", kind="tool", tool_cost_micros=None),
    )
    assert usage.run_usage(conn, run)["cost_status"] == "unknown"


def test_a_tool_cost_is_not_derived_from_tokens(conn, run):
    usage.upsert_rate(conn, **RATE)
    usage.price_and_record(
        conn, run_id=run, attempt_id=None,
        usage=usage.Usage(step_id="publish", kind="tool", tool_cost_micros=7,
                          input_tokens=999, output_tokens=999),
    )
    assert usage.run_usage(conn, run)["steps"][0]["cost_micros"] == 7


# --- rework, review, re-import ------------------------------------------------


def test_a_rework_cycle_costs_twice_because_it_ran_twice(conn, run):
    usage.upsert_rate(conn, **RATE)
    usage.price_and_record(conn, run_id=run, attempt_id=attempt(conn, run, attempt_no=1),
                           usage=model_step(step_id="draft"))
    usage.price_and_record(conn, run_id=run, attempt_id=attempt(conn, run, attempt_no=2),
                           usage=model_step(step_id="draft"))
    report = usage.run_usage(conn, run)
    assert report["steps_counted"] == 2
    assert report["cost_micros"] == 2 * (1000 * 100 + 500 * 300)


def test_re_recording_one_attempt_replaces_rather_than_adds(conn, run):
    usage.upsert_rate(conn, **RATE)
    first = attempt(conn, run)
    usage.price_and_record(conn, run_id=run, attempt_id=first, usage=model_step(step_id="draft"))
    usage.price_and_record(conn, run_id=run, attempt_id=first, usage=model_step(step_id="draft"))
    assert usage.run_usage(conn, run)["steps_counted"] == 1


def test_runs_do_not_leak_into_each_other(conn, run):
    usage.upsert_rate(conn, **RATE)
    other = db.create_run(conn, dict(TEMPLATE, id="t2"), inputs={})
    usage.price_and_record(conn, run_id=run, attempt_id=None, usage=model_step())
    assert usage.run_usage(conn, other)["steps"] == []
    assert usage.run_usage(conn, other)["cost_micros"] is None


def test_an_empty_run_reports_unknown_rather_than_zero(conn, run):
    report = usage.run_usage(conn, run)
    assert report["steps"] == []
    assert report["cost_micros"] is None
    assert report["cost_status"] == "unknown"