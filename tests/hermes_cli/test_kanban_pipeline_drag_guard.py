"""A drag must not kill the pipeline executor's card (issue #45, spec section 9).

``_set_status_direct`` (the drag-drop write) reclaims the run and terminates
the worker; the issue's point is that a drag of a pipeline card is not a
status change but an executor termination. The guard lives in
``_apply_status`` — the single dispatch point shared by PATCH /tasks/{id} and
POST /tasks/bulk — so every verb path refuses, and the discriminator travels
to the UI on the card payload (``_task_dict``), not in a new column: the spec's
own rule is that ``tasks`` gains no columns and run state is never
communicated by moving a card between columns.
"""

from __future__ import annotations

import dataclasses
import importlib.util
import sys
from pathlib import Path

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_db_connect as kbc


@pytest.fixture
def conn(tmp_path: Path):
    db = kbc.connect(tmp_path / "kanban.db")
    try:
        yield db
    finally:
        db.close()


def _make_pipeline_card(conn) -> str:
    """A pipeline card without touching ``create_task``: the executor sets the
    binding columns directly, exactly as the future executor will."""
    task_id = kb.create_task(conn, title="pipeline card", assignee="executor")
    with kb.write_txn(conn):
        conn.execute(
            "UPDATE tasks SET workflow_template_id = ?, current_step_key = ? WHERE id = ?",
            ("word-weekly", "review", task_id),
        )
    return task_id


def _load_router_module():
    """Load ``hermes_cli.kanban_api`` the same way the M3 reopen tests do: a
    fresh module object over the real file, router included in a bare app."""
    repo_root = Path(__file__).resolve().parents[2]
    plugin_file = repo_root / "hermes_cli" / "kanban_api.py"
    spec = importlib.util.spec_from_file_location(
        "hermes_dashboard_plugin_kanban_pipeline_guard_test", plugin_file,
    )
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _client():
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    app = fastapi.FastAPI()
    app.include_router(_load_router_module().router, prefix="/api/plugins/kanban")
    return TestClient(app)


def test_pipeline_card_is_marked_and_refuses_every_manual_verb(conn):
    """The payload marks the card, every verb the dashboard offers is refused
    through PATCH and bulk alike, and an ordinary card still moves."""
    client = _client()

    pipe_id = _make_pipeline_card(conn)
    plain_id = kb.create_task(conn, title="draggable card", assignee="builder")

    # The board payload carries the discriminator both ways.
    board = client.get("/api/plugins/kanban/board").json()
    by_id = {c["id"]: c for col in board["columns"] for c in col["tasks"]}
    assert by_id[pipe_id]["pipeline"] is True
    assert by_id[pipe_id]["workflow_template_id"] == "word-weekly"
    assert by_id[plain_id]["pipeline"] is False

    # Every verb the dashboard offers is refused, on both write surfaces.
    for status in ("todo", "ready", "blocked", "review", "done"):
        r = client.patch(f"/api/plugins/kanban/tasks/{pipe_id}", json={"status": status})
        assert r.status_code == 400, (status, r.text)
        assert "pipeline card" in r.json()["detail"]

    bulk = client.post(
        "/api/plugins/kanban/tasks/bulk", json={"ids": [pipe_id], "status": "todo"},
    )
    entry = bulk.json()["results"][0]
    assert entry["ok"] is False
    assert "pipeline card" in entry["error"]

    # Nothing moved.
    task = kb.get_task(conn, pipe_id)
    assert task is not None and task.status == "ready"
    assert task.current_run_id is None
    assert kb.list_runs(conn, pipe_id) == []

    # The same verbs on an ordinary card still work through the same path.
    r = client.patch(f"/api/plugins/kanban/tasks/{plain_id}", json={"status": "todo"})
    assert r.status_code == 200, r.text
    plain_after = kb.get_task(conn, plain_id)
    assert plain_after is not None and plain_after.status == "todo"


def test_dragging_a_running_pipeline_card_does_not_reclaim_the_run(conn, monkeypatch):
    """The issue's headline: a drag of a *running* pipeline card would close
    the run as 'reclaimed' and terminate the worker. The guard fires before
    ``_set_status_direct`` is reached, so neither happens."""
    client = _client()

    pipe_id = _make_pipeline_card(conn)
    claimed = kb.claim_task(conn, pipe_id)
    assert claimed is not None and claimed.status == "running"
    run_id = claimed.current_run_id
    assert run_id is not None

    kills: list[tuple] = []

    def fake_terminate(pid, claim_lock, started_at=None, **kwargs):
        kills.append((pid, claim_lock, started_at))
        return {"terminated": True}

    monkeypatch.setattr(kb, "_terminate_reclaimed_worker", fake_terminate)

    r = client.patch(f"/api/plugins/kanban/tasks/{pipe_id}", json={"status": "ready"})
    assert r.status_code == 400
    assert "pipeline card" in r.json()["detail"]

    task = kb.get_task(conn, pipe_id)
    assert task is not None and task.status == "running"
    assert task.current_run_id == run_id, "the run must not have been reclaimed"
    assert kills == [], "no worker may be terminated by a dashboard move"

    # And bulk must not get around it either.
    bulk = client.post(
        "/api/plugins/kanban/tasks/bulk", json={"ids": [pipe_id], "status": "todo"},
    )
    assert bulk.json()["results"][0]["ok"] is False
    still_running = kb.get_task(conn, pipe_id)
    assert still_running is not None and still_running.status == "running"
    assert kills == []


def test_task_dict_pipeline_key_tracks_the_binding():
    """``pipeline`` is derived, keyed on either binding column alone; the dict
    carries no key beyond the dataclass fields plus the four derived ones."""
    from hermes_cli import kanban_api

    task = kb.Task(
        id="t_x",
        title="t",
        body=None,
        assignee=None,
        status="todo",
        priority=0,
        created_by=None,
        created_at=0,
        started_at=None,
        completed_at=None,
        workspace_kind="scratch",
        workspace_path=None,
        claim_lock=None,
        claim_expires=None,
        tenant=None,
        workflow_template_id="word-weekly",
        current_step_key="review",
    )
    d = kanban_api._task_dict(task)
    fields = {f.name for f in dataclasses.fields(kb.Task)} | {
        "age", "latest_summary", "current_run_started_at", "pipeline",
    }
    assert set(d.keys()) == fields
    assert d["pipeline"] is True

    task.current_step_key = None
    assert kanban_api._task_dict(task)["pipeline"] is True, "template alone binds"

    task.workflow_template_id = None
    assert kanban_api._task_dict(task)["pipeline"] is False, "nothing binds"
