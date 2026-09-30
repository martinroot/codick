"""The card/run pair (spec §9, #33): creation, compensation, and reconciliation.

The interesting assertions here are the failure ones, because the whole point of
the requirement is that a half-made pair is a broken pair.
"""

from __future__ import annotations

import os
import sys
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

# Both databases must be redirected before anything imports them: the pipelines
# data root follows HERMES_HOME, the board follows HERMES_KANBAN_DB. Setting only
# one of them is how a test ends up writing to the real board.
_TMP = Path(os.environ.get("TMPDIR", "/tmp")) / "codick_pipeline_board_test"
_TMP.mkdir(parents=True, exist_ok=True)
os.environ["HERMES_HOME"] = str(_TMP / "home")
os.environ["HERMES_KANBAN_DB"] = str(_TMP / "kanban.db")

import pytest  # noqa: E402

from hermes_cli import kanban_db as kb  # noqa: E402
from hermes_cli import kanban_db_connect  # noqa: E402
from hermes_cli import pipeline_board  # noqa: E402
from hermes_cli import pipelines_db as db  # noqa: E402

REAL_HOME = os.path.realpath(str(Path.home() / ".hermes"))


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    """Point both databases at a temp dir, and refuse to run if either is real.

    Set here rather than at import: the suite's conftest normalises the
    environment, so a module-level assignment does not survive to the fixture.

    Through ``monkeypatch`` and not a bare ``os.environ`` write, because a bare
    write outlives the test: the next file in the session would inherit this
    home and read a database the fixture has just deleted. That is a
    cross-file failure that only appears when the files run together.
    """
    monkeypatch.setenv("HERMES_HOME", str(_TMP / "home"))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(_TMP / "kanban.db"))
    pipelines = db.pipelines_db_path()
    board = os.environ["HERMES_KANBAN_DB"]
    for path in (pipelines, board):
        assert not os.path.realpath(str(path)).startswith(REAL_HOME), (
            f"refusing to run against a real database: {path}")
    for suffix in ("", "-wal", "-shm"):
        for path in (str(pipelines) + suffix, board + suffix):
            if os.path.exists(path):
                os.unlink(path)
    # pipelines_db caches "this path is initialised" per resolved path per
    # process, so deleting the file is not enough: the next connect() would skip
    # the schema and fail with "no such table". Clear the cache with the file.
    db._INITIALIZED_PATHS.discard(str(pipelines.resolve()))
    yield


def _template(template_id: str = "word") -> dict:
    """The real v1 step shape, not an approximation of it.

    The validator rejected a hand-written version of this twice; steps need an
    explicit ``type``, and the graph needs ``start_step``.
    """
    return {
        "schema_version": "1.0", "id": template_id, "version": "1.0.0",
        "name": "Word report", "start_step": "draft",
        "inputs_schema": {"type": "object", "properties": {"topic": {"type": "string"}},
                          "required": ["topic"]},
        "steps": [
            {"id": "draft", "type": "agent", "profile": "w", "instruction": "D",
             "input": {}, "next": "publish"},
            {"id": "publish", "type": "tool", "tool": "t", "instruction": "E",
             "input": {}, "next": None},
        ],
    }


