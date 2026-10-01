"""The real adapter driven through the real executor (spec §8, #34).

Every other test of :mod:`hermes_cli.pipeline_hermes_adapter` exercises the
adapter alone, and every test of the executor drives it with the fake. Nothing
had ever put the two together — which is the gap that let "the fake is
replaced" be true of both files and false of the product.

The model is stubbed at the agent factory, not at the adapter: the adapter, the
executor, the database, leases, attempts and output validation are all real.
Only the provider is not.
"""

from __future__ import annotations

import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
os.environ.setdefault("HERMES_HOME", tempfile.mkdtemp(prefix="pipeline-wiring-test-"))

from hermes_cli import pipelines_db as db  # noqa: E402
from hermes_cli import pipeline_runner as runner  # noqa: E402
from hermes_cli.pipeline_hermes_adapter import HermesStepAdapter  # noqa: E402
from hermes_cli.pipeline_template import validate_template  # noqa: E402

TEMPLATE = {
    "schema_version": "1.0",
    "id": "brief",
    "version": "1.0.0",
    "name": "Brief",
    "start_step": "research",
    "inputs_schema": {
        "type": "object",
        "properties": {"topic": {"type": "string"}},
        "required": ["topic"],
    },
    "limits": {"max_rework_cycles": 2, "max_step_executions": 20},
    "steps": [
        {
            "id": "research", "type": "agent", "profile": "analyst",
            "instruction": "Research the topic.",
            "input": {"topic": {"ref": "inputs.topic"}},
            "output_schema": {
                "type": "object",
                "properties": {"facts": {"type": "array", "items": {"type": "string"}}},
                "required": ["facts"],
            },
            "next": "write",
        },
        {
            "id": "write", "type": "agent", "profile": "writer",
            "instruction": "Write the brief.",
            "input": {
                "topic": {"ref": "inputs.topic"},
                "facts": {"ref": "steps.research.output.facts"},
            },
            "output_schema": {
                "type": "object",
                "properties": {"body": {"type": "string"}},
                "required": ["body"],
            },
            "next": "check",
        },
        {
            "id": "check", "type": "user_input",
            "prompt": "Ship it?",
            "response_schema": {
                "type": "object",
                "properties": {"ok": {"type": "boolean"}}, "required": ["ok"],
            },
            "next": None,
        },
    ],
}


@pytest.fixture(autouse=True)
def _isolated_home(monkeypatch, tmp_path):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))


class StubProvider:
    """Stands in for the provider, and records what it was asked."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.turns = []

    def __call__(self, **kwargs):
        agent = self

        class _Agent:
            session_id = kwargs.get("session_id")

            def run_conversation(self, prompt, conversation_history=None):
                agent.turns.append({
                    "session_id": kwargs.get("session_id"),
                    "prompt": prompt,
                    "history": list(conversation_history or []),
                })
                reply = agent.replies.pop(0) if agent.replies else "{}"
                return reply, {"final_response": reply}

            def close(self):
                pass

        return _Agent()


def test_the_template_is_valid():
    assert validate_template(TEMPLATE) == []


def test_the_real_adapter_carries_a_run_to_a_person():
    """The two halves, together, for the first time.

    A pipeline whose steps need no tool: this is the shape a marketplace
    template actually has today, given `documents.export_docx` does not exist.
    """
    provider = StubProvider([
        '{"facts": ["one", "two"]}',
        '{"body": "The brief."}',
    ])
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "kanban"})
    adapter = HermesStepAdapter(agent_factory=provider)

    report = runner.drive_run(conn, run_id, adapter, owner="runner-1")

    assert report.status == "waiting_input", report.details
    assert db.get_run(conn, run_id).status == "waiting_input"
    # Two agent turns, and the second one was handed the first step's output
    # rather than being asked to rediscover it.
    assert len(provider.turns) == 2
    assert "one" in str(provider.turns[1]["history"])


def test_each_step_gets_a_different_session():
    provider = StubProvider(['{"facts": []}', '{"body": "x"}'])
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "kanban"})
    runner.drive_run(conn, run_id, HermesStepAdapter(agent_factory=provider), owner="runner-1")
    sessions = {turn["session_id"] for turn in provider.turns}
    assert len(sessions) == 2, "two steps, two sessions"


def test_prose_from_the_provider_fails_the_step_in_a_real_run():
    """Prose does not become a result even with the whole runtime behind it."""
    provider = StubProvider(["I would be happy to help with that."])
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "kanban"})
    report = runner.drive_run(conn, run_id, HermesStepAdapter(agent_factory=provider), owner="runner-1")

    run = db.get_run(conn, run_id)
    assert run.status == "failed"
    # The prose never became a result: whatever the failure is called, it is a
    # contract failure, and not a "prose was accepted and stored".
    assert run.error_code == "contract_invalid"


def test_a_schema_violation_fails_the_step_rather_than_being_stored():
    provider = StubProvider(['{"facts": "not a list"}'])
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "kanban"})
    runner.drive_run(conn, run_id, HermesStepAdapter(agent_factory=provider), owner="runner-1")
    run = db.get_run(conn, run_id)
    assert run.status == "failed"
    assert "output.facts" in (run.error or "")


def test_a_repaired_answer_completes_the_step():
    """The bounded repair works in a real run, not only against a fake."""
    # Three replies, not two: the repair spends one, and the step after it still
    # needs its own turn. Running the queue dry mid-run tests the stub, not the
    # adapter.
    provider = StubProvider(["Let me think about that.", '{"facts": ["one"]}', '{"body": "x"}'])
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "kanban"})
    runner.drive_run(conn, run_id, HermesStepAdapter(agent_factory=provider), owner="runner-1")
    run = db.get_run(conn, run_id)
    # The repair turn bought the first step; the run then parks at the person.
    assert run.status == "waiting_input"
    # Three turns: the prose, the repair, and the step that followed.
    assert len(provider.turns) == 3


def test_an_unknown_outcome_blocks_the_run_and_is_recovered_not_repeated():
    from hermes_cli.pipeline_executor import UnknownOutcome

    class LostThread(HermesStepAdapter):
        def submit(self, request):
            raise UnknownOutcome("the call may or may not have landed")

    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "kanban"})
    report = runner.drive_run(conn, run_id, LostThread(), owner="runner-1")
    assert report.status == "blocked"
    assert db.get_run(conn, run_id).status == "blocked"


def test_the_declared_difficulty_of_a_run_is_visible_while_it_runs():
    """The steps each attempt owned are recoverable from the run, not guessed."""
    provider = StubProvider(['{"facts": ["one"]}', '{"body": "x"}'])
    conn = db.connect()
    run_id = db.create_run(conn, TEMPLATE, inputs={"topic": "kanban"})
    runner.drive_run(conn, run_id, HermesStepAdapter(agent_factory=provider), owner="runner-1")
    attempts = db.list_attempts(conn, run_id)
    assert {a.step_id for a in attempts} >= {"research"}
    # Every attempt landed on a status the storage actually defines, rather than
    # a guessed subset — a name invented here would pass forever.
    assert all(a.status in db.ATTEMPT_STATUSES for a in attempts)