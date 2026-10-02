"""The executor (spec §7) against a deterministic adapter (spec §8).

The scenario the issue asks for — agent -> review -> condition, with the
rework branch exercised — is the first half of this file. The rest is the set
of properties that scenario alone would not catch: the counters staying
independent, `blocked` not collapsing into `failed`, a ref to a step that a
condition never took, and the lease that stops a second dispatcher.

Run with pytest, or directly (pytest is not installed in every environment):

    python3 tests/hermes_cli/test_pipeline_executor.py
"""

from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
os.environ.setdefault("HERMES_HOME", tempfile.mkdtemp(prefix="pipeline-executor-test-"))

from hermes_cli import pipeline_executor as ex  # noqa: E402
from hermes_cli import pipelines_db as db  # noqa: E402
from hermes_cli.pipeline_fake_adapter import (  # noqa: E402
    FakeAdapter, scripted, unknown_outcome,
)
from hermes_cli.pipeline_template import validate_template  # noqa: E402

TEMPLATE = {
    "schema_version": "1.0",
    "id": "word-report",
    "version": "1.0.0",
    "name": "Word report",
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
            "instruction": "Write the report",
            "input": {"topic": {"ref": "inputs.topic"}},
            "output_schema": {"type": "object", "properties": {"body": {"type": "string"}}},
            "next": "review",
        },
        {
            "id": "review", "type": "agent", "profile": "reviewer",
            "instruction": "Review the draft",
            "input": {"body": {"ref": "steps.draft.output.body"}},
            "output_schema": {"type": "object", "properties": {"approved": {"type": "boolean"}}},
            # `retry` lives on the step, not in `limits`.
            "retry": {"max_attempts": 2},
            "next": "gate",
        },
        {
            "id": "gate", "type": "condition",
            "cases": [
                {"when": {"op": "eq", "left": {"ref": "steps.review.output.approved"}, "right": True},
                 "next": "publish", "rework": False},
                {"when": {"op": "eq", "left": {"ref": "steps.review.output.approved"}, "right": False},
                 "next": "draft", "rework": True},
            ],
            "default": {"fail": "reviewer returned neither approval nor rejection"},
        },
        {"id": "publish", "type": "tool", "tool": "documents.export_docx",
         "instruction": "Export", "next": None},
    ],
}


def _drain(conn, run_id, adapter, *, owner="dispatcher-1", limit=25):
    """Call advance until the run stops moving."""
    for _ in range(limit):
        run = db.get_run(conn, run_id)
        if run.status in db.TERMINAL_RUN_STATUSES:
            break
        result = ex.advance(conn, run_id, adapter, owner=owner)
        if result.status in ("waiting_input", "blocked", "contended", "failed", "completed"):
            break
    return db.get_run(conn, run_id)


def test_scenario_template_is_valid():
    assert validate_template(TEMPLATE) == []


def test_happy_path_completes():
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "kanban"})
    adapter = FakeAdapter(scripted(
        draft=[{"body": "first draft"}],
        review=[{"approved": True}],
        publish=[{"file": "report.docx"}],
    ))
    run = _drain(conn, run_id, adapter)
    assert run.status == "completed", run.error
    assert run.rework_cycles == 0
    # draft, review, the condition, publish.
    assert run.step_executions == 4, run.step_executions
    assert adapter.count_for("draft") == 1
    assert adapter.count_for("publish") == 1
    assert all(a.status == "completed" for a in db.list_attempts(conn, run_id))
    assert "publish" in (run.result or {})


def test_rework_branch_loops_back():
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "kanban"})
    adapter = FakeAdapter(scripted(
        draft=[{"body": "v1"}, {"body": "v2"}],
        review=[{"approved": False}, {"approved": True}],
        publish=[{}],
    ))
    run = _drain(conn, run_id, adapter)
    assert run.status == "completed", run.error
    assert run.rework_cycles == 1
    assert adapter.count_for("draft") == 2
    assert adapter.count_for("review") == 2
    # draft, review, gate, draft, review, gate, publish.
    assert run.step_executions == 7, run.step_executions
    transitions = [e for e in db.list_events(conn, run_id) if e.type == "step.transition"]
    assert any(t.payload and t.payload.get("rework") for t in transitions)