@pytest.fixture
def client():
    """The kanban API on the same isolated databases, for the drag-guard tests."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from hermes_cli import kanban_api
    from hermes_cli import pipeline_credentials

    app = FastAPI()
    app.include_router(kanban_api.router, prefix="/api/kanban")
    with TestClient(app) as c:
        yield c


def _conns():
    pipeline_conn = db.connect()
    card_conn = kanban_db_connect.connect()
    return pipeline_conn, card_conn


def test_run_and_card_are_created_together():
    pipeline_conn, card_conn = _conns()
    with closing(pipeline_conn), closing(card_conn):
        started = pipeline_board.start_run_with_card(
            pipeline_conn, template=_template(), inputs={"topic": "sales"},
            owner_scope="site-a")
        run = db.get_run(pipeline_conn, started["run_id"])
        assert run.card_id == started["card_id"]
        card = kb.get_task(card_conn, started["card_id"])
        assert card is not None
        assert "pipeline" in card.title.lower()
        assert db.list_events(pipeline_conn, started["run_id"])[0].type == "run.created"


def test_a_failed_run_leaves_no_card_behind(monkeypatch):
    """The compensation, which is the half of the pair a human would see."""
    pipeline_conn, card_conn = _conns()
    with closing(pipeline_conn), closing(card_conn):
        before = card_conn.execute("SELECT COUNT(*) AS n FROM tasks").fetchone()["n"]

        def boom(*_args, **_kwargs):
            raise RuntimeError("run insert failed")

        monkeypatch.setattr(pipeline_board.db, "create_run", boom)
        with pytest.raises(RuntimeError):
            pipeline_board.start_run_with_card(
                pipeline_conn, template=_template(), owner_scope="site-a")

        after = card_conn.execute("SELECT COUNT(*) AS n FROM tasks").fetchone()["n"]
        assert after == before, "a card was left behind with no run to justify it"


def test_a_failed_compensation_is_reported_not_swallowed(monkeypatch):
    """If the card cannot be removed, the caller is told; it is not left to guess."""
    pipeline_conn, card_conn = _conns()
    with closing(pipeline_conn), closing(card_conn):

        def boom(*_args, **_kwargs):
            raise RuntimeError("run insert failed")

        monkeypatch.setattr(pipeline_board.db, "create_run", boom)
        monkeypatch.setattr(pipeline_board.kb, "delete_task",
                            lambda *a, **k: (_ for _ in ()).throw(OSError("locked")))
        with pytest.raises(pipeline_board.StartError):
            pipeline_board.start_run_with_card(
                pipeline_conn, template=_template(), owner_scope="site-a")


def test_the_reconciler_finds_a_card_with_no_run():
    pipeline_conn, card_conn = _conns()
    with closing(pipeline_conn), closing(card_conn):
        orphan = kb.create_task(card_conn, title="[pipeline] orphaned", initial_status="blocked")
        broken = pipeline_board.find_broken_pairs(pipeline_conn, card_conn)
        assert any(b.kind == "card_without_run" and b.card_id == orphan for b in broken), broken


def test_the_reconciler_finds_a_run_whose_card_is_gone():
    pipeline_conn, card_conn = _conns()
    with closing(pipeline_conn), closing(card_conn):
        started = pipeline_board.start_run_with_card(
            pipeline_conn, template=_template(), owner_scope="site-a")
        kb.delete_task(card_conn, started["card_id"])
        broken = pipeline_board.find_broken_pairs(pipeline_conn, card_conn)
        assert any(b.kind == "card_without_run" and b.run_id == started["run_id"]
                   for b in broken), broken


# --- run status -> board column (spec §9) ----------------------------------


def test_the_spec_mapping_column_for_run():
    """The mapping is the spec's, asserted here so it cannot be quietly edited."""
    assert pipeline_board.column_for_run("queued") == "ready"
    assert pipeline_board.column_for_run("running") == "running"
    assert pipeline_board.column_for_run("running", on_review=True) == "review"
    assert pipeline_board.column_for_run("waiting_input") == "blocked"
    assert pipeline_board.column_for_run("blocked") == "blocked"
    assert pipeline_board.column_for_run("failed") == "blocked"
    assert pipeline_board.column_for_run("completed") == "done"
    assert pipeline_board.column_for_run("cancelled") == "archived"


def test_an_unmapped_status_moves_nothing_rather_than_guessing():
    assert pipeline_board.column_for_run("some_state_the_spec_does_not_cover") is None


def test_the_column_follows_the_run_status():
    pipeline_conn, card_conn = _conns()
    with closing(pipeline_conn), closing(card_conn):
        started = pipeline_board.start_run_with_card(
            pipeline_conn, template=_template(), owner_scope="site-a")
        run_id, card_id = started["run_id"], started["card_id"]

        pipeline_conn.execute(
            "UPDATE pipeline_runs SET status = 'completed' WHERE id = ?", (run_id,))
        pipeline_conn.commit()
        assert pipeline_board.sync_card_column(pipeline_conn, card_conn, run_id) == "done"
        assert kb.get_task(card_conn, card_id).status == "done"


def test_a_running_review_step_lands_in_review():
    pipeline_conn, card_conn = _conns()
    with closing(pipeline_conn), closing(card_conn):
        started = pipeline_board.start_run_with_card(
            pipeline_conn, template=_template(), owner_scope="site-a")
        pipeline_conn.execute(
            "UPDATE pipeline_runs SET status = 'running' WHERE id = ?", (started["run_id"],))
        pipeline_conn.commit()
        assert pipeline_board.sync_card_column(
            pipeline_conn, card_conn, started["run_id"], on_review=True) == "review"


