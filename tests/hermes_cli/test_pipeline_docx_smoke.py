"""The real DOCX smoke test (spec §14 check 12, issue #35).

Everything here is real except the language model: the `documents.export_docx`
tool is the shipped one, the artifact is registered by the shipped publisher,
the bytes come back through the shipped protected download route, and the result
is read back with the repository's own DOCX reader.

What that buys, and what it does not: the claim "a finished DOCX actually opens
and contains the expected changes" is only worth anything if the document is
produced by the same code path a user runs. Asserting on a file this test wrote
itself would pass even if the pipeline never exported anything — so the document
asserted on is the one the run produced, fetched over HTTP, and opened with
`tools/read_extract.py`.

The model is stubbed because a smoke test that spends a provider call proves
nothing extra about the DOCX, and would make the suite depend on network state.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
os.environ.setdefault("HERMES_HOME", tempfile.mkdtemp(prefix="pipeline-docx-test-"))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from hermes_cli import pipeline_credentials as pipeline_credentials  # noqa: E402
from hermes_cli import pipeline_runner as runner  # noqa: E402
from hermes_cli import pipelines_db as db  # noqa: E402
from hermes_cli.pipeline_hermes_adapter import HermesStepAdapter  # noqa: E402
from hermes_cli.web_routers import pipelines as pipelines_api  # noqa: E402

from tools.read_extract import extract_document_text  # noqa: E402

SCENARIO = os.path.join(os.path.dirname(__file__), "scenarios", "word-report.json")

EXPECTED_SENTENCE = "The board is the only backlog that anybody actually opens."


def _publish_input() -> dict:
    """The tool's declared input, read from the scenario rather than retyped."""
    with open(SCENARIO, encoding="utf-8") as handle:
        for step in json.load(handle)["steps"]:
            if step["id"] == "publish":
                return step["input"]
    raise AssertionError("the scenario has no publish step")


@pytest.fixture(autouse=True)
def _isolated_home(monkeypatch, tmp_path):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    # The scenario exports to a relative path; keep it out of the repository.
    monkeypatch.chdir(tmp_path)


class ScriptedAgent:
    """A stand-in for the two agent steps, with fixed, checkable prose."""

    def __init__(self, session_id=None, **kwargs):
        self.session_id = session_id

    def run_conversation(self, prompt, conversation_history=None):
        if "Research" in prompt:
            reply = json.dumps({"facts": ["the board is the only backlog that anybody actually opens."]})
        else:
            reply = json.dumps({"body": EXPECTED_SENTENCE})
        return reply, {"final_response": reply}

    def close(self):
        pass


def _mint(scope: str) -> str:
    conn = db.connect()
    try:
        pipeline_credentials.ensure_schema(conn)
        conn.commit()
        _cred, secret = pipeline_credentials.create_credential(conn, scope)
    finally:
        conn.close()
    return secret


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(pipelines_api.router)
    with TestClient(app) as c:
        c.headers.update({"Authorization": f"Bearer {_mint('docx-site')}"})
        yield c


def test_the_run_produces_a_docx_that_downloads_and_opens(client, tmp_path):
    with open(SCENARIO, encoding="utf-8") as handle:
        template = json.load(handle)
    assert template["result"] == {"document": {"ref": "steps.publish.output.path"}}

    assert client.post("/api/pipelines/templates", json={"template": template}).status_code == 200
    started = client.post(
        "/api/pipelines/runs",
        json={"template_id": template["id"],
              "inputs": {"topic": "delivery", "author": "martin"}},
        headers={"Idempotency-Key": "docx-1"},
    )
    assert started.status_code == 201, started.text
    run_id = started.json()["id"]

    conn = db.connect()
    adapter = HermesStepAdapter(agent_factory=ScriptedAgent)

    assert runner.drive_run(conn, run_id, adapter, owner="docx").status == "waiting_input"
    detail = client.get(f"/api/pipelines/runs/{run_id}").json()
    request_id = [r for r in detail["input_requests"] if r["status"] == "open"][0]["id"]
    answered = client.post(
        f"/api/pipelines/runs/{run_id}/input-requests/{request_id}/response",
        json={"response": {"ok": True}}, headers={"Idempotency-Key": "docx-answer"},
    )
    assert answered.status_code == 200, answered.text

    report = runner.drive_run(conn, run_id, adapter, owner="docx")
    assert report.status == "completed", (
        report.status, report.details,
        [(a.step_id, a.error) for a in db.list_attempts(conn, run_id) if a.error],
    )

    # The declared result was published, not merely computed: a path to the
    # protected route, an artifact row, and bytes behind it.
    run = db.get_run(conn, run_id)
    document = (run.result or {}).get("document")
    assert isinstance(document, dict), run.result
    assert document["path"].startswith("/api/pipelines/artifacts/"), document
    assert document["filename"].endswith(".docx"), document

    artifacts = db.list_artifacts(conn, run_id)
    assert len(artifacts) == 1, artifacts
    artifact = artifacts[0]
    assert artifact.size > 0
    assert "wordprocessingml" in (artifact.mime_type or ""), artifact.mime_type

    # Fetch it back over the protected route, as a client would.
    fetched = client.get(f"/api/pipelines/artifacts/{artifact.id}/download")
    assert fetched.status_code == 200, fetched.text
    assert len(fetched.content) == artifact.size

    # And open it with the repository's own reader.
    downloaded = tmp_path / "downloaded.docx"
    downloaded.write_bytes(fetched.content)
    assert downloaded.read_bytes()[:2] == b"PK", "not a zip container"

    text = extract_document_text(str(downloaded))
    # The title came from the scenario's tool input, the sentence from the agent
    # step's output: both survived the round trip through the real writer.
    # The title came from the template's tool input and the body from the agent
    # step's output: both survived the real writer, the real artifact store and
    # the real download route.
    assert _publish_input()["title"] in text, text
    assert EXPECTED_SENTENCE in text, text


