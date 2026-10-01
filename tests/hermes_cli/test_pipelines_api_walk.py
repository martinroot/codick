"""The documented API walk, executed.

`docs/pipelines/api.md` describes start → waiting_input → response → completed →
download. This performs exactly that against the real router, so the document
cannot describe a sequence the server does not accept.

Only the model is stubbed. The router, the database, the executor, the input
contract, the artifact store and the download route are real — a walk that
faked any of them would prove nothing about the thing being documented.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
os.environ.setdefault("HERMES_HOME", tempfile.mkdtemp(prefix="pipeline-walk-test-"))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from hermes_cli import pipeline_runner as runner  # noqa: E402
from hermes_cli import pipelines_db as db  # noqa: E402
from hermes_cli import pipeline_credentials as pipeline_credentials  # noqa: E402
from hermes_cli.web_routers import pipelines as pipelines_api  # noqa: E402

SCENARIO = os.path.join(os.path.dirname(__file__), "scenarios", "word-report.json")


@pytest.fixture(autouse=True)
def _isolated_home(monkeypatch, tmp_path):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))


def _mint(scope: str) -> str:
    conn = db.connect()
    try:
        pipeline_credentials.ensure_schema(conn)
        conn.commit()
        _cred, secret = pipeline_credentials.create_credential(conn, scope)
    finally:
        conn.close()
    return secret


class StubAgent:
    """Answers each agent step with schema-conforming JSON, in order."""

    _REPLIES = {
        "research": '{"facts": ["kanban shipped", "the board is live"]}',
        "draft": '{"body": "A short brief about the kanban board."}',
    }

    def __init__(self, session_id=None, **kwargs):
        # The real factory is called with session_id, profile, quiet_mode and
        # config; accepting **kwargs is what makes this a stand-in rather than
        # an adapter_error generator.
        self.session_id = session_id

    def run_conversation(self, prompt, conversation_history=None):
        step = "research" if "Research" in prompt else "draft"
        reply = self._REPLIES.get(step, "{}")
        return reply, {"final_response": reply}

    def close(self):
        pass


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(pipelines_api.router)
    with TestClient(app) as c:
        c.headers.update({"Authorization": f"Bearer {_mint('walk-site')}"})
        yield c


def _template() -> dict:
    with open(SCENARIO, encoding="utf-8") as handle:
        return json.load(handle)


def test_the_documented_walk(client, tmp_path):
    template = _template()

    # 1. import the template, as the docs say
    stored = client.post("/api/pipelines/templates", json={"template": template})
    assert stored.status_code == 200, stored.text
    assert stored.json()["readiness_status"] == "ready", stored.json()

    # 2. start, with the documented Idempotency-Key
    started = client.post(
        "/api/pipelines/runs",
        json={"template_id": template["id"],
              "inputs": {"topic": "kanban", "author": "martin"}},
        headers={"Idempotency-Key": "order-4711"},
    )
    assert started.status_code == 201, started.text
    run_id = started.json()["id"]

    # 3. poll until it parks on a person
    from hermes_cli.pipeline_hermes_adapter import HermesStepAdapter

    conn = db.connect()
    report = runner.drive_run(conn, run_id, HermesStepAdapter(agent_factory=StubAgent),
                              owner="walk-1")
    assert report.status == "waiting_input", (report.status, report.details)

    detail = client.get(f"/api/pipelines/runs/{run_id}").json()
    assert detail["status"] == "waiting_input"
    # The wire shape is a list of requests, not a single `pending_input` — the
    # docs describe this and a rewrite of either would otherwise go unnoticed.
    open_requests = [r for r in detail["input_requests"] if r["status"] == "open"]
    assert len(open_requests) == 1, detail["input_requests"]
    request_id = open_requests[0]["id"]
    assert open_requests[0]["prompt"]
    assert open_requests[0]["response_schema"]

    # 4. answer it, with the documented key and `{"response": ...}` envelope
    answered = client.post(
        f"/api/pipelines/runs/{run_id}/input-requests/{request_id}/response",
        json={"response": {"ok": True}},
        headers={"Idempotency-Key": "answer-4711-a"},
    )
    assert answered.status_code == 200, answered.text

    # a duplicate answer is refused, not silently reapplied
    duplicate = client.post(
        f"/api/pipelines/runs/{run_id}/input-requests/{request_id}/response",
        json={"response": {"ok": True}},
        headers={"Idempotency-Key": "answer-4711-b"},
    )
    assert duplicate.status_code == 409, duplicate.text

    # 5. the run continues on its own — no Confirm anywhere
    final = runner.drive_run(conn, run_id, HermesStepAdapter(agent_factory=StubAgent),
                             owner="walk-1")
    assert final.status == "completed", (final.status, final.details)

    # 6. the run is recoverable from its card, as the docs promise
    card_id = db.get_run(conn, run_id).card_id
    assert card_id, "a run created through the API carries a card"
    found = client.get(f"/api/pipelines/cards/{card_id}/run")
    assert found.status_code == 200, found.text
    assert found.json()["id"] == run_id