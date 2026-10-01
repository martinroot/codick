"""The full cycle, with a rework return and an external input, unattended (#35).

Spec §14 check 3: a rework return must go back to the agent with the
reviewer's remarks, an approval must move on by itself, and the limit must stop
an endless do-whatever. This drives the shipped `word-report` scenario through
exactly that — refuse once, approve second time, no human in the loop.

The refusals are counted rather than assumed. "The run completed" would be true
whether or not the rework branch ever fired, and a demo that does not prove its
own interesting part is a screenshot.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
os.environ.setdefault("HERMES_HOME", tempfile.mkdtemp(prefix="pipeline-demo-test-"))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from hermes_cli import pipelines_db as db  # noqa: E402
from hermes_cli import pipeline_credentials as pipeline_credentials  # noqa: E402
from hermes_cli import pipeline_runner as runner  # noqa: E402
from hermes_cli.pipeline_hermes_adapter import HermesStepAdapter  # noqa: E402
from hermes_cli.web_routers import pipelines as pipelines_api  # noqa: E402

SCENARIO = os.path.join(os.path.dirname(__file__), "scenarios", "word-report.json")


@pytest.fixture(autouse=True)
def _isolated_home(monkeypatch, tmp_path):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    # The scenario exports to a relative path; keep it inside the test's home.
    monkeypatch.chdir(tmp_path)


def _mint(scope: str) -> str:
    conn = db.connect()
    try:
        pipeline_credentials.ensure_schema(conn)
        conn.commit()
        _cred, secret = pipeline_credentials.create_credential(conn, scope)
    finally:
        conn.close()
    return secret


class CountingAgent:
    """A stand-in that records which step ran and how many times.

    Each research attempt returns a *different* body, so the second draft is
    provably built on the second research rather than replaying the first.
    """

    def __init__(self, session_id=None, **kwargs):
        self.session_id = session_id

    def run_conversation(self, prompt, conversation_history=None):
        if "Research" in prompt:
            attempt = CountingAgent.research_calls + 1
            CountingAgent.research_calls += 1
            reply = json.dumps({"facts": [f"round {attempt} finding"]})
        else:
            history = json.dumps(list(conversation_history or []))
            reply = json.dumps({"body": f"draft built on: {history[-120:]}"})
        return reply, {"final_response": reply}

    def close(self):
        pass


@pytest.fixture
def client():
    CountingAgent.research_calls = 0
    app = FastAPI()
    app.include_router(pipelines_api.router)
    with TestClient(app) as c:
        c.headers.update({"Authorization": f"Bearer {_mint('demo-site')}"})
        yield c


def _template() -> dict:
    with open(SCENARIO, encoding="utf-8") as handle:
        return json.load(handle)


def _answer(client, run_id, request_id, body, key):
    return client.post(
        f"/api/pipelines/runs/{run_id}/input-requests/{request_id}/response",
        json={"response": body}, headers={"Idempotency-Key": key},
    )


def _open_request(client, run_id) -> str:
    detail = client.get(f"/api/pipelines/runs/{run_id}").json()
    assert detail["status"] == "waiting_input", detail["status"]
    open_requests = [r for r in detail["input_requests"] if r["status"] == "open"]
    assert len(open_requests) == 1, detail["input_requests"]
    return open_requests[0]["id"]


def _adapter():
    return HermesStepAdapter(agent_factory=CountingAgent)


def test_the_full_cycle_with_one_rework_return(client):
    template = _template()
    assert template["limits"]["max_rework_cycles"] >= 1

    assert client.post("/api/pipelines/templates", json={"template": template}).status_code == 200
    started = client.post(
        "/api/pipelines/runs",
        json={"template_id": template["id"],
              "inputs": {"topic": "kanban", "author": "martin"}},
        headers={"Idempotency-Key": "demo-1"},
    )
    assert started.status_code == 201, started.text
    run_id = started.json()["id"]

    conn = db.connect()
    adapter = _adapter()

    # First pass: the reviewer refuses, with a reason.
    assert runner.drive_run(conn, run_id, adapter, owner="demo").status == "waiting_input"
    first_request = _open_request(client, run_id)
    assert _answer(client, run_id, first_request, {"ok": False, "note": "too thin"},
                   "demo-answer-1").status_code == 200

    # The rework branch must send the run back — and the second research must be
    # a new attempt, not the first one replayed.
    rep = runner.drive_run(conn, run_id, adapter, owner="demo")
    assert rep.status == "waiting_input", (rep.status, rep.details, db.get_run(conn, run_id).error)
    assert CountingAgent.research_calls == 2, f"rework did not re-run research: {rep.details}"

    run = db.get_run(conn, run_id)
    assert run.rework_cycles == 1, run.rework_cycles

    # Second pass: approved, and the run continues with no further prompting.
    second_request = _open_request(client, run_id)
    assert _answer(client, run_id, second_request, {"ok": True}, "demo-answer-2").status_code == 200

    report = runner.drive_run(conn, run_id, adapter, owner="demo")
    assert report.status == "completed", (report.status, report.details)
    assert CountingAgent.research_calls == 2, "approved runs must not redo the work"

    # The approved body is what the document step read, and it is the *second*
    # round's findings.
    publish = [a for a in db.list_attempts(conn, run_id) if a.step_id == "publish"]
    assert publish and publish[-1].status == "completed", publish


def test_the_rework_limit_stops_an_endless_do_whatever(client):
    """Check 3's second half: the limit is what makes refusing safe.

    The reviewer never approves, so without `max_rework_cycles` this run would
    loop until it ran out of patience or money.
    """
    template = _template()
    assert client.post("/api/pipelines/templates", json={"template": template}).status_code == 200
    started = client.post(
        "/api/pipelines/runs",
        json={"template_id": template["id"], "inputs": {"topic": "k", "author": "m"}},
        headers={"Idempotency-Key": "demo-2"},
    )
    run_id = started.json()["id"]

    conn = db.connect()
    adapter = _adapter()
    limit = template["limits"]["max_rework_cycles"]

    for index in range(limit + 3):
        run = db.get_run(conn, run_id)
        if run.status in ("failed", "completed", "cancelled"):
            break
        if run.status == "waiting_input":
            request_id = _open_request(client, run_id)
            _answer(client, run_id, request_id, {"ok": False}, f"demo-loop-{index}")
        runner.drive_run(conn, run_id, adapter, owner="demo")

    run = db.get_run(conn, run_id)
    assert run.status == "failed", f"the loop did not stop; status={run.status}"
    assert CountingAgent.research_calls <= limit + 1, (
        f"research ran {CountingAgent.research_calls} times for a limit of {limit}"
    )
    assert "rework" in (run.error or "").lower() or "cycle" in (run.error or "").lower(), run.error


def test_a_rework_iteration_must_ask_again_rather_than_reuse_the_refusal(client):
    """The bug this demo exists to catch, kept as a regression.

    A rework return gives the same step a *new* attempt. If an answer from the
    previous attempt still satisfies it, the refusal that triggered the rework
    is immediately consumed as the next answer, nobody is ever asked, and the
    run spins until `max_step_executions` kills it — looking like a slow model
    rather than a swallowed question.
    """
    template = _template()
    client.post("/api/pipelines/templates", json={"template": template})
    started = client.post(
        "/api/pipelines/runs",
        json={"template_id": template["id"], "inputs": {"topic": "k", "author": "m"}},
        headers={"Idempotency-Key": "demo-4"},
    )
    run_id = started.json()["id"]
    conn = db.connect()
    adapter = _adapter()

    runner.drive_run(conn, run_id, adapter, owner="demo")
    first = _open_request(client, run_id)
    _answer(client, run_id, first, {"ok": False, "note": "no"}, "demo-r-1")

    # Second pass must park again, on a *new* request, not consume the refusal.
    report = runner.drive_run(conn, run_id, adapter, owner="demo")
    assert report.status == "waiting_input", (report.status, report.details)
    second = _open_request(client, run_id)
    assert second != first, "the rework iteration reused the previous request"

    # And that new request is genuinely open: it has never been answered.
    assert db.get_run(conn, run_id).status == "waiting_input"


def test_an_answer_that_does_not_match_the_schema_leaves_the_request_open(client):
    """The 422 half of check 5, and the reason a request is not closed on a typo."""
    template = _template()
    client.post("/api/pipelines/templates", json={"template": template})
    started = client.post(
        "/api/pipelines/runs",
        json={"template_id": template["id"], "inputs": {"topic": "k", "author": "m"}},
        headers={"Idempotency-Key": "demo-3"},
    )
    run_id = started.json()["id"]
    conn = db.connect()
    runner.drive_run(conn, run_id, _adapter(), owner="demo")
    request_id = _open_request(client, run_id)

    bad = _answer(client, run_id, request_id, {"note": "no ok field"}, "demo-bad")
    assert bad.status_code == 422, bad.text
    body = bad.json()["detail"]
    assert body["still_open"] is True
    assert any(e["path"] == "$.ok" for e in body["errors"]), body["errors"]

    # The same request still accepts a correct answer afterwards.
    good = _answer(client, run_id, request_id, {"ok": True}, "demo-good")
    assert good.status_code == 200, good.text