def test_two_runs_of_one_template_do_not_share_files(client):
    """§14 check 2, file half.

    Sessions and inputs are covered by the adapter tests; this is the part that
    is easy to get wrong and invisible until two customers overwrite each
    other's document — the storage path must be per-run, not per-template.
    """
    with open(SCENARIO, encoding="utf-8") as handle:
        template = json.load(handle)
    client.post("/api/pipelines/templates", json={"template": template})
    conn = db.connect()
    adapter = HermesStepAdapter(agent_factory=ScriptedAgent)

    run_ids = []
    for index in (1, 2):
        started = client.post(
            "/api/pipelines/runs",
            json={"template_id": template["id"], "inputs": {"topic": f"t{index}", "author": "m"}},
            headers={"Idempotency-Key": f"two-{index}"},
        )
        run_id = started.json()["id"]
        run_ids.append(run_id)
        runner.drive_run(conn, run_id, adapter, owner="docx")
        request_id = [r for r in client.get(f"/api/pipelines/runs/{run_id}").json()["input_requests"]
                      if r["status"] == "open"][0]["id"]
        client.post(f"/api/pipelines/runs/{run_id}/input-requests/{request_id}/response",
                    json={"response": {"ok": True}}, headers={"Idempotency-Key": f"two-a-{index}"})
        assert runner.drive_run(conn, run_id, adapter, owner="docx").status == "completed"

    storage_refs = {a.storage_ref for run_id in run_ids for a in db.list_artifacts(conn, run_id)}
    assert len(storage_refs) == 2, storage_refs
    for run_id in run_ids:
        for artifact in db.list_artifacts(conn, run_id):
            assert artifact.storage_ref.startswith(f"runs/{run_id}/"), artifact.storage_ref
            # Each run's copy is its own file on disk, not a shared path.
            assert (db.artifacts_root() / artifact.storage_ref).is_file()


def test_the_tool_wrote_the_file_the_run_claims(client):
    """A declared result that names no file must not become a download.

    Otherwise `publish_file` would be reachable with a ref pointing anywhere,
    and the artifact store would be a way to serve arbitrary paths.
    """
    with open(SCENARIO, encoding="utf-8") as handle:
        template = json.load(handle)
    # Point the deliverable at a string that is not a path.
    template["result"] = {"verdict": {"ref": "steps.approve.output.ok"}}
    client.post("/api/pipelines/templates", json={"template": template})
    started = client.post(
        "/api/pipelines/runs",
        json={"template_id": template["id"], "inputs": {"topic": "t", "author": "m"}},
        headers={"Idempotency-Key": "docx-2"},
    )
    run_id = started.json()["id"]
    conn = db.connect()
    adapter = HermesStepAdapter(agent_factory=ScriptedAgent)
    runner.drive_run(conn, run_id, adapter, owner="docx")
    request_id = [r for r in client.get(f"/api/pipelines/runs/{run_id}").json()["input_requests"]
                  if r["status"] == "open"][0]["id"]
    client.post(f"/api/pipelines/runs/{run_id}/input-requests/{request_id}/response",
                json={"response": {"ok": True}}, headers={"Idempotency-Key": "docx-answer-2"})
    assert runner.drive_run(conn, run_id, adapter, owner="docx").status == "completed"

    assert db.list_artifacts(conn, run_id) == []
    assert db.get_run(conn, run_id).result == {"verdict": True}