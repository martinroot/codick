"""#54 — durable task identity and idempotent ingress.

The acceptance that matters is the race. Everything else here is bookkeeping by
comparison: if two concurrent deliveries of one event can both start work, no
amount of correct bookkeeping makes the numbers trustworthy.
"""

import contextlib
import sqlite3
import threading
import time

import pytest

from hermes_cli import task_ingress as ti


@pytest.fixture()
def conn(tmp_path):
    c = ti.connect(db_path=tmp_path / "ingress.db")
    try:
        yield c
    finally:
        c.close()


# --- idempotent ingress -----------------------------------------------------


def test_a_first_delivery_is_claimed(conn):
    claim = ti.claim_event(
        conn, platform="todo", event_id="evt_1", payload_hash="h1"
    )
    assert claim.claimed is True
    assert claim.status == "claimed"


def test_the_same_delivery_twice_claims_once(conn):
    first = ti.claim_event(
        conn, platform="todo", event_id="evt_1", payload_hash="h1"
    )
    assert first.claimed is True

    second = ti.claim_event(
        conn, platform="todo", event_id="evt_1", payload_hash="h1"
    )
    assert second.claimed is False
    assert second.status == "claimed"


def test_a_duplicate_replays_the_original_result(conn):
    ti.claim_event(conn, platform="todo", event_id="evt_1", payload_hash="h1")
    ti.settle_event(
        conn,
        platform="todo",
        event_id="evt_1",
        status="dispatched",
        result={"run_id": "run_7", "board_task_id": "t_7"},
    )

    again = ti.claim_event(
        conn, platform="todo", event_id="evt_1", payload_hash="h1"
    )
    assert again.claimed is False
    assert again.result == {"run_id": "run_7", "board_task_id": "t_7"}


def test_a_failed_delivery_replays_its_reason(conn):
    ti.claim_event(conn, platform="todo", event_id="evt_1", payload_hash="h1")
    ti.settle_event(
        conn, platform="todo", event_id="evt_1", status="failed", error="no route"
    )
    again = ti.claim_event(
        conn, platform="todo", event_id="evt_1", payload_hash="h1"
    )
    assert again.claimed is False
    assert again.error == "no route"


def test_two_platforms_do_not_collide(conn):
    a = ti.claim_event(conn, platform="todo", event_id="evt_1", payload_hash="h1")
    b = ti.claim_event(
        conn, platform="slack", event_id="evt_1", payload_hash="h1"
    )
    assert a.claimed is True
    assert b.claimed is True


def test_concurrent_deliveries_produce_one_winner(tmp_path):
    """The acceptance check. Without the unique constraint deciding the race,
    a read-then-write gives every thread ``claimed=True`` and the task runs
    twice."""
    path = tmp_path / "ingress.db"
    setup = ti.connect(db_path=path)
    ti.upsert_task(setup, platform="todo", external_id="task_1")
    setup.close()

    results: list[bool] = []
    lock = threading.Lock()
    barrier = threading.Barrier(8)

    def deliver() -> None:
        c = ti.connect(db_path=path)
        try:
            barrier.wait(timeout=10)
            claim = ti.claim_event(
                c, platform="todo", event_id="evt_race", payload_hash="h"
            )
            with lock:
                results.append(claim.claimed)
        finally:
            c.close()

    threads = [threading.Thread(target=deliver) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=20)

    assert len(results) == 8
    assert results.count(True) == 1, f"exactly one delivery may win, got {results}"


