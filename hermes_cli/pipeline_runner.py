"""The run loop: the consumer :func:`~hermes_cli.pipeline_executor.advance` never had (spec §8, #34).

``advance()`` moves a run **one step** and stops. That is the right shape for a
function that must not hold a lease across a model call, but it means somebody
has to call it again. Until this module existed, nobody did: the executor and
both adapters were correct and unreachable.

## Why the loop stops where it stops

A run parks, it does not fail, in four situations: it is waiting for a human,
it is on review, it is blocked because the outcome of an external call is
unknown, or it finished. All four are *ordinary outcomes, not exceptions*
(``advance()`` returns them rather than raising), and a loop that treated them
as "keep going" would either spin against a human who is not there yet or
hammer a step whose outcome cannot be established. So the loop stops, and says
why.

## It also stops when nothing moved

:data:`_NO_PROGRESS_LIMIT` guards the failure mode a naive loop has: a step
that reports success without advancing leaves ``current_step_id`` where it was,
and calling ``advance()`` again re-submits the same work. Paying for the same
model turn twice because a status comparison was wrong is not a bug to debug
afterwards, it is a bill somebody receives.

The bound is a backstop, not the mechanism — ``max_steps`` is the declared
ceiling and this is the belt.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional

from hermes_cli.pipeline_executor import (
    DEFAULT_LEASE_TTL,
    StepAdapter,
    advance,
)

__all__ = ["DriveReport", "drive_run", "PARKING_STATUSES", "build_default_adapter"]

#: Run statuses that mean "stop, and a person or a later tick is needed".
#: ``waiting_input`` is here rather than in the progress set deliberately — the
#: executor can consume an answered request, but only once an answer exists.
PARKING_STATUSES = frozenset({
    "waiting_input", "blocked", "failed", "completed", "cancelled", "on_review",
})

#: Consecutive advances that changed neither the step nor the status before the
#: loop decides it is going in circles.
_NO_PROGRESS_LIMIT = 3


@dataclass
class DriveReport:
    """What the loop did, and why it stopped. Answered, not raised."""

    run_id: str
    status: str
    step_id: Optional[str] = None
    steps: int = 0
    stop_reason: str = ""
    details: List[str] = field(default_factory=list)

    @property
    def parked(self) -> bool:
        """True when the run is waiting on something outside this loop."""
        return self.status in PARKING_STATUSES

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return f"DriveReport(status={self.status!r}, steps={self.steps}, stop_reason={self.stop_reason!r})"


def _current_status(conn: sqlite3.Connection, run_id: str) -> Optional[str]:
    run = db_get_run(conn, run_id)
    return getattr(run, "status", None)


def _run_snapshot(conn: sqlite3.Connection, run_id: str) -> tuple[Optional[str], Optional[str]]:
    run = db_get_run(conn, run_id)
    if run is None:
        return None, None
    return getattr(run, "status", None), getattr(run, "current_step_id", None)


def db_get_run(conn: sqlite3.Connection, run_id: str) -> Any:
    from hermes_cli import pipelines_db as db

    return db.get_run(conn, run_id)


def _await_in_flight(conn, run_id, adapter, *, timeout: float, now=None, poll: float = 0.5) -> bool:
    """Wait for the submitted turn to land. ``True`` if it did.

    Polls the adapter rather than the database: the adapter owns the execution
    and is the only thing that knows the answer. A ``None`` result means "still
    running" — and, per the adapter's own contract, also "this process never made
    that execution", which is the restart case `recover` exists for. Treating the
    two identically here is deliberate: the bounded wait gives up either way and
    the run's own state stays the record.
    """
    from hermes_cli import pipelines_db as db

    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        run = db.get_run(conn, run_id)
        if run is None or run.current_step_id is None:
            return True
        live = [a for a in db.list_attempts(conn, run_id)
                if a.step_id == run.current_step_id and a.status in ("running", "queued", "waiting_input")]
        if not live or not live[-1].execution_id:
            return True
        try:
            result = adapter.result(live[-1].execution_id)
        except Exception:  # an unreachable adapter is an unknown outcome, not a crash
            return False
        if result is not None:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(poll)


def drive_run(
    conn: sqlite3.Connection,
    run_id: str,
    adapter: StepAdapter,
    *,
    owner: str,
    in_flight_timeout: float = 900.0,
    lease_ttl: int = DEFAULT_LEASE_TTL,
    max_steps: int = 64,
    adapter_factory: Optional[Callable[[], StepAdapter]] = None,
    now: Optional[int] = None,
    on_advance: Optional[Callable[[str], None]] = None,
) -> DriveReport:
    """Drive one run until it parks, and report where it stopped.

    ``max_steps`` is a declared ceiling, not a policy: a template with a
    condition branch can legitimately take many steps, and refusing to run it
    would be a policy nobody asked for. It exists so a template that *cannot*
    terminate ends loudly instead of quietly.

    ``adapter_factory`` exists for the case where the adapter holds per-attempt
    state and should be rebuilt for the process rather than shared across two
    runs; pass it and the loop will ask for a fresh adapter on the first tick.
    """
    if adapter_factory is not None:
        adapter = adapter_factory()
    report = DriveReport(run_id=run_id, status="unknown")
    previous: Optional[tuple[Optional[str], Optional[str]]] = None
    stalled = 0

    for _ in range(max_steps):
        try:
            outcome = advance(conn, run_id, adapter, owner=owner, lease_ttl=lease_ttl, now=now)
        except ValueError:
            # Somebody stopped the run between the check and the call. That is
            # an outcome, not a crash: a runner that dies on a cancelled run
            # takes the dispatcher with it and reports a failure nobody caused.
            status = _current_status(conn, run_id)
            if status == "cancelled":
                report.status = "cancelled"
                report.stop_reason = "cancelled by another caller"
                return report
            raise
        report.steps += 1
        report.status = outcome.status
        report.step_id = outcome.step_id or report.step_id
        if outcome.detail:
            report.details.append(outcome.detail)

        # Told after every advance so the board can follow the run as it goes.
        # Without it a card jumps once from where it was born to where it
        # finished, and a long run is indistinguishable from a stalled one -- the
        # one thing a board exists to tell apart. Never fatal: a watcher that
        # fails must not stop the work it is watching.
        if on_advance is not None:
            try:
                on_advance(run_id)
            except Exception:  # pragma: no cover - observation must not steer
                logger.exception("on_advance hook failed for run %s", run_id)

        if outcome.status in PARKING_STATUSES:
            report.stop_reason = f"parked: {outcome.status}"
            return report

        if outcome.status == "in_flight":
            # The turn is already submitted and its answer is not here yet. This
            # driver owns the run, so it waits for the answer rather than
            # returning: nothing else would collect it, and a run whose driver
            # exits mid-turn is a run that stops forever with a `running`
            # attempt nobody will ever read. Bounded, because a provider that
            # never answers must not pin a thread for ever — the attempt stays
            # `running` and `recover` is the path for it.
            if not _await_in_flight(conn, run_id, adapter, timeout=in_flight_timeout, now=now):
                report.stop_reason = "in flight, not collected"
                return report
            continue

        snapshot = _run_snapshot(conn, run_id)
        if snapshot == previous:
            stalled += 1
            if stalled >= _NO_PROGRESS_LIMIT:
                # A step that reports success without moving is cheaper to stop
                # on than to keep paying for.
                report.stop_reason = (
                    f"stopped after {stalled} advances that changed neither the step "
                    f"nor the status (still on {snapshot[1]!r})"
                )
                return report
        else:
            stalled = 0
            previous = snapshot

    report.stop_reason = f"stopped at the declared ceiling of {max_steps} steps"
    return report


def build_default_adapter(**kwargs: Any) -> StepAdapter:
    """The adapter production uses: the real one.

    Named rather than inlined so a caller that wants the fake for a scenario
    passes it in, and there is exactly one place that decides which is real.
    """
    from hermes_cli.pipeline_hermes_adapter import HermesStepAdapter

    return HermesStepAdapter(**kwargs)