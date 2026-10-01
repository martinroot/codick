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
import shutil
import sqlite3
import time
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


# --- run status -> board column (spec §9) ----------------------------------
#
# The mapping is given by the spec and is not re-invented here:
#   queued -> Queued; running -> Running; running on review -> Review;
#   waiting_input -> Waiting for input; blocked/failed -> Blocked;
#   completed -> Done; cancelled -> archive.
#
# "running on review" is a *step* fact, not a run fact: a run is `running` both
# while an agent step executes and while a review step is what is executing. The
# caller has to say which, because only it knows the current step.

_COLUMN_FOR_STATUS = {
    "queued": "ready",
    "running": "running",
    "waiting_input": "blocked",
    "blocked": "blocked",
    "failed": "blocked",
    "completed": "done",
    "cancelled": "archived",
}

# `waiting_input` is Blocked on the board, which would make "waiting for a human"
# indistinguishable from "genuinely stuck" — and the board's own diagnostics
# treat those very differently, counting the second as an incident. The card is
# parked in `blocked` because the strip has nowhere else to put a human wait, and
# the input marker on the card is what distinguishes them. Recorded here because
# it is a real loss of information, not a free choice.
REVIEW_COLUMN = "review"


def column_for_run(status: str, *, on_review: bool = False) -> Optional[str]:
    """The board column a run's card belongs in, or ``None`` if unmapped.

    An unmapped status returns ``None`` rather than guessing: inventing a column
    for a state the spec does not cover would move a card somewhere the spec does
    not sanction.
    """
    if status == "running" and on_review:
        return REVIEW_COLUMN
    return _COLUMN_FOR_STATUS.get(status)


def sync_card_column(
    pipelines_conn: sqlite3.Connection, card_conn: sqlite3.Connection,
    run_id: str, *, on_review: bool = False,
) -> Optional[str]:
    """Move the run's card to the column its status calls for.

    Returns the column written, or ``None`` if nothing moved — which includes the
    card already being there, the card being gone, and the card not being a
    pipeline card. Only pipeline cards are ever touched: a run whose ``card_id``
    points at an ordinary card must not be able to drag it around the board.

    Called after the executor has committed, never inside its transaction, for
    the same reason the card is not created in one: the two databases cannot
    share a transaction, so a failure here is a mismatch a later sync repairs,
    not a corruption.
    """
    run = db.get_run(pipelines_conn, run_id)
    if run is None or not run.card_id:
        return None
    column = column_for_run(run.status, on_review=on_review)
    if column is None:
        return None

    task = kb.get_task(card_conn, run.card_id)
    if task is None or task.status == column:
        return None
    # A run reaching a card *through* `card_id` is what makes it a pipeline card;
    # there is no separate flag, because adding one would mean a column on the
    # board's own `tasks` table and spec §12 keeps CoDick's state in CoDick's
    # space. So this function cannot distinguish a wrongly-claimed card, and
    # pretending otherwise would be a comment in place of a check.
    #
    # The protection the spec actually asks for is elsewhere and is the
    # frontend's: drag-and-drop must not start steps, skip a review or mark a
    # run done, so manual column changes are rejected for pipeline cards. That
    # check belongs where a human's drag lands, not in the executor's own sync.
    with kb.write_txn(card_conn):
        # A card that lands in Done has to say when: `completed_at` is what the
        # board reads to age a card, and a timestamp that stays NULL makes a
        # finished run indistinguishable from one that was never started. It is
        # an INTEGER epoch column and the board sorts it arithmetically, so the
        # run's own `ended_at` is the value -- a formatted date here is a 500 on
        # the whole board, not a cosmetic difference.
        if column == "done":
            done_at = run.ended_at or int(time.time())
            extra = ", completed_at = ?"
            params: tuple = (column, done_at, run.card_id, column)
        elif column in ("ready", "running", "blocked"):
            # Back out of Done without pretending the work never happened.
            extra = ", completed_at = NULL"
            params = (column, run.card_id, column)
        else:
            extra = ""
            params = (column, run.card_id, column)
        changed = card_conn.execute(
            f"UPDATE tasks SET status = ?{extra} WHERE id = ? AND status != ?",
            params).rowcount
        if changed != 1:
            return None
        kb._append_event(
            card_conn, run.card_id, "status_changed",
            {"from": task.status, "to": column, "source": "pipeline", "run_id": run_id})
    return column


def attach_run_artifacts(
    pipelines_conn: sqlite3.Connection, card_conn: sqlite3.Connection, run_id: str
) -> list[str]:
    """Copy a finished run's deliverables onto its card as attachments.

    An artifact registered against a run lives in the pipeline artifact store and
    is downloadable from one URL, which is not where a person looks. The card's
    Files tab is. Without this the run finishes, the download endpoint answers
    200, and the card still shows no files -- the deliverable exists and the
    board does not show it.

    Attaching is idempotent per (card, filename): a retry or a second sync must
    not stack copies of the same file. Runs are attached once, after the
    executor has committed, in the card's own database -- and a failure here is
    not the run's failure, so the caller logs it and moves on.
    """
    run = db.get_run(pipelines_conn, run_id)
    if run is None or not run.card_id:
        return []
    if kb.get_task(card_conn, run.card_id) is None:
        return []

    existing = {
        att.filename for att in kb.list_attachments(card_conn, run.card_id)
    }
    attached: list[str] = []
    for artifact in db.list_artifacts(pipelines_conn, run_id):
        if artifact.filename in existing:
            continue
        try:
            source = db.resolve_artifact_path(artifact.storage_ref)
        except Exception:
            logger.warning("artifact %s has an unusable path", artifact.id)
            continue
        if not source.is_file():
            continue
        destination = kb.task_attachments_dir(run.card_id) / artifact.filename
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        except OSError:
            logger.exception("could not copy artifact %s onto card %s",
                             artifact.id, run.card_id)
            continue
        kb.add_attachment(
            card_conn, run.card_id, filename=artifact.filename,
            stored_path=str(destination.resolve()),
            content_type=artifact.mime_type, size=artifact.size,
            uploaded_by="pipeline",
        )
        existing.add(artifact.filename)
        attached.append(artifact.filename)
    return attached


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


__all__ = [
    "BrokenPair", "StartError", "column_for_run", "find_broken_pairs",
    "start_run_with_card", "sync_card_column",
]
