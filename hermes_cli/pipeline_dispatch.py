"""Drive runs that nobody is driving (spec §7, §14).

`drive_run` is the loop; until now it had no production caller, which meant a run
created from the board sat in `queued` forever while every test drove it by
hand. The tests were green and the product was not, which is the specific
failure this module exists to end.

So: a run is driven when it is created and again when its input request is
answered. Two events, one rule — *someone must call the loop*.

Design constraints, in the order they bit:

- **One driver per run per process.** Two threads advancing one run would
  contend for the same attempt lease and burn the other's work; the executor
  would survive it, but the run would make less progress per second for no
  reason. An in-process registry keyed by run id, cleared when the loop parks.
- **The loop is not a service.** No ticker, no daemon, no cron. A run that
  needs a person parks and the process forgets about it; the next answer starts
  a fresh driver. That is why the registry is cleared on park rather than held
  for a retry.
- **A crash in the driver must not take the request with it.** The thread is
  daemonised and every failure is logged; the run's own state in SQLite is the
  record, and `recover` is the way back.
- **The connection is opened here, not passed in.** The request's connection
  belongs to the request thread and the loop outlives it; holding it across the
  loop would keep a transaction's connection alive for minutes.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from contextlib import closing
from typing import Callable, Dict, Optional

logger = logging.getLogger(__name__)

__all__ = ["ensure_driving", "is_driving", "set_enabled", "is_enabled",
           "shutdown_drivers"]

_lock = threading.Lock()
_driving: Dict[str, threading.Thread] = {}
#: Off in the test suite, on everywhere else. A background driver is the correct
#: production behaviour and the wrong test behaviour: it moves a run while a
#: test is asserting on the state it just created, and it would spend a provider
#: call. `tests/conftest.py` turns it off globally; the dispatch tests turn it
#: back on for themselves, so the tests that must exercise a real driver do.
_enabled = True


def set_enabled(enabled: bool) -> None:
    """Enable or disable starting drivers in this process."""
    global _enabled
    _enabled = bool(enabled)


def is_enabled() -> bool:
    return _enabled


def _connect() -> sqlite3.Connection:
    from hermes_cli import pipelines_db as db

    return db.connect()


def _default_adapter():
    from hermes_cli.pipeline_runner import build_default_adapter

    return build_default_adapter()


def _sync_card(run_id: str) -> None:
    """Put the run's card in the column its final status calls for.

    The card is born in ``blocked`` because ``ready`` is derived and never set
    explicitly, so without this the card sits in Blocked for the whole life of
    the run -- including after it completed successfully, which is exactly what
    a run that finished with an artifact looks like when the board still says
    Blocked.

    This runs after the executor has committed, in a second database, and its
    failure is deliberately not the run's failure: a card that failed to move is
    a board inconsistency a later sync repairs, not a lost result.
    """
    from hermes_cli import kanban_db_connect, pipeline_board

    try:
        with closing(_connect()) as pipelines_conn, \
                closing(kanban_db_connect.connect()) as card_conn:
            moved = pipeline_board.sync_card_column(pipelines_conn, card_conn, run_id)
            attached = pipeline_board.attach_run_artifacts(pipelines_conn, card_conn, run_id)
            if attached:
                logger.info("pipeline run %s attached %s to its card: %s",
                            run_id, len(attached), ", ".join(attached))
        if moved:
            logger.info("pipeline run %s moved its card to %s", run_id, moved)
    except Exception:
        logger.exception("could not sync the card for pipeline run %s", run_id)


def _drive(run_id: str, owner: str, adapter_factory: Callable[[], object]) -> None:
    from hermes_cli import pipeline_runner as runner

    try:
        with closing(_connect()) as conn:
            adapter = adapter_factory()
            report = runner.drive_run(conn, run_id, adapter, owner=owner,
                                      on_advance=lambda rid: _sync_card(rid))
            logger.info(
                "pipeline run %s drove to %s in %d step(s): %s",
                run_id, report.status, report.steps, report.stop_reason,
            )
            _sync_card(run_id)
    except Exception as exc:
        # A driver that dies must not leave the run "running" with no error and
        # nothing left to move it: the run needs a terminal state, not a log
        # line. A run whose driver vanished mid-flight is marked blocked rather
        # than failed -- nobody knows whether the step in flight completed, and
        # calling that a failure would be a guess. `recover` can pick it up.
        logger.exception("pipeline driver for run %s stopped unexpectedly", run_id)
        try:
            from hermes_cli import pipelines_db as db
            with closing(_connect()) as conn:
                row = db.get_run(conn, run_id) if hasattr(db, "get_run") else None
                if row is not None and getattr(row, "status", None) in ("running", "queued"):
                    # `blocked` is a recoverable state, not a terminal one, so it
                    # is set rather than finished -- `recover` picks it up.
                    db.set_run_status(
                        conn, run_id, "blocked",
                        error=f"the driver stopped: {exc}", error_code="driver_stopped",
                    )
                    logger.warning("run %s marked blocked after its driver stopped", run_id)
        except Exception:  # pragma: no cover - best effort
            logger.exception("could not mark run %s after its driver stopped", run_id)
    finally:
        with _lock:
            _driving.pop(run_id, None)


def ensure_driving(
    run_id: str, *, owner: str = "dispatcher",
    adapter_factory: Optional[Callable[[], object]] = None,
) -> bool:
    """Start driving ``run_id`` unless a driver is already on it.

    Returns whether a driver was started. Calling this on a run that has already
    parked is harmless: the loop reads the status, sees it is not runnable, and
    returns — the registry is keyed by run id precisely so the answer does not
    have to be "is this runnable?", which is a question about the database and
    therefore racy to answer twice.
    """
    if not run_id or not _enabled:
        return False
    with _lock:
        if run_id in _driving and _driving[run_id].is_alive():
            return False
        factory = adapter_factory or _default_adapter
        thread = threading.Thread(
            target=_drive, args=(run_id, owner, factory),
            name=f"pipeline-drive-{run_id}", daemon=True,
        )
        _driving[run_id] = thread
    thread.start()
    return True


def is_driving(run_id: str) -> bool:
    with _lock:
        thread = _driving.get(run_id)
    return bool(thread and thread.is_alive())


def shutdown_drivers(timeout: float = 5.0) -> None:
    """Wait for in-flight drivers, for a test teardown or a clean shutdown.

    Drivers are daemons and always joinable-by-timeout: a model turn can outlive
    any timeout this function is given, and pretending otherwise would mean
    killing a thread mid-transaction.
    """
    with _lock:
        threads = list(_driving.values())
    for thread in threads:
        thread.join(timeout=timeout)