def test_the_race_still_loses_when_the_window_is_wide(tmp_path, monkeypatch):
    """A test that cannot fail proves nothing.

    The concurrency test above passes even if ``claim_event`` is rewritten as
    read-then-insert, because SQLite's write lock happens to serialise the
    whole call by accident. So widen the window on purpose: sleep where the
    lock is taken, which is exactly what a network call or a dispatch between
    the check and the write does in production.

    With the real implementation the sleep is *inside* ``BEGIN IMMEDIATE``, so
    the writes are still serialised and the second insert is ignored. With a
    read-then-write implementation every thread reads first and every thread
    claims.
    """
    real_write_txn = ti.write_txn

    @contextlib.contextmanager
    def slow_write_txn(conn):
        time.sleep(0.05)
        with real_write_txn(conn):
            yield conn

    monkeypatch.setattr(ti, "write_txn", slow_write_txn)

    path = tmp_path / "ingress.db"
    setup = ti.connect(db_path=path)
    setup.close()

    results: list[bool] = []
    lock = threading.Lock()
    barrier = threading.Barrier(6)

    def deliver() -> None:
        c = ti.connect(db_path=path)
        try:
            barrier.wait(timeout=10)
            claim = ti.claim_event(
                c, platform="todo", event_id="evt_wide", payload_hash="h"
            )
            with lock:
                results.append(claim.claimed)
        finally:
            c.close()

    threads = [threading.Thread(target=deliver) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert len(results) == 6
    assert results.count(True) == 1, f"exactly one delivery may win, got {results}"


def test_only_one_row_exists_however_many_times_it_is_delivered(tmp_path):
    """The invariant underneath both race tests: one event is one row."""
    path = tmp_path / "ingress.db"
    c = ti.connect(db_path=path)
    try:
        for _ in range(20):
            ti.claim_event(c, platform="todo", event_id="evt_1", payload_hash="h")
        rows = c.execute(
            "SELECT COUNT(*) AS n FROM ingest_events WHERE platform = 'todo' AND event_id = 'evt_1'"
        ).fetchone()
        assert rows["n"] == 1
    finally:
        c.close()


# --- durable task identity --------------------------------------------------


def test_a_task_keeps_one_correlation_id_across_updates(conn):
    first = ti.upsert_task(conn, platform="todo", external_id="task_1", title="A")
    second = ti.upsert_task(conn, platform="todo", external_id="task_1", title="B")
    assert first.correlation_id == second.correlation_id
    # The link is the point; regenerating it would break the run, the card and
    # the reply apart on the next update.
    assert second.title == "B"


def test_a_task_is_findable_by_correlation_after_creation(conn):
    task = ti.upsert_task(conn, platform="todo", external_id="task_1")
    found = ti.get_task_by_correlation(conn, task.correlation_id)
    assert found is not None
    assert found.external_id == "task_1"


def test_binding_a_run_is_persisted_and_partial_updates_keep_it(conn):
    ti.upsert_task(conn, platform="todo", external_id="task_1")
    ti.bind_run(
        conn,
        platform="todo",
        external_id="task_1",
        board_task_id="t_9",
        run_id="run_9",
        session_id="sess_9",
    )
    later = ti.upsert_task(conn, platform="todo", external_id="task_1", title="C")
    assert later.board_task_id == "t_9"
    assert later.run_id == "run_9"
    assert later.session_id == "sess_9"


def test_state_survives_a_reopen(tmp_path):
    """A restart must be able to answer what a task was doing. If identity only
    lived in the process, this is the test that would catch it."""
    path = tmp_path / "ingress.db"
    c = ti.connect(db_path=path)
    task = ti.upsert_task(conn=c, platform="todo", external_id="task_1")
    ti.set_state(c, platform="todo", external_id="task_1", state="waiting")
    c.close()

    reopened = ti.connect(db_path=path)
    try:
        found = ti.get_task_by_correlation(reopened, task.correlation_id)
        assert found is not None
        assert found.state == "waiting"
    finally:
        reopened.close()


def test_detail_survives_as_json(conn):
    ti.upsert_task(
        conn, platform="todo", external_id="task_1", detail={"list": "Work", "n": 3}
    )
    found = ti.get_task(conn, platform="todo", external_id="task_1")
    assert found is not None
    assert found.detail == {"list": "Work", "n": 3}


def test_missing_task_is_none_not_an_error(conn):
    assert ti.get_task(conn, platform="todo", external_id="nope") is None
    assert ti.get_task_by_correlation(conn, "cor_nope") is None


# --- routing rules table (#55 groundwork) -----------------------------------


def test_routing_rules_are_primary_keyed_per_platform(conn):
    with ti.write_txn(conn):
        conn.execute(
            "INSERT OR REPLACE INTO routing_rules (platform, selector, profile, created_at)"
            " VALUES ('todo', 'Work', 'coder', 1.0)"
        )
    with ti.write_txn(conn):
        conn.execute(
            "INSERT OR REPLACE INTO routing_rules (platform, selector, profile, created_at)"
            " VALUES ('todo', 'Work', 'writer', 2.0)"
        )
    rows = conn.execute(
        "SELECT profile FROM routing_rules WHERE platform = 'todo' AND selector = 'Work'"
    ).fetchall()
    assert [r["profile"] for r in rows] == ["writer"]