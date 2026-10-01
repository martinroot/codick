"""#58 — what the run actually cost, measured at the turn.

The agent already keeps per-session token counters, so the numbers do not need
to be estimated from text. The subtlety is *when* to read them: a session is
reused across attempts, so a cumulative reading charges every step for every
step that ran before it. Only the delta around one turn is a cost of that step.
"""

import pytest

from hermes_cli import pipeline_hermes_adapter as adapter


class CountingAgent:
    """An agent shaped like the real one: cumulative session counters."""

    def __init__(self, **usage):
        self.session_input_tokens = usage.get("input", 0)
        self.session_output_tokens = usage.get("output", 0)
        self.session_cache_read_tokens = usage.get("cache_read", 0)
        self.session_cache_write_tokens = usage.get("cache_write", 0)
        self.session_estimated_cost_usd = usage.get("cost_usd", 0.0)
        self.session_cost_status = usage.get("cost_status", "estimated")
        self.history = []
        self.closed = False

    #: How many tokens each turn of this agent "spends", applied in the turn.
    per_turn = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}

    def run_conversation(self, prompt, conversation_history=None):
        self.session_input_tokens += self.per_turn.get("input", 0)
        self.session_output_tokens += self.per_turn.get("output", 0)
        self.session_cache_read_tokens += self.per_turn.get("cache_read", 0)
        self.session_cache_write_tokens += self.per_turn.get("cache_write", 0)
        self.history.append(prompt)
        return '{"ok": true}', {"final_response": '{"ok": true}'}

    def close(self):
        self.closed = True


class BareAgent:
    """An agent with no counters at all."""

    def run_conversation(self, prompt, conversation_history=None):
        return '{"ok": true}', {"final_response": '{"ok": true}'}

    def close(self):
        pass


# --- reading the counters -----------------------------------------------------


def test_the_counters_are_read_into_the_storage_shape():
    usage = adapter.read_usage(CountingAgent(
        input=100, output=40, cache_read=25, cache_write=5, cost_status="estimated"))
    assert usage == {
        "input": 100, "output": 40, "cache_read": 25, "cache_write": 5,
        "cost_status": "estimated", "estimated_cost_usd": 0.0,
    }


def test_an_agent_without_counters_reads_as_unmeasured():
    assert adapter.read_usage(BareAgent()) is None


def test_no_agent_reads_as_unmeasured():
    assert adapter.read_usage(None) is None


def test_a_partial_counter_reads_as_unmeasured():
    """Half a reading is not a small number. An agent missing one counter cannot
    have its cost computed, and a partial delta would look like a real one."""
    agent = CountingAgent()
    del agent.session_cache_read_tokens
    assert adapter.read_usage(agent) is None


# --- the delta ----------------------------------------------------------------


def test_the_delta_is_this_turn_not_the_session():
    before = adapter.read_usage(CountingAgent(input=10_000, output=5_000))
    agent = CountingAgent(input=10_000, output=5_000)
    agent.session_input_tokens += 120
    agent.session_output_tokens += 60
    delta = adapter.usage_delta(before, adapter.read_usage(agent))
    assert delta["input"] == 120
    assert delta["output"] == 60
    assert delta["kind"] == "model"


def test_a_second_turn_on_the_same_session_is_charged_only_its_own_tokens():
    """The bug this guards: cumulative readings make the second step pay for
    the first."""
    agent = CountingAgent()
    first_before = adapter.read_usage(agent)
    agent.session_input_tokens += 100
    agent.session_output_tokens += 20
    first = adapter.usage_delta(first_before, adapter.read_usage(agent))

    second_before = adapter.read_usage(agent)
    agent.session_input_tokens += 300
    agent.session_output_tokens += 40
    second = adapter.usage_delta(second_before, adapter.read_usage(agent))

    assert first["input"] == 100
    assert second["input"] == 300, "the second turn must not inherit the first"
    assert first["input"] + second["input"] == 400


def test_cached_tokens_are_measured_apart():
    before = adapter.read_usage(CountingAgent())
    agent = CountingAgent()
    agent.session_cache_read_tokens += 900
    delta = adapter.usage_delta(before, adapter.read_usage(agent))
    assert delta["cache_read"] == 900
    assert delta["input"] == 0, "a cache hit is not fresh input"


def test_a_counter_that_went_backwards_is_unmeasured():
    """A session reset mid-flight makes the delta nonsense. A negative token
    count is worse than an absent one."""
    before = adapter.read_usage(CountingAgent(input=500))
    after = adapter.read_usage(CountingAgent(input=0))
    assert adapter.usage_delta(before, after) is None


def test_a_missing_reading_on_either_side_is_unmeasured():
    usage = adapter.read_usage(CountingAgent())
    assert adapter.usage_delta(None, usage) is None
    assert adapter.usage_delta(usage, None) is None
    assert adapter.usage_delta(None, None) is None


def test_the_agents_own_cost_status_is_carried_through():
    """When a provider reported nothing, our arithmetic must not stand in and
    claim a number we were not given."""
    before = adapter.read_usage(CountingAgent(cost_status="estimated"))
    after = adapter.read_usage(CountingAgent(cost_status="unknown", cost_usd=0.0))
    assert adapter.usage_delta(before, after)["cost_status"] == "unknown"


# --- through the adapter ------------------------------------------------------


def _request(**over):
    base = {
        "run_id": "run_1", "step_id": "draft", "attempt_id": "att_1",
        "profile": "writer", "instruction": "Write the intro.",
        "input": {"topic": "water"}, "idempotency_key": "idem_1",
    }
    base.update(over)
    return base


class Spender(CountingAgent):
    per_turn = {"input": 250, "output": 90}


def test_a_completed_step_reports_its_turn_usage():
    hermes = adapter.HermesStepAdapter(agent_factory=lambda **kw: Spender())
    result = hermes._execute_agent_step(_request())
    assert result.state == "completed"
    assert result.usage is not None
    assert result.usage["input"] == 250
    assert result.usage["output"] == 90


def test_a_second_step_does_not_pay_for_the_first():
    """The property the delta exists for: a reused session's cumulative counter
    must not be charged twice."""
    shared = {"agent": None}

    def factory(**kwargs):
        if shared["agent"] is None:
            shared["agent"] = Spender()
        return shared["agent"]

    hermes = adapter.HermesStepAdapter(agent_factory=factory)
    first = hermes._execute_agent_step(_request())
    second = hermes._execute_agent_step(_request(step_id="publish", attempt_id="att_2"))
    assert first.usage["input"] == second.usage["input"] == 250


def test_a_step_with_no_counters_reports_unmeasured_not_zero():
    hermes = adapter.HermesStepAdapter(agent_factory=lambda **kw: BareAgent())
    result = hermes._execute_agent_step(_request())
    assert result.state == "completed"
    assert result.usage is None, "zero here would mean the step was free"


def test_a_cancelled_turn_reports_no_usage():
    hermes = adapter.HermesStepAdapter(agent_factory=lambda **kw: Spender())
    execution = adapter._Execution("exec_1", "run_1", "draft", "att_1")
    execution.cancelled = True
    result = hermes._execute_agent_step(_request(), execution)
    assert result.state == "cancelled"
    assert result.usage is None