def test_rework_is_bounded():
    conn = db.connect()
    template = dict(TEMPLATE, limits={"max_rework_cycles": 2, "max_step_executions": 60})
    run_id = db.create_run(conn, template, inputs={"topic": "kanban"})
    adapter = FakeAdapter(scripted(
        draft=[{"body": f"v{i}"} for i in range(10)],
        review=[{"approved": False}],
    ))
    run = _drain(conn, run_id, adapter)
    assert run.status == "failed"
    assert run.error_code == "rework_exhausted"
    # The initial run plus exactly two reworks.
    assert adapter.count_for("draft") == 3, adapter.count_for("draft")


def test_technical_retry_is_not_a_rework_cycle():
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "kanban"})
    adapter = FakeAdapter(scripted(
        draft=[ex.AdapterError("transient blip", error_code="transient"), {"body": "second try"}],
        review=[{"approved": True}],
        publish=[{}],
    ))
    run = _drain(conn, run_id, adapter)
    assert run.status == "completed", run.error
    assert adapter.count_for("draft") == 2
    assert run.rework_cycles == 0
    # The retry counts against retry.max_attempts, not against activations.
    assert run.step_executions == 4, run.step_executions


def test_access_error_is_never_retried():
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "kanban"})
    adapter = FakeAdapter(scripted(draft=[ex.AccessError("no such profile"), {"body": "unreachable"}]))
    run = _drain(conn, run_id, adapter)
    assert adapter.count_for("draft") == 1
    assert run.status == "failed"
    assert run.error_code == "access_denied"


def test_unknown_outcome_blocks_rather_than_fails():
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "kanban"})
    adapter = FakeAdapter(scripted(draft=[unknown_outcome, {"body": "unreachable"}]))
    run = _drain(conn, run_id, adapter)
    assert run.status == "blocked", run.status
    assert run.status not in db.TERMINAL_RUN_STATUSES
    assert adapter.count_for("draft") == 1
    assert [a.status for a in db.list_attempts(conn, run_id)] == ["unknown"]


def test_max_step_executions_counts_conditions():
    conn = db.connect()
    template = dict(TEMPLATE, limits={"max_rework_cycles": 3, "max_step_executions": 2})
    run_id = db.create_run(conn, template, inputs={"topic": "kanban"})
    # The draft must actually produce `body`, or `review` fails on its own ref
    # and the run lands in `ref_unavailable` — the cap is never reached, and
    # the test would pass `status == "failed"` for the wrong reason entirely.
    adapter = FakeAdapter(scripted(draft=[{"body": "b"}], review=[{"approved": True}], publish=[{}]))
    run = _drain(conn, run_id, adapter)
    assert run.status == "failed"
    assert run.error_code == "step_executions_exhausted", run.error_code


def test_recover_does_not_resubmit_an_unknown_execution():
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "kanban"})
    adapter = FakeAdapter(scripted(draft=[{"body": "x"}]))
    ex.advance(conn, run_id, adapter, owner="dispatcher-1")
    db.set_run_scheduling(conn, run_id, current_step_id="review")
    # A crash between start_attempt and the result: running, with an
    # execution_id from a process that no longer exists.
    attempt = db.create_attempt(conn, run_id, "review", attempt_no=1)
    db.start_attempt(conn, attempt, execution_id="exec_from_a_previous_process")

    forgetting = FakeAdapter(forget_on_restart=True)
    ex.recover(conn, forgetting, owner="dispatcher-2")

    run = db.get_run(conn, run_id)
    assert run.status == "blocked", run.status
    assert db.get_attempt(conn, attempt).status == "unknown"
    assert forgetting.calls == [], "recovery must never resubmit a possibly-effectful call"


