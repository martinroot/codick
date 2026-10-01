"""Microsoft To Do as a delivery channel (#69)

The ingress layer from #54-#57 already knows how to route a delivery and write a
result back. What was missing is the thing that actually talks to Microsoft To
Do. This module is that, and nothing more: it does not dispatch runs, and it does
not know what a pipeline is.

**To Do is Planner.** ``GET /me/todo/lists/{id}/tasks`` is the To Do surface in
Graph; ``Tasks.Read``/``Tasks.ReadWrite`` delegated permission is all it needs.

## Identity

``item_correlation`` is a pure function of the Graph task id. That is the whole
design: the same To Do item is the same underlying task on every poll, on every
machine, without a lookup table and without trusting anything the payload says.
The other channels in #57 -- Telegram, the HTTP ingress -- can then attach to the
same correlation, which is how one job can be mentioned in two places and remain
one job.

## Restraint

Polling must be safe to run on a timer. Re-reading an item does not create a
second task, and completing an item that is already complete does not PATCH it
again -- a redundant write moves ``modifiedDateTime`` and can wake a
notification for a change nobody made.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional

from hermes_cli import task_dispatch
from hermes_cli import task_ingress as ingress

PLATFORM = "todo"
TODO_BASE = "/me/todo/lists"
#: Cross-list form. ``/me/todo/lists/{listId}/tasks/{id}`` is valid too, but it
#: needs the list, and the task row does not always have one -- an item reached
#: through a shared list may arrive with ``listId`` absent. This path needs only
#: the task id, which is the one thing we know we have.
TASK_PATH = "/me/todo/lists/tasks"


def item_correlation(item_id: str) -> str:
    """The stable task identity for one To Do item.

    Hashed rather than embedded so an id of any shape (Graph uses long
    alphanumeric strings, and other channels will have their own) lands in the
    same namespace without carrying whatever the id contains into the task row.
    """
    digest = hashlib.sha256(f"{PLATFORM}:{item_id}".encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


@dataclass(frozen=True)
class TodoItem:
    """One To Do task, normalized -- and only what we are willing to rely on."""

    item_id: str
    title: str
    list_id: str = ""
    importance: str = "normal"
    body: str = ""

    @property
    def correlation_id(self) -> str:
        return item_correlation(self.item_id)


class TodoItemError(ValueError):
    """A To Do payload that cannot be turned into an item."""


def parse_task(raw: Any, *, list_id: str = "") -> TodoItem:
    """One Graph task dict into a :class:`TodoItem`.

    Refuses rather than guesses. A task without an id has no stable identity, so
    deriving one would mint a new task on every poll -- the exact failure this
    connector exists to avoid. A missing title is not fatal: the item is still
    the same item, and an empty title is visible rather than silently filled in.
    """
    if not isinstance(raw, dict):
        raise TodoItemError(f"expected a task object, got {type(raw).__name__}")
    item_id = raw.get("id")
    if not isinstance(item_id, str) or not item_id.strip():
        raise TodoItemError("task has no id, so it has no stable identity")
    title = raw.get("title")
    if title is not None and not isinstance(title, str):
        raise TodoItemError("task title is not text")
    importance = raw.get("importance")
    if importance not in (None, "", "low", "normal", "high"):
        raise TodoItemError(f"unknown importance {importance!r}")
    return TodoItem(
        item_id=item_id,
        title=title or "",
        list_id=str(raw.get("listId") or list_id or ""),
        importance=importance or "normal",
        body=raw.get("bodyPreview") or "",
    )


# --- reading -------------------------------------------------------------------


async def list_items(client: Any, *, list_id: str = "") -> List[TodoItem]:
    """Every task across the lists, or within one list when named.

    Uses the client's own pagination rather than paging by hand: a partial read
    that looked complete would leave tasks silently un-ingested, which is the
    shape of a bug nobody notices for a month.
    """
    if list_id:
        payload = await client.collect_paginated(f"{TODO_BASE}/{list_id}/tasks")
    else:
        lists = await client.collect_paginated("/me/todo/lists")
        payload = []
        for entry in lists:
            lid = entry.get("id") if isinstance(entry, dict) else None
            if not lid:
                continue
            payload.extend(await client.collect_paginated(f"{TODO_BASE}/{lid}/tasks"))
    items: List[TodoItem] = []
    for raw in payload:
        items.append(parse_task(raw, list_id=list_id))
    return items


# --- writing -------------------------------------------------------------------


def ingest(conn: Any, items: Iterable[TodoItem]) -> List[Any]:
    """Record each item as a delivery of the task it names.

    Idempotent by construction: the correlation is a function of the item id, so
    a second poll re-delivers the same task rather than creating another. Runs
    created from these are bounded by ``task_dispatch``, which refuses to start
    a second run for a task that already has one.
    """
    tasks = []
    for item in items:
        ingress.record_delivery(
            conn, platform=PLATFORM, external_id=item.item_id,
            correlation_id=item.correlation_id,
        )
        tasks.append(ingress.upsert_task(
            conn, platform=PLATFORM, external_id=item.item_id,
            correlation_id=item.correlation_id, title=item.title,
            # The channel is a fact about where this arrived, and recording it is
            # what lets a routing rule name To Do without hard-coding the
            # platform everywhere a routing table is built.
            channel=PLATFORM,
            detail={"importance": item.importance, "list_id": item.list_id},
        ))
    return tasks


async def complete_item(client: Any, conn: Any, item_id: str) -> Dict[str, Any]:
    """Mark the item done, once.

    Returns ``{"completed": True, "changed": False}`` when the task was already
    finished. A redundant PATCH would move ``modifiedDateTime`` and can raise a
    notification for a change nobody made, so the state lives in our own row and
    is checked before the network call, not after.
    """
    task = ingress.get_task(conn, platform=PLATFORM, external_id=item_id)
    if task is not None and task.state == "done":
        return {"completed": True, "changed": False, "item_id": item_id}
    result = await client.patch_json(
        f"{TASK_PATH}/{item_id}",
        json_body={"status": "completed"},
    )
    if task is not None:
        task_dispatch.writeback_state(conn, task, "done")
    return {"completed": True, "changed": True, "item_id": item_id,
            "response": result if isinstance(result, dict) else {}}


async def add_checklist_item(client: Any, item_id: str, title: str, *,
                             checked: bool = False) -> Dict[str, Any]:
    """Append a line to the item's checklist -- how a result is handed back.

    Checked, not overwritten: the user's own checklist lines are theirs, and a
    writeback that rewrote the list would destroy work nobody asked it to touch.
    """
    result = await client.post_json(
        f"{TASK_PATH}/{item_id}/checklistItems",
        json_body={"title": title, "isChecked": bool(checked)},
    )
    return result if isinstance(result, dict) else {}
