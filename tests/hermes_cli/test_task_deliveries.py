"""#57 — one task, however many channels mention it.

The schema said this could not happen: ``external_tasks`` is keyed by
correlation id under a unique index, so a To Do item and a Telegram message
about the same work could never both be rows. The delivery table makes it
expressible, and these tests hold the thing that matters -- both channels
resolve to *one* task, one session, one run.
"""

import pytest

from hermes_cli import task_ingress as ti
from hermes_cli.sqlite_util import write_txn


@pytest.fixture()
def conn(tmp_path):
    c = ti.connect(db_path=tmp_path / "ingress.db")
    yield c
    c.close()


def make_task(conn, platform, external_id, correlation=None, **fields):
    task = ti.upsert_task(
        conn, platform=platform, external_id=external_id,
        correlation_id=correlation, **fields,
    )
    return task


# --- the case that used to be impossible --------------------------------------


def test_two_channels_naming_one_correlation_are_one_task(conn):
    todo = make_task(conn, "todo", "item-7", correlation="cor_shared", title="Ship it")
    telegram = ti.record_delivery(
        conn, platform="telegram", external_id="msg-99", correlation_id="cor_shared",
    )
    assert telegram == "cor_shared"

    from_todo = ti.get_task(conn, platform="todo", external_id="item-7")
    from_telegram = ti.get_task(conn, platform="telegram", external_id="msg-99")
    assert from_todo is not None and from_telegram is not None
    assert from_todo.correlation_id == from_telegram.correlation_id == "cor_shared"
    assert from_todo.title == from_telegram.title == "Ship it"


def test_the_task_row_stays_single(conn):
    make_task(conn, "todo", "item-7", correlation="cor_shared")
    ti.record_delivery(conn, platform="telegram", external_id="msg-99",
                       correlation_id="cor_shared")
    rows = conn.execute("SELECT COUNT(*) c FROM external_tasks").fetchone()
    assert rows["c"] == 1, "the second channel must not create a second task"


def test_both_channels_are_listed_as_deliveries_of_that_task(conn):
    make_task(conn, "todo", "item-7", correlation="cor_shared")
    ti.record_delivery(conn, platform="telegram", external_id="msg-99",
                       correlation_id="cor_shared")
    handles = ti.list_deliveries(conn, "cor_shared")
    assert {(h["platform"], h["external_id"]) for h in handles} == {
        ("todo", "item-7"), ("telegram", "msg-99")}


# --- one session, resumed rather than restarted ------------------------------


def test_a_session_bound_from_either_channel_is_the_same_session(conn):
    task = make_task(conn, "todo", "item-7", correlation="cor_shared")
    ti.record_delivery(conn, platform="telegram", external_id="msg-99",
                       correlation_id="cor_shared")
    ti.bind_run(conn, platform="telegram", external_id="msg-99",
                run_id="run_1", session_id="sess_1")

    # The binding is visible from the *other* channel, because it is the task's.
    from_todo = ti.get_task(conn, platform="todo", external_id="item-7")
    assert from_todo.run_id == "run_1"
    assert from_todo.session_id == "sess_1"


def test_binding_from_the_second_channel_does_not_start_a_second_run(conn):
    """#56's idempotency, seen through the #57 lens: two channels, one work."""
    task = make_task(conn, "todo", "item-7", correlation="cor_shared")
    ti.record_delivery(conn, platform="telegram", external_id="msg-99",
                       correlation_id="cor_shared")
    ti.bind_run(conn, platform="todo", external_id="item-7",
                run_id="run_1", session_id="sess_1")
    ti.bind_run(conn, platform="telegram", external_id="msg-99",
                run_id="run_1", session_id="sess_1")
    rows = conn.execute(
        "SELECT DISTINCT run_id FROM external_tasks WHERE correlation_id = 'cor_shared'"
    ).fetchall()
    assert [r["run_id"] for r in rows] == ["run_1"]


# --- idempotency of the delivery itself ---------------------------------------


def test_recording_the_same_delivery_twice_is_one_row(conn):
    ti.record_delivery(conn, platform="todo", external_id="i1", correlation_id="c1")
    ti.record_delivery(conn, platform="todo", external_id="i1", correlation_id="c1")
    assert len(ti.list_deliveries(conn, "c1")) == 1


def test_a_retry_naming_a_different_task_is_refused(conn):
    """Silently keeping the old binding would make the delivery's own
    correlation id a lie."""
    ti.record_delivery(conn, platform="todo", external_id="i1", correlation_id="c1")
    with pytest.raises(ValueError) as excinfo:
        ti.record_delivery(conn, platform="todo", external_id="i1", correlation_id="c2")
    assert "already bound" in str(excinfo.value)


def test_a_retry_naming_the_same_task_is_accepted(conn):
    ti.record_delivery(conn, platform="todo", external_id="i1", correlation_id="c1")
    assert ti.record_delivery(
        conn, platform="todo", external_id="i1", correlation_id="c1") == "c1"


def test_the_same_id_on_two_platforms_is_two_deliveries(conn):
    """Ids are scoped by platform: '7' on To Do is not '7' on Telegram."""
    ti.record_delivery(conn, platform="todo", external_id="7", correlation_id="c1")
    ti.record_delivery(conn, platform="telegram", external_id="7", correlation_id="c2")
    assert len(ti.list_deliveries(conn, "c1")) == 1
    assert len(ti.list_deliveries(conn, "c2")) == 1


# --- existing databases keep working -----------------------------------------


def test_a_task_written_before_the_delivery_table_is_still_reachable(conn):
    """Databases written by the old schema have a task row and no delivery
    behind it. Two things have to keep working: the task is still resolvable by
    its own handle, and the backfill gives it a delivery so a second channel
    can find it."""
    make_task(conn, "todo", "item-7", correlation="cor_old")
    with write_txn(conn):
        conn.execute("DELETE FROM external_deliveries")

    # The fallback in get_task is what keeps the old row reachable.
    assert ti.get_task(conn, platform="todo", external_id="item-7") is not None

    ti._backfill_deliveries(conn)
    assert len(ti.list_deliveries(conn, "cor_old")) == 1


def test_a_backfilled_task_is_reachable_from_a_second_channel(conn):
    """The point of the backfill: a task that predates the delivery table can
    still be joined by a channel that arrives afterwards."""
    make_task(conn, "todo", "item-7", correlation="cor_old")
    with write_txn(conn):
        conn.execute("DELETE FROM external_deliveries")
    ti._backfill_deliveries(conn)

    ti.record_delivery(conn, platform="telegram", external_id="msg-1",
                       correlation_id="cor_old")
    assert ti.get_task(conn, platform="telegram", external_id="msg-1") is not None


def test_the_backfill_is_safe_to_run_twice(conn):
    make_task(conn, "todo", "item-7", correlation="cor_old")
    ti._backfill_deliveries(conn)
    ti._backfill_deliveries(conn)
    assert len(ti.list_deliveries(conn, "cor_old")) == 1


def test_an_unknown_handle_is_none_not_an_error(conn):
    assert ti.get_task(conn, platform="todo", external_id="nope") is None


def test_listing_deliveries_for_an_unknown_task_is_empty(conn):
    assert ti.list_deliveries(conn, "cor_nothing") == []