def test_recover_adopts_a_result_the_adapter_still_has():
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "kanban"})
    adapter = FakeAdapter(scripted(draft=[{"body": "x"}], review=[{"approved": True}]))
    ex.advance(conn, run_id, adapter, owner="dispatcher-1")
    db.set_run_scheduling(conn, run_id, current_step_id="review")
    # The execution the adapter still knows about, submitted but never
    # recorded — exactly the window a crash opens.
    attempt = db.create_attempt(conn, run_id, "review", attempt_no=1)
    execution_id = adapter.submit({"run_id": run_id, "step_id": "review", "attempt_id": attempt})
    db.start_attempt(conn, attempt, execution_id=execution_id)

    ex.recover(conn, adapter, owner="dispatcher-2")
    assert db.get_attempt(conn, attempt).status == "completed", db.get_attempt(conn, attempt).status
    assert db.get_attempt(conn, attempt).output == {"approved": True}
    # The run moved on rather than being resubmitted.
    assert db.get_run(conn, run_id).status == "running"


def test_user_input_holds_no_worker():
    conn = db.connect()
    template = dict(TEMPLATE, steps=[
        {"id": "draft", "type": "agent", "profile": "w", "instruction": "Draft",
         "input": {}, "next": "ask"},
        {"id": "ask", "type": "user_input", "prompt": "Approve?",
         "response_schema": {"type": "object"}, "wait_timeout_seconds": 600, "next": "publish"},
        {"id": "publish", "type": "tool", "tool": "t", "instruction": "Export", "next": None},
    ])
    run_id = db.create_run(conn, template, inputs={"topic": "x"})
    adapter = FakeAdapter(scripted(draft=[{}], publish=[{}]))
    run = _drain(conn, run_id, adapter)
    assert run.status == "waiting_input", run.status
    assert len([r for r in db.list_input_requests(conn, run_id) if r.status == "open"]) == 1
    # The timeout is a stored deadline, not a timer that needs a live worker.
    assert run.deadline is not None
    assert adapter.count_for("publish") == 0


def test_a_ref_to_an_untaken_branch_uses_its_default():
    conn = db.connect()
    template = dict(TEMPLATE, steps=[
        {"id": "draft", "type": "agent", "profile": "w", "instruction": "Draft", "input": {}, "next": "gate"},
        {"id": "gate", "type": "condition",
         "cases": [{"when": {"op": "exists", "left": {"ref": "steps.optional.output.x"}},
                    "next": "uses_optional"}],
         "default": {"next": "skips_optional"}},
        {"id": "uses_optional", "type": "tool", "tool": "t", "instruction": "Use",
         "input": {"v": {"ref": "steps.optional.output.x"}}},
        {"id": "skips_optional", "type": "tool", "tool": "t", "instruction": "Skip",
         "input": {"v": {"ref": "steps.optional.output.x", "optional": True, "default": "fallback"}}},
    ])
    run_id = db.create_run(conn, template, inputs={"topic": "x"})
    adapter = FakeAdapter(scripted(draft=[{}], uses_optional=[{}], skips_optional=[{}]))
    run = _drain(conn, run_id, adapter)
    assert run.status == "completed", run.error
    assert adapter.calls_for("skips_optional")[0]["input"] == {"v": "fallback"}


def test_a_required_ref_that_is_unavailable_fails_without_calling_the_adapter():
    conn = db.connect()
    template = dict(TEMPLATE, steps=[
        {"id": "draft", "type": "agent", "profile": "w", "instruction": "Draft", "input": {}, "next": "uses"},
        {"id": "uses", "type": "tool", "tool": "t", "instruction": "Use",
         "input": {"v": {"ref": "steps.optional.output.x"}}},
    ])
    run_id = db.create_run(conn, template, inputs={"topic": "x"})
    adapter = FakeAdapter(scripted(draft=[{}], uses=[{}, {}]))
    run = _drain(conn, run_id, adapter)
    assert run.status == "failed"
    assert run.error_code == "ref_unavailable"
    # The ref fails before submit, so a retry could not have helped.
    assert adapter.count_for("uses") == 0


# --- The lease -------------------------------------------------------------------