def test_an_ordinary_card_is_untouched_by_any_run():
    """No run references it, so nothing the executor does can reach it.

    This is the property that actually holds, and it holds because ownership is
    by reference: a card becomes a pipeline card by being named in a run's
    `card_id`. A run that names a card owns that card, and moving it is then
    correct rather than a violation. The spec's real protection — refusing a
    *manual* column change on a pipeline card — belongs in the drag path, not
    here, and asserting it here would have tested a check that does not exist.
    """
    pipeline_conn, card_conn = _conns()
    with closing(pipeline_conn), closing(card_conn):
        ordinary = kb.create_task(card_conn, title="a normal card")
        # Runs exist; none of them name this card.
        other = pipeline_board.start_run_with_card(
            pipeline_conn, template=_template(), owner_scope="site-a")
        pipeline_conn.execute(
            "UPDATE pipeline_runs SET status = 'completed' WHERE id = ?", (other["run_id"],))
        pipeline_conn.commit()
        assert pipeline_board.sync_card_column(pipeline_conn, card_conn, other["run_id"]) == "done"
        # `ready` is what create_task derives for a card with no parents and no
        # explicit initial status.
        assert kb.get_task(card_conn, ordinary).status == "ready"


def test_a_manual_column_change_on_a_pipeline_card_is_refused(client):
    """Spec §9, in the MVP: drag must not start a step, skip a review, or mark a
    run done. Refused where a human's drag lands.

    The pair is created through `start_run_with_card` rather than the pipelines
    API so that the only thing under test is the board's refusal — which is
    where the spec puts it, and which needs no credential to set up.
    """
    pipeline_conn, card_conn = _conns()
    with closing(pipeline_conn), closing(card_conn):
        started = pipeline_board.start_run_with_card(
            pipeline_conn, template=_template(), owner_scope="site-a")
    moved = client.patch(f"/api/kanban/tasks/{started['card_id']}", json={"status": "done"})
    assert moved.status_code == 409, moved.text
    assert "pipeline" in moved.text.lower()


def test_a_manual_column_change_on_an_ordinary_card_still_works(client):
    """The guard must not stop the ordinary board, which is the whole risk here."""
    card_id = client.post("/api/kanban/tasks",
                         json={"title": "an ordinary card"}).json()["task"]["id"]
    # `review`, not `done`: the completion gate (#11) refuses `done` without
    # result/summary evidence, which is correct and unrelated to this guard.
    moved = client.patch(f"/api/kanban/tasks/{card_id}", json={"status": "review"})
    assert moved.status_code == 200, moved.text


def test_a_missing_card_is_a_no_op_not_an_error():
    """A run whose card was deleted: the sync reports nothing and raises nothing."""
    pipeline_conn, card_conn = _conns()
    with closing(pipeline_conn), closing(card_conn):
        started = pipeline_board.start_run_with_card(
            pipeline_conn, template=_template(), owner_scope="site-a")
        kb.delete_task(card_conn, started["card_id"])
        pipeline_conn.execute(
            "UPDATE pipeline_runs SET status = 'completed' WHERE id = ?",
            (started["run_id"],))
        pipeline_conn.commit()
        assert pipeline_board.sync_card_column(
            pipeline_conn, card_conn, started["run_id"]) is None


def test_a_second_sync_is_a_no_op():
    pipeline_conn, card_conn = _conns()
    with closing(pipeline_conn), closing(card_conn):
        started = pipeline_board.start_run_with_card(
            pipeline_conn, template=_template(), owner_scope="site-a")
        run_id = started["run_id"]
        pipeline_conn.execute(
            "UPDATE pipeline_runs SET status = 'completed' WHERE id = ?", (run_id,))
        pipeline_conn.commit()
        assert pipeline_board.sync_card_column(pipeline_conn, card_conn, run_id) == "done"
        assert pipeline_board.sync_card_column(pipeline_conn, card_conn, run_id) is None


def test_the_column_change_is_recorded_on_the_card():
    pipeline_conn, card_conn = _conns()
    with closing(pipeline_conn), closing(card_conn):
        started = pipeline_board.start_run_with_card(
            pipeline_conn, template=_template(), owner_scope="site-a")
        run_id = started["run_id"]
        pipeline_conn.execute(
            "UPDATE pipeline_runs SET status = 'completed' WHERE id = ?", (run_id,))
        pipeline_conn.commit()
        pipeline_board.sync_card_column(pipeline_conn, card_conn, run_id)
        events = card_conn.execute(
            "SELECT kind, payload FROM task_events WHERE task_id = ? ORDER BY id",
            (started["card_id"],)).fetchall()
        assert any(e["kind"] == "status_changed" for e in events), [e["kind"] for e in events]


def test_a_whole_pair_is_not_reported_as_broken():
    pipeline_conn, card_conn = _conns()
    with closing(pipeline_conn), closing(card_conn):
        pipeline_board.start_run_with_card(
            pipeline_conn, template=_template(), owner_scope="site-a")
        assert pipeline_board.find_broken_pairs(pipeline_conn, card_conn) == []
