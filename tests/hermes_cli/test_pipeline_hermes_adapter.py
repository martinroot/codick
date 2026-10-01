"""The real adapter's contract (spec §8, #34).

These tests never build a model. What is worth proving here is not that a
provider answers, it is that the adapter refuses the things that would be
unrecoverable if it did: prose passing as a result, two attempts sharing a
conversation, and a command arriving in a JSON field.
"""

from __future__ import annotations

import threading
import time

import pytest

from hermes_cli.pipeline_executor import (
    AdapterError,
    ContractError,
    ExecutionResult,
    UnknownOutcome,
)
from hermes_cli.pipeline_hermes_adapter import (
    HermesStepAdapter,
    attempt_session_id,
    build_attempt_history,
    extract_json_object,
)


class FakeAgent:
    """Records what it was built with, and answers with a queued reply.

    ``replies`` is the *shared* queue, not a copy of one: a repair builds a
    second agent, and that second turn has to see the next queued reply rather
    than replay the first — which is what a per-agent copy would silently do.
    """

    def __init__(self, replies, log, **kwargs):
        self._replies = replies
        self._log = log
        self.session_id = kwargs.get("session_id")
        self.calls = []
        self.closed = False
        self.interrupted = False

    def run_conversation(self, prompt, conversation_history=None):
        self.calls.append({"prompt": prompt, "history": list(conversation_history or [])})
        reply = self._replies.pop(0) if self._replies else "{}"
        return reply, {"final_response": reply}

    def close(self):
        self.closed = True

    def interrupt(self):
        self.interrupted = True


def _adapter(replies, log, **kwargs):
    queue = list(replies)

    def factory(**kw):
        log.append(kw)
        return FakeAgent(queue, log, **kw)

    return HermesStepAdapter(agent_factory=factory, **kwargs)


def _request(**over):
    base = {
        "run_id": "run_1", "step_id": "draft", "attempt_id": "att_1",
        "profile": "writer", "instruction": "Write the intro.",
        "input": {"topic": "water"}, "idempotency_key": "idem_1",
    }
    base.update(over)
    return base