def test_lease_is_exclusive_and_expires():
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "x"})
    attempt = db.create_attempt(conn, run_id, "draft", attempt_no=1)
    t0 = 1000
    assert db.claim_attempt(conn, attempt, "A", ttl_seconds=60, now=t0) is True
    assert db.claim_attempt(conn, attempt, "B", ttl_seconds=60, now=t0) is False
    assert db.claim_attempt(conn, attempt, "A", ttl_seconds=60, now=t0 + 5) is True
    assert db.heartbeat_attempt(conn, attempt, "A", ttl_seconds=60, now=t0 + 10) is True
    assert db.heartbeat_attempt(conn, attempt, "B", ttl_seconds=60, now=t0 + 10) is False
    assert db.claim_attempt(conn, attempt, "B", ttl_seconds=60, now=t0 + 30) is False
    # The last heartbeat was at t0+10 with a 60s ttl, so the lease lives to t0+70.
    assert db.claim_attempt(conn, attempt, "B", ttl_seconds=60, now=t0 + 71) is True
    assert db.release_attempt(conn, attempt, "A") is False
    assert db.release_attempt(conn, attempt, "B") is True
    assert db.get_attempt(conn, attempt).lease_owner is None


def test_a_contending_dispatcher_never_reaches_the_adapter():
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "x"})
    adapter = FakeAdapter(scripted(draft=[{"body": "x"}], review=[{"approved": True}], publish=[{}]))
    # `advance` is synchronous, so contention is set up the way a crash or a
    # second dispatcher would leave it.
    attempt = db.create_attempt(conn, run_id, "draft", attempt_no=1)
    db.start_attempt(conn, attempt, execution_id="exec_held_by_A")
    assert db.claim_attempt(conn, attempt, "dispatcher-A", ttl_seconds=300) is True

    calls_before = len(adapter.calls)
    result = ex.advance(conn, run_id, adapter, owner="dispatcher-B")
    assert result.status == "contended", result.status
    assert len(adapter.calls) == calls_before
    assert db.get_attempt(conn, attempt).lease_owner == "dispatcher-A"


# --- Answering a request, and the race between two surfaces ------------------

def _user_input_template():
    return {
        "schema_version": "1.0", "id": "t", "version": "1.0.0", "name": "T", "start_step": "draft",
        "inputs_schema": {"type": "object", "properties": {}, "required": []},
        "steps": [
            {"id": "draft", "type": "agent", "profile": "w", "instruction": "D", "input": {}, "next": "ask"},
            {"id": "ask", "type": "user_input", "prompt": "Approve?",
             "response_schema": {"type": "object"}, "wait_timeout_seconds": 600, "next": "publish"},
            {"id": "publish", "type": "tool", "tool": "t", "instruction": "E", "next": None},
        ],
    }


def _run_to_waiting_input(conn, template=None):
    run_id = db.create_run(conn, template or _user_input_template(), inputs={})
    adapter = FakeAdapter(scripted(draft=[{}], publish=[{}]))
    ex.advance(conn, run_id, adapter, owner="d")
    ex.advance(conn, run_id, adapter, owner="d")  # opens the request
    assert db.get_run(conn, run_id).status == "waiting_input"
    open_requests = [r for r in db.list_input_requests(conn, run_id) if r.status == "open"]
    assert len(open_requests) == 1
    return run_id, open_requests[0].id, adapter


def test_an_answered_request_can_actually_be_resumed():
    """A response that cannot be consumed is a response that does not exist.

    ``advance`` used to accept only ``queued``/``running``, so a run that had
    accepted a response sat in ``waiting_input`` and refused every attempt to
    continue — the accept succeeded and the run was stuck forever.
    """
    conn = db.connect()
    run_id, request_id, adapter = _run_to_waiting_input(conn)
    db.answer_input_request(conn, request_id, {"approved": True}, responded_by="chat")

    assert ex.advance(conn, run_id, adapter, owner="d").status == "advanced"
    assert ex.advance(conn, run_id, adapter, owner="d").status == "completed"
    assert db.get_run(conn, run_id).status == "completed"


