"""#69 — the To Do connector, against the real interfaces.

The Graph client here is a fake with the same surface as
``tools.microsoft_graph_client.MicrosoftGraphClient``: ``get_json``,
``patch_json``, ``post_json``, ``collect_paginated``. The ingress DB is real.

**No live Microsoft account is involved anywhere in this file.** Everything here
proves the connector's own logic -- identity, idempotency, refusals, writeback
discipline -- against those two real seams. It does not prove Graph accepts these
requests; only a live credential can do that, and asserting otherwise would be
the exact sin this file exists to prevent.
"""

import asyncio

import pytest

from hermes_cli import task_dispatch
from hermes_cli import task_ingress as ingress
from hermes_cli import task_routing
from hermes_cli import todo_connector as todo


class FakeGraph:
    """The Graph client's surface, recording what was called."""

    def __init__(self, *, lists=None, tasks=None, fail=None):
        self.lists = lists or []
        self.tasks = tasks or {}
        self.fail = fail
        self.patches = []
        self.posts = []

    async def collect_paginated(self, path, *, params=None, headers=None):
        if self.fail and self.fail in path:
            raise RuntimeError(f"graph said no: {path}")
        if path == "/me/todo/lists":
            return list(self.lists)
        for entry in self.lists:
            lid = entry.get("id") if isinstance(entry, dict) else None
            if lid and path == f"/me/todo/lists/{lid}/tasks":
                return list(self.tasks.get(lid, []))
        return []

    async def patch_json(self, path, *, json_body=None, headers=None):
        self.patches.append((path, json_body))
        return {"id": path.rsplit("/", 1)[-1], "status": "completed"}

    async def post_json(self, path, *, json_body=None, headers=None):
        self.posts.append((path, json_body))
        return {"id": "chk_1", **(json_body or {})}


@pytest.fixture()
def conn(tmp_path):
    c = ingress.connect_closing()
    with c as opened:
        yield opened


def task_row(raw_id="AAMk-1", title="Ship the report", **over):
    return {"id": raw_id, "title": title, **over}


# --- identity ------------------------------------------------------------------


def test_the_same_item_always_names_the_same_task():
    assert todo.item_correlation("AAMk-1") == todo.item_correlation("AAMk-1")


def test_different_items_do_not_collide():
    assert todo.item_correlation("AAMk-1") != todo.item_correlation("AAMk-2")


def test_a_caller_cannot_inject_a_correlation_through_the_item_id():
    """The correlation is computed, never read from the payload. An item whose
    id tries to name a task it does not own gets its own identity."""
    forged = todo.item_correlation("cor_someone_elses_task")
    assert not forged.startswith("cor_")
    assert todo.item_correlation("cor_someone_elses_task") == forged


# --- parsing -------------------------------------------------------------------


def test_a_task_parses_into_an_item():
    item = todo.parse_task(task_row(importance="high", bodyPreview="body text"))
    assert item.item_id == "AAMk-1"
    assert item.title == "Ship the report"
    assert item.importance == "high"
    assert item.body == "body text"


def test_a_task_without_an_id_is_refused():
    """No id means no stable identity, and a derived one would mint a new task
    on every poll."""
    with pytest.raises(todo.TodoItemError):
        todo.parse_task({"title": "anonymous"})
    with pytest.raises(todo.TodoItemError):
        todo.parse_task({"id": "   ", "title": "blank id"})


def test_a_payload_that_is_not_an_object_is_refused():
    with pytest.raises(todo.TodoItemError):
        todo.parse_task(["not", "an", "object"])
    with pytest.raises(todo.TodoItemError):
        todo.parse_task(None)


def test_a_missing_title_is_empty_rather_than_invented():
    item = todo.parse_task({"id": "AAMk-9"})
    assert item.title == "", "an empty title is visible; a made-up one is not"
    assert item.importance == "normal"


def test_a_title_that_is_not_text_is_refused():
    with pytest.raises(todo.TodoItemError):
        todo.parse_task({"id": "AAMk-9", "title": {"nested": 1}})


def test_an_unknown_importance_is_refused():
    with pytest.raises(todo.TodoItemError):
        todo.parse_task({"id": "AAMk-9", "importance": "urgent"})


# --- reading -------------------------------------------------------------------


def test_lists_are_read_and_their_tasks_followed():
    graph = FakeGraph(
        lists=[{"id": "l1"}, {"id": "l2"}],
        tasks={"l1": [task_row("t1")], "l2": [task_row("t2")]},
    )
    items = asyncio.run(todo.list_items(graph))
    assert [i.item_id for i in items] == ["t1", "t2"]


def test_one_list_can_be_named():
    graph = FakeGraph(lists=[{"id": "l1"}], tasks={"l1": [task_row("t1")]})
    items = asyncio.run(todo.list_items(graph, list_id="l1"))
    assert [i.item_id for i in items] == ["t1"]