def _await(adapter, execution_id, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            outcome = adapter.result(execution_id)
        except UnknownOutcome:
            return "unknown"
        if outcome is not None:
            return outcome
        time.sleep(0.01)
    raise AssertionError("the attempt never finished")


# --- attempt isolation (acceptance check 2) -------------------------------------

def test_each_attempt_gets_its_own_session():
    """Two orders never share state: the session id carries the attempt id."""
    assert attempt_session_id("run_1", "draft", "att_1") != attempt_session_id("run_1", "draft", "att_2")
    assert attempt_session_id("run_1", "draft", "att_1") == attempt_session_id("run_1", "draft", "att_1")


def test_two_attempts_of_one_step_do_not_share_a_conversation():
    log = []
    adapter = _adapter(["{\"a\": 1}", "{\"a\": 2}"], log)
    first = adapter.submit(_request(attempt_id="att_1"))
    second = adapter.submit(_request(attempt_id="att_2"))
    _await(adapter, first)
    _await(adapter, second)
    sessions = [entry["session_id"] for entry in log]
    assert len(sessions) == 2
    assert sessions[0] != sessions[1]


def test_a_restart_reattaches_to_the_same_attempt_session():
    """Derived, not generated: the same attempt id must name the same session."""
    assert attempt_session_id("run_1", "draft", "att_7") == attempt_session_id("run_1", "draft", "att_7")


def test_submit_refuses_without_the_three_ids():
    adapter = _adapter(["{}"], [])
    with pytest.raises(AdapterError) as excinfo:
        adapter.submit({"step_id": "draft"})
    assert excinfo.value.error_code == "contract_invalid"


# --- the agent gets the task and its data, not a transcript ---------------------

def test_history_is_the_task_and_the_data_and_nothing_else():
    history = build_attempt_history("Write the intro.", {"topic": "water"})
    assert history[0]["content"] == "Write the intro."
    assert "water" in history[1]["content"]
    # Bounded on purpose — a step must not reason over its own earlier attempts.
    assert len(history) <= 3


def test_the_schema_is_shown_so_the_model_is_not_left_guessing():
    history = build_attempt_history("Do it.", {"a": 1}, output_schema={"type": "object"})
    assert any("JSON Schema" in entry["content"] for entry in history)


# --- prose is not a result --------------------------------------------------------

def test_prose_does_not_complete_a_step():
    """Two prose answers, because one repair turn is permitted and it counts.

    The property under test is that prose never *becomes* a result — not that
    the adapter refuses to ask once more. The repair gets its own reply, and
    when that is also prose the step must fail rather than complete with
    whatever the model said.
    """
    log = []
    adapter = _adapter(
        ["Here is a lovely introduction about water.", "And here it is again, in prose."], log
    )
    outcome = _await(adapter, adapter.submit(_request()))
    assert isinstance(outcome, ExecutionResult)
    assert outcome.state == "failed"
    assert outcome.error_code == "contract_invalid"


def test_json_fenced_in_prose_is_still_json():
    assert extract_json_object('sure!\n```json\n{"a": 1}\n```\n') == {"a": 1}
    assert extract_json_object('the answer is {"a": 1} — hope that helps') == {"a": 1}
    assert extract_json_object("no json at all") is None


def test_a_braces_inside_a_string_do_not_end_the_object():
    assert extract_json_object('{"a": "}"}') == {"a": "}"}


def test_output_that_violates_the_schema_fails_the_step():
    log = []
    adapter = _adapter(['{"qty": "lots"}'], log)
    outcome = _await(adapter, adapter.submit(_request(
        output_schema={"type": "object", "properties": {"qty": {"type": "integer"}},
                       "required": ["qty"]},
    )))
    assert outcome.state == "failed"
    assert "output.qty" in outcome.error


def test_a_valid_object_completes_the_step():
    log = []
    adapter = _adapter(['{"qty": 3}'], log)
    outcome = _await(adapter, adapter.submit(_request(
        output_schema={"type": "object", "properties": {"qty": {"type": "integer"}},
                       "required": ["qty"]},
    )))
    assert outcome.state == "completed"
    assert outcome.output == {"qty": 3}


# --- the bounded repair ----------------------------------------------------------

def test_prose_is_repaired_once_and_then_accepted():
    log = []
    adapter = _adapter(["I cannot comply.", '{"qty": 3}'], log)
    outcome = _await(adapter, adapter.submit(_request(
        output_schema={"type": "object", "properties": {"qty": {"type": "integer"}},
                       "required": ["qty"]},
    )))
    assert outcome.state == "completed"
    assert outcome.output == {"qty": 3}
    assert len(log) == 2, "exactly one repair turn"


def test_the_repair_is_bounded_and_gives_up():
    """One round. A model that never complies must fail, not loop in a thread."""
    log = []
    adapter = _adapter(["still prose", "more prose", '{"qty": 3}'], log)
    outcome = _await(adapter, adapter.submit(_request()))
    assert outcome.state == "failed"
    assert len(log) == 2, "the third reply must never be reached"


# --- capabilities and progress -----------------------------------------------------

def test_capabilities_name_the_operations_spec_requires():
    caps = HermesStepAdapter(agent_factory=lambda **kw: None).capabilities()
    for operation in ("submit", "result", "cancel", "progress"):
        assert operation in caps["operations"]
    assert caps["attempt_isolation"] == "session-per-attempt"
    assert caps["restart_recovers"] is True


def test_progress_is_reported_for_a_repair():
    log = []
    adapter = _adapter(["prose", '{"a": 1}'], log)
    execution_id = adapter.submit(_request())
    _await(adapter, execution_id)
    assert any(e["type"] == "output.repair" for e in adapter.progress(execution_id))


def test_an_unknown_execution_is_unknown_not_failed():
    adapter = _adapter(["{}"], [])
    assert adapter.result("exec_nope") is None
    assert adapter.progress("exec_nope") == []


def test_a_running_attempt_reports_nothing_rather_than_a_guess():
    release = threading.Event()

    class Slow(FakeAgent):
        def run_conversation(self, prompt, conversation_history=None):
            release.wait(5)
            return "{}", {"final_response": "{}"}

    adapter = HermesStepAdapter(agent_factory=lambda **kw: Slow(["{}"], [], **kw))
    execution_id = adapter.submit(_request())
    assert adapter.result(execution_id) is None
    release.set()
    assert _await(adapter, execution_id).state == "completed"


# --- cancel -----------------------------------------------------------------------

def test_cancel_stops_a_running_attempt_and_closes_the_agent():
    entered = threading.Event()
    release = threading.Event()

    class Blocking(FakeAgent):
        def run_conversation(self, prompt, conversation_history=None):
            entered.set()
            release.wait(5)
            return "{}", {"final_response": "{}"}

    built = {}

    def factory(**kw):
        agent = Blocking(["{}"], [], **kw)
        built["agent"] = agent
        return agent

    adapter = HermesStepAdapter(agent_factory=factory)
    execution_id = adapter.submit(_request())
    assert entered.wait(5)
    assert adapter.cancel(execution_id) is True
    release.set()
    assert adapter.result(execution_id).state == "cancelled"
    assert built["agent"].interrupted is True


def test_cancelling_something_already_finished_refuses():
    log = []
    adapter = _adapter(['{"a": 1}'], log)
    execution_id = adapter.submit(_request())
    _await(adapter, execution_id)
    assert adapter.cancel(execution_id) is False


# --- tool steps: never a command out of a JSON field ---------------------------------

def test_a_command_in_a_json_field_is_refused_before_validation():
    adapter = _adapter(["{}"], [])
    with pytest.raises(ContractError) as excinfo:
        adapter.run_tool_step("terminal", {"command": "rm -rf /"})
    assert "not a command" in str(excinfo.value)


def test_args_are_validated_against_the_registered_schema_before_dispatch():
    seen = {}

    def schema_for(tool_id):
        return {"type": "object", "properties": {"path": {"type": "string"}},
                "required": ["path"]}

    def available(tool_id):
        return True

    def dispatcher(tool_id, args):
        seen["called"] = (tool_id, args)
        return "ok"

    adapter = HermesStepAdapter(
        schema_for=schema_for, tool_available=available,
        semantics_reader=lambda t: {"read_only": True, "idempotent": True},
        dispatcher=dispatcher,
    )
    with pytest.raises(ContractError):
        adapter.run_tool_step("read_file", {"path": 17})
    assert "called" not in seen, "validation must gate the handler, not decorate it"


def test_a_valid_tool_call_reaches_the_dispatcher():
    def schema_for(tool_id):
        return {"type": "object", "properties": {"path": {"type": "string"}},
                "required": ["path"]}

    seen = {}

    def dispatcher(tool_id, args):
        seen["called"] = (tool_id, args)
        return "ok"

    adapter = HermesStepAdapter(
        schema_for=schema_for,
        semantics_reader=lambda t: {"read_only": True, "idempotent": True},
        dispatcher=dispatcher,
    )
    assert adapter.run_tool_step("read_file", {"path": "/tmp/x"}) == "ok"
    assert seen["called"] == ("read_file", {"path": "/tmp/x"})


def test_an_unregistered_tool_is_refused_rather_than_dispatched():
    """A missing tool is a readiness fact, not an argument problem.

    Args that validate fine against a tool that does not exist still must not
    reach a handler — the dispatcher here would happily answer "ok" if asked,
    which is exactly the fiction this test refuses.
    """
    calls = []

    def schema_for(tool_id):
        return {"type": "object"}

    adapter = HermesStepAdapter(
        schema_for=schema_for, tool_available=lambda t: False,
        semantics_reader=lambda t: None,
        dispatcher=lambda name, args: calls.append(name),
    )
    with pytest.raises(AdapterError) as excinfo:
        adapter.run_tool_step("documents.export_docx", {"body": "x"})
    assert excinfo.value.error_code == "tool_missing"
    assert calls == []


def test_a_missing_tool_is_refused_by_name():
    """An unknown tool id is refused and named, rather than half-run.

    This id was `documents.export_docx` while that tool did not exist — it is
    now built and registered, so naming it here would assert the opposite of
    the truth, and with an injected `tool_available` the real registry would
    still dispatch the call. An id that genuinely does not exist is what this
    property is about.
    """
    adapter = HermesStepAdapter(tool_available=lambda t: False)
    with pytest.raises(AdapterError) as excinfo:
        adapter.run_tool_step("documents.export_no_such_tool", {"body": "x"})
    assert "documents.export_no_such_tool" in str(excinfo.value)
    assert excinfo.value.error_code == "tool_missing"

# --- the DOCX tool now exists (#35) ------------------------------------------

def test_a_word_tool_step_reaches_the_real_registered_tool(tmp_path):
    """The other side of the missing-tool test, and the reason that one changed.

    #34 recorded that `documents.export_docx` did not exist and that the Word
    scenario had to be `unavailable`. It exists now, so the honest assertion is
    no longer "refused by name" — it is that a validated call reaches the real
    handler and produces a real file the repository's own reader can open.
    """
    import tools.documents_export_docx_tool  # noqa: F401  (registers the tool)
    from tools.read_extract import extract_document_text

    out = tmp_path / "from-pipeline.docx"
    adapter = HermesStepAdapter()
    result = adapter.run_tool_step(
        "documents.export_docx", {"body": "Written by a pipeline tool step.", "path": str(out)},
    )
    assert result is not None
    assert out.exists()
    assert "Written by a pipeline tool step." in extract_document_text(str(out))


def test_a_word_template_is_now_ready_rather_than_unavailable():
    """#34's second half, resolved: the catalogue can now list the Word scenario."""
    import tools.documents_export_docx_tool  # noqa: F401
    from hermes_cli.pipeline_readiness import assess_readiness

    template = {
        "schema_version": "1.0", "id": "word", "version": "1.0.0", "name": "Word",
        "start_step": "publish",
        "steps": [{"id": "publish", "type": "tool", "tool": "documents.export_docx",
                   "instruction": "Export", "next": None}],
    }
    assert assess_readiness(template)["readiness_status"] == "ready"