def test_two_surfaces_cannot_both_advance_a_run():
    """Acceptance check 7: the chat UI and the external API race on the same
    request, and exactly one of them may move the run on."""
    import threading

    conn = db.connect()
    run_id, request_id, _ = _run_to_waiting_input(conn)

    outcomes = []
    barrier = threading.Barrier(2)

    def answer(label, payload):
        c = db.connect()
        try:
            barrier.wait()
            db.answer_input_request(c, request_id, payload, responded_by=label)
            outcomes.append(("accepted", label))
        except ValueError as exc:
            outcomes.append(("refused", label, str(exc)))
        finally:
            c.close()

    threads = [
        threading.Thread(target=answer, args=("chat", {"approved": True, "who": "chat"})),
        threading.Thread(target=answer, args=("api", {"approved": False, "who": "api"})),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    accepted = [o for o in outcomes if o[0] == "accepted"]
    assert len(accepted) == 1, outcomes
    # The stored response is the winner's, whole — not a merge of the two.
    stored = db.get_input_request(db.connect(), request_id)
    assert stored.status == "answered"
    assert stored.accepted_response["who"] == accepted[0][1]
    # And the run moved on exactly once.
    events = [e for e in db.list_events(db.connect(), run_id) if e.type == "input.received"]
    assert len(events) == 1, events


if __name__ == "__main__":
    failures = []
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        try:
            fn()
            print(f"  ok    {name}")
        except Exception as exc:  # noqa: BLE001 - a test runner reports, it does not raise
            failures.append(name)
            print(f"  FAIL  {name}: {type(exc).__name__}: {exc}")
    print()
    if failures:
        print(f"FAILED: {len(failures)} of {len(tests)} — {', '.join(failures)}")
        sys.exit(1)
    print(f"all {len(tests)} checks passed")


def test_a_step_can_address_its_own_run_by_id():
    """A pipeline that writes its own intermediate work needs a directory that
    is this run's and not the next one's. Before ``run.`` existed, a step could
    only name ``inputs`` and ``steps``, so it had nowhere to put it."""
    conn = db.connect()
    template = dict(TEMPLATE, steps=[
        {"id": "draft", "type": "agent", "profile": "w", "instruction": "Draft", "input": {}, "next": "save"},
        {"id": "save", "type": "tool", "tool": "t", "instruction": "Save",
         "input": {"path": {"ref": "run.id"}}},
    ])
    run_id = db.create_run(conn, template, inputs={})
    adapter = FakeAdapter(scripted(draft=[{}], save=[{}]))
    run = _drain(conn, run_id, adapter)
    assert run.status == "completed", run.error
    assert adapter.calls_for("save")[0]["input"] == {"path": run_id}


def test_a_run_ref_to_something_the_run_does_not_have_fails():
    from hermes_cli.pipeline_executor import RefUnavailable, resolve_refs
    try:
        resolve_refs({"ref": "run.nope"}, inputs={}, outputs={}, run={"id": "r1"})
    except RefUnavailable:
        return
    raise AssertionError("expected RefUnavailable")


def test_a_string_can_name_more_than_one_ref():
    """A step's output path needs the workdir *and* the run id. One ref resolves
    to one value, so without interpolation the path could name either."""
    from hermes_cli.pipeline_executor import resolve_refs
    got = resolve_refs(
        "{{inputs.workdir}}/{{run.id}}/iter-0.md",
        inputs={"workdir": "/tmp/vpn"}, outputs={}, run={"id": "run_abc"},
    )
    assert got == "/tmp/vpn/run_abc/iter-0.md"


def test_a_slot_that_is_not_a_string_is_refused_rather_than_stringified():
    """str() on a dict here would write a Python repr into a file and be
    discovered much later."""
    from hermes_cli.pipeline_executor import RefUnavailable, resolve_refs
    try:
        resolve_refs("{{steps.s.obj}}", inputs={}, outputs={"s": {"obj": {"a": 1}}})
    except RefUnavailable as exc:
        assert "must be a string" in str(exc)
        return
    raise AssertionError("expected RefUnavailable")


def test_a_plain_string_with_no_slots_is_untouched():
    from hermes_cli.pipeline_executor import resolve_refs
    assert resolve_refs("just text", inputs={}, outputs={}) == "just text"
    assert resolve_refs("{{}}", inputs={}, outputs={}) == "{{}}"
