"""Creating a run and its board card as one operation (spec §9, issue #33).

The spec asks for the card and the run to be created **atomically**, and to be
explicit that "a card without a run, or a run without a card, is a broken pair".

**That is not achievable in one transaction here, and this module says so rather
than pretending.** The two live in different files: the card in ``kanban.db``,
the run in ``plugin-data/pipelines/pipelines.db``. SQLite's answer to "one
transaction, two files" is ``ATTACH``, and SQLite's own documentation is that a
multi-database transaction is atomic only if *no* attached database is in WAL
mode. ``kanban.db`` is in WAL, so a cross-file transaction would commit one
database and fail the other, which is the broken pair itself — the failure the
requirement exists to prevent.

Turning WAL off is not an option and not even a choice:
``kanban_db_connect.connect`` re-enables WAL on *every* connection, so WAL is an
invariant of the board's storage rather than an incidental setting.
``pipelines.db`` sits in DELETE mode only
because this SQLite build is vulnerable to the WAL-reset corruption bug
(3.45.1 < 3.51.3), and the WAL guard is the reason. Degrading a live board's
durability to buy a cosmetic guarantee is the wrong trade.

So: **ordered creation with compensation, and a reconciler.** The card goes
first, because it is the thing a human sees and a delete can undo; if the run then
fails, the card is removed through the supported safe-delete path. The residual
window is the reverse case — a crash between the two writes — which
:func:`find_broken_pairs` exists to find, so an interrupted Run cannot quietly
leave a card with no run behind it.

The order matters and is the opposite of what a first reading suggests: making
the *run* first would leave a run nothing can see, and a run is the more
expensive thing to abandon because it may already hold a lease.
"""

import logging
import sqlite3
from typing import NamedTuple, Optional

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_db_connect
from hermes_cli import pipelines_db as db
from hermes_cli.pipeline_template import validate_template

log = logging.getLogger(__name__)


class BrokenPair(NamedTuple):
    kind: str          # "card_without_run" | "run_without_card"
    card_id: Optional[str]
    run_id: Optional[str]
    detail: str


class StartError(Exception):
    """Raised when neither the card nor the run was left behind."""


def _card_title(template: dict, run_id: str) -> str:
    """The board title: the order's name, which is what the strip must show."""
    name = template.get("name") or template.get("id") or "pipeline run"
    return f"[pipeline] {name}"


def start_run_with_card(
    pipelines_conn: sqlite3.Connection,
    *,
    template: dict,
    inputs: Optional[dict] = None,
    owner_scope: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    title: Optional[str] = None,
    run_id: Optional[str] = None,
    now: Optional[int] = None,
) -> dict:
    """Create the card and the run. Returns ``{"run_id", "card_id"}``.

    ``pipelines_conn`` is a pipelines-DB connection; the card is created through
    its own connection, because the two are separate files and this module's
    entire point is that it is not pretending otherwise.
    """
    errors = validate_template(template)
    if errors:
        raise ValueError(f"template does not validate: {errors}")

    card_conn = kanban_db_connect.connect()
    card_id = None
    try:
        card_id = kb.create_task(
            card_conn, title=title or _card_title(template, run_id or ""),
            body=None, idempotency_key=idempotency_key,
 # Parked, not ready: a card in ``ready`` can be claimed by a
 # dispatcher in the window between this insert and the run insert,
 # and a worker acting on a run that does not exist yet is worse than
 # a card that waits. VALID_INITIAL_STATUSES is {running, blocked};
 # "ready" is only a *derived* status, never an explicit one.
 initial_status="blocked",
        )
        try:
            new_run_id = db.create_run(
                pipelines_conn, template, inputs=inputs, card_id=card_id,
                owner_scope=owner_scope, run_id=run_id, now=now)
        except Exception:
            # Compensate. The card is the visible half, and safe delete is the
            # supported way to remove it, so nothing is orphaned.
            try:
                kb.delete_task(card_conn, card_id)
            except Exception:
                log.exception("card %s could not be removed after the run failed", card_id)
                raise StartError(
                    f"run creation failed and card {card_id} could not be cleaned up"
                ) from None
            raise
    finally:
        card_conn.close()

    return {"run_id": new_run_id, "card_id": card_id}


def find_broken_pairs(
    pipelines_conn: sqlite3.Connection, card_conn: sqlite3.Connection
) -> list[BrokenPair]:
    """Report one half of a pair without the other.

    Neither direction is auto-repaired. Deleting a card that has a run would
    destroy the run's anchor, and deleting a run would silently discard work, so
    this reports and lets a human decide — which is also the honest outcome of
    not having a real cross-database transaction.
    """
    broken: list[BrokenPair] = []
    runs = db.list_runs(pipelines_conn)
    card_ids = {r.card_id: r.id for r in runs if r.card_id}

    for run in runs:
        if not run.card_id:
            broken.append(BrokenPair("run_without_card", None, run.id,
                                     "run has no card reference"))
            continue
        if kb.get_task(card_conn, run.card_id) is None:
            broken.append(BrokenPair("card_without_run", run.card_id, run.id,
                                     "run points at a card that no longer exists"))

    rows = card_conn.execute(
        "SELECT id, title FROM tasks WHERE title LIKE '[pipeline]%'").fetchall()
    for row in rows:
        if row["id"] not in card_ids:
            broken.append(BrokenPair("card_without_run", row["id"], None,
                                     "card is marked as a pipeline card but no run references it"))
    return broken


__all__ = ["BrokenPair", "StartError", "find_broken_pairs", "start_run_with_card"]