def test_a_list_without_an_id_is_skipped_not_fatal():
    """One malformed list must not cost us every other list's tasks."""
    graph = FakeGraph(
        lists=[{"id": "l1"}, {"title": "nameless"}, {"id": "l2"}],
        tasks={"l1": [task_row("t1")], "l2": [task_row("t2")]},
    )
    items = asyncio.run(todo.list_items(graph))
    assert [i.item_id for i in items] == ["t1", "t2"]


def test_a_graph_failure_is_not_swallowed():
    graph = FakeGraph(lists=[{"id": "l1"}], tasks={"l1": [task_row("t1")]},
                      fail="l2")
    with pytest.raises(RuntimeError):
        asyncio.run(todo.list_items(graph, list_id="l2"))


# --- ingesting -----------------------------------------------------------------


def test_polling_the_same_item_twice_creates_one_task(conn):
    items = [todo.parse_task(task_row("AAMk-1"))]
    first = todo.ingest(conn, items)
    second = todo.ingest(conn, items)
    assert first[0].correlation_id == second[0].correlation_id
    rows = conn.execute(
        "SELECT COUNT(*) c FROM external_tasks WHERE platform='todo'").fetchone()
    assert rows["c"] == 1


TEMPLATE = {"id": "tpl", "version": "1",
            "steps": [{"id": "draft", "type": "tool", "tool": "t",
                       "instruction": "E", "input": {}}]}


def test_two_polls_do_not_start_two_runs(conn):
    """The end of the chain: ingress says one task, dispatch says one run."""
    runs = []

    def fake_create_run(c, template_id, **kwargs):
        run_id = f"run_{len(runs) + 1}"
        runs.append(run_id)
        return run_id

    items = [todo.parse_task(task_row("AAMk-1"))]
    todo.ingest(conn, items)
    todo.ingest(conn, items)

    rules = [task_routing.Rule(name="todo", channel="todo", profile="house")]
    for _ in range(2):
        task = ingress.get_task(conn, platform="todo", external_id="AAMk-1")
        task_dispatch.dispatch(conn, task, TEMPLATE, rules=rules,
                               create_run=fake_create_run)

    assert len(runs) == 1, "polling is a timer; it must not multiply work"


def test_a_telegram_message_about_the_same_job_joins_the_todo_task(conn):
    """#57's property, reached through a real To Do delivery."""
    item = todo.parse_task(task_row("AAMk-1", title="Ship the report"))
    todo.ingest(conn, [item])
    correlation = item.correlation_id
    ingress.record_delivery(conn, platform="telegram", external_id="msg-7",
                            correlation_id=correlation)
    from_todo = ingress.get_task(conn, platform="todo", external_id="AAMk-1")
    from_telegram = ingress.get_task(conn, platform="telegram", external_id="msg-7")
    assert from_todo is not None and from_telegram is not None
    assert from_todo.correlation_id == from_telegram.correlation_id == correlation


def test_ingesting_nothing_changes_nothing(conn):
    before = conn.execute("SELECT COUNT(*) c FROM external_tasks").fetchone()["c"]
    todo.ingest(conn, [])
    after = conn.execute("SELECT COUNT(*) c FROM external_tasks").fetchone()["c"]
    assert before == after


# --- writing back --------------------------------------------------------------


def test_completing_an_item_marks_our_row_done(conn):
    task = todo.ingest(conn, [todo.parse_task(task_row("AAMk-1"))])[0]
    graph = FakeGraph()
    result = asyncio.run(todo.complete_item(graph, conn, "AAMk-1"))
    assert result["changed"] is True
    assert graph.patches[0][0] == "/me/todo/lists/tasks/AAMk-1"
    again = ingress.get_task(conn, platform="todo", external_id="AAMk-1")
    assert again.state == "done"


def test_completing_an_already_done_item_writes_nothing(conn):
    """A redundant PATCH moves modifiedDateTime and can raise a notification for
    a change nobody made."""
    todo.ingest(conn, [todo.parse_task(task_row("AAMk-1"))])
    graph = FakeGraph()
    asyncio.run(todo.complete_item(graph, conn, "AAMk-1"))
    asyncio.run(todo.complete_item(graph, conn, "AAMk-1"))
    assert len(graph.patches) == 1, "the second completion must not hit Graph"


def test_a_result_is_appended_rather_than_overwriting_the_users_list(conn):
    graph = FakeGraph()
    asyncio.run(todo.add_checklist_item(graph, "AAMk-1", "Report attached", checked=True))
    path, body = graph.posts[0]
    assert path == "/me/todo/lists/tasks/AAMk-1/checklistItems"
    assert body == {"title": "Report attached", "isChecked": True}
    assert graph.patches == [], "appending must not rewrite what the user wrote"


def test_a_writeback_for_an_unknown_item_still_reaches_graph(conn):
    """We do not know the item locally, and refusing to report a result because
    our own row is missing would lose the answer."""
    graph = FakeGraph()
    result = asyncio.run(todo.complete_item(graph, conn, "never-seen"))
    assert result["changed"] is True
    assert len(graph.patches) == 1
