"""The pipeline executor (spec §7) and the runtime navigation the validator does not do.

What ``pipeline_template`` owns is the *static* question — is this graph
well-formed. This module owns the dynamic one: given a run's inputs and the
outputs of the steps that have actually completed, which step runs next, what
does it get to see, and what happens when it fails.

Three rules shape everything here.

**No transaction spans an adapter call.** ``pipelines_db`` commits before
``adapter.submit`` and commits again after. A run that is killed mid-model-call
must be recoverable by reading the database, and it cannot be if the write
that recorded "this step started" is still uncommitted when the process dies.

**A condition's data availability is re-checked here, not at import.** Spec §5
says so explicitly, and it is the case that makes a static check insufficient:
a step reachable only through a branch that was not taken has no output, and
a ``{ref}`` to it is missing data at runtime, not at import time.

**``blocked`` is not ``failed``.** ``failed`` means this run is done and it
failed. ``blocked`` means the outcome is unknown — an external call whose
result we could not establish, or infrastructure that is temporarily absent.
The difference is who is allowed to fix it: a failed run needs a new run, a
blocked one needs recovery. Collapsing them turns "we do not know what this
did" into "it did not work", which is a claim the system cannot support.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from typing import Any, Callable, Mapping, Optional, Protocol

logger = logging.getLogger(__name__)

from hermes_cli import pipeline_artifacts  # noqa: F401  (result publishing)
from hermes_cli import pipelines_db as db
from hermes_cli.pipeline_template import CONDITION_OPS

__all__ = [
    "AdapterError", "ContractError", "AccessError", "UnknownOutcome", "RefUnavailable",
    "StepAdapter", "ExecutionOutcome", "ExecutionResult",
    "resolve_refs", "evaluate_when", "select_next", "advance", "recover",
    "DEFAULT_LEASE_TTL", "TERMINAL_INPUT_ERRORS",
]

DEFAULT_LEASE_TTL = 60

# Error codes that must never be retried, per spec §7: an access error, a bad
# contract and a missing profile are not transient, and retrying them turns a
# permanent refusal into a loop. `unknown` is separate again — it is not a
# failure at all, it is the absence of one.
TERMINAL_INPUT_ERRORS = frozenset({
    "access_denied", "forbidden", "unauthorized", "contract_invalid",
    "profile_missing", "tool_missing", "input_invalid",
})


class AdapterError(RuntimeError):
    """The adapter could not carry out the call. ``error_code`` decides retryability."""

    def __init__(self, message: str, *, error_code: str = "adapter_error") -> None:
        super().__init__(message)
        self.error_code = error_code


class ContractError(AdapterError):
    """The result did not satisfy ``output_schema`` — never retried."""

    def __init__(self, message: str) -> None:
        super().__init__(message, error_code="contract_invalid")


class AccessError(AdapterError):
    """A refusal by the target — never retried."""

    def __init__(self, message: str) -> None:
        super().__init__(message, error_code="access_denied")


class UnknownOutcome(Exception):
    """The call may or may not have taken effect. Recovery, never a blind repeat.

    Distinct from ``AdapterError`` on purpose: raising this must not consume a
    retry, because the whole point is that we cannot tell whether the side
    effect happened.
    """


class RefUnavailable(Exception):
    """A ``{ref}`` named data that does not exist — the runtime availability check."""

    def __init__(self, ref: str) -> None:
        super().__init__(f"ref '{ref}' is not available")
        self.ref = ref


class StepAdapter(Protocol):
    """The logical operations spec §8 requires; the executor knows nothing else."""

    def submit(self, request: dict) -> str: ...
    def result(self, execution_id: str) -> Optional["ExecutionResult"]: ...
    def cancel(self, execution_id: str) -> bool: ...


class ExecutionResult:
    """What the adapter reports back: a payload, or a failure, or nothing yet."""

    def __init__(
        self, *, state: str, output: Optional[dict] = None,
        error: Optional[str] = None, error_code: Optional[str] = None,
        usage: Optional[dict] = None,
    ) -> None:
        self.state = state
        self.output = output
        self.error = error
        self.error_code = error_code
        # Token/cost accounting for this attempt (#58). ``None`` means the step
        # was not measured -- a cancelled turn, or an adapter that exposes no
        # counters -- and it is kept distinct from a measured zero.
        self.usage = usage

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return f"ExecutionResult(state={self.state!r}, error_code={self.error_code!r})"


# --- Conditions -------------------------------------------------------------------

def _operand(value: Any, *, inputs: Mapping[str, Any], outputs: Mapping[str, Any]) -> Any:
    return resolve_refs(value, inputs=inputs, outputs=outputs)


def _compare(op: str, left: Any, right: Any) -> bool:
    """The comparison ops, with ordering guarded rather than assumed.

    ``gt`` against a string is a type error in most languages and a crash here.
    An incomparable pair is *not* a match: silently raising would turn a
    scenario's data mistake into a failed run, and silently passing would route
    a rework branch the wrong way. Returning ``False`` keeps it a routing
    decision the scenario author can see in the log.
    """
    try:
        if op == "eq":
            return left == right
        if op == "ne":
            return left != right
        if op == "gt":
            return left > right
        if op == "gte":
            return left >= right
        if op == "lt":
            return left < right
        if op == "lte":
            return left <= right
    except TypeError:
        return False
    raise ValueError(f"unsupported comparison: {op!r}")


def evaluate_when(when: Mapping[str, Any], *, inputs: Mapping[str, Any], outputs: Mapping[str, Any]) -> bool:
    """Evaluate a condition's ``when`` against real data.

    ``all``/``any`` recurse; ``exists`` asks about presence, which is not the
    same as truthiness — a step that returned ``{"count": 0}`` exists, and
    ``exists`` on it must be ``True`` even though a naive ``if value`` would say
    otherwise.
    """
    if not isinstance(when, Mapping):
        raise ValueError("condition must be an object")
    op = when.get("op")
    if op not in CONDITION_OPS:
        raise ValueError(f"unknown condition op: {op!r}")
    if op == "all":
        return all(evaluate_when(c, inputs=inputs, outputs=outputs) for c in when.get("conditions", ()))
    if op == "any":
        return any(evaluate_when(c, inputs=inputs, outputs=outputs) for c in when.get("conditions", ()))
    if op == "exists":
        try:
            _operand(when.get("left"), inputs=inputs, outputs=outputs)
        except RefUnavailable:
            return False
        return True
    left = _operand(when.get("left"), inputs=inputs, outputs=outputs)
    right = _operand(when.get("right"), inputs=inputs, outputs=outputs)
    return _compare(op, left, right)


# --- Navigation -------------------------------------------------------------------

class NextStep:
    """Where control goes next, and why — the reason is the log's, not a guess."""

    def __init__(self, step_id: Optional[str], *, reason: str = "next",
                 rework: bool = False, fail: Optional[str] = None) -> None:
        self.step_id = step_id
        self.reason = reason
        self.rework = rework
        self.fail = fail

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return f"NextStep({self.step_id!r}, reason={self.reason!r}, rework={self.rework})"


def find_step(template: Mapping[str, Any], step_id: str) -> Optional[Mapping[str, Any]]:
    for step in template.get("steps", ()):
        if isinstance(step, Mapping) and step.get("id") == step_id:
            return step
    return None


def start_step_id(template: Mapping[str, Any]) -> Optional[str]:
    start = template.get("start_step")
    if isinstance(start, str) and start:
        return start
    steps = [s for s in template.get("steps", ()) if isinstance(s, Mapping)]
    return steps[0].get("id") if steps else None


def select_next(
    template: Mapping[str, Any], step: Mapping[str, Any], *,
    inputs: Mapping[str, Any], outputs: Mapping[str, Any],
) -> NextStep:
    """Decide what follows ``step``.

    A condition picks the first matching case, and its ``rework: true`` marker
    is what makes the return bump the rework counter — a return for rework and
    an ordinary forward transition are otherwise identical, and the difference
    is exactly what ``max_rework_cycles`` is meant to bound.
    """
    sid = step.get("id")
    if step.get("type") != "condition":
        nxt = step.get("next")
        return NextStep(nxt if isinstance(nxt, str) and nxt else None, reason="transition")

    for case in step.get("cases", ()):
        if not isinstance(case, Mapping):
            continue
        when = case.get("when")
        if not isinstance(when, Mapping):
            continue
        if evaluate_when(when, inputs=inputs, outputs=outputs):
            return NextStep(case.get("next"), reason=f"case:{sid}", rework=case.get("rework") is True)

    default = step.get("default")
    if isinstance(default, Mapping):
        if isinstance(default.get("next"), str) and default["next"]:
            return NextStep(default["next"], reason=f"default:{sid}")
        if isinstance(default.get("fail"), str) and default["fail"]:
            return NextStep(None, reason=f"default:{sid}:fail", fail=default["fail"])
    return NextStep(None, reason="condition:exhausted", fail="no case matched and no default transition")


# --- Limits -----------------------------------------------------------------------

def _limits(template: Mapping[str, Any], step: Mapping[str, Any]) -> tuple[int, int, Optional[int]]:
    """``(max_rework_cycles, retry_max_attempts, max_step_executions)``.

    Spec §7: the three counters are independent. ``max_rework_cycles=3`` allows
    three returns for rework; ``retry.max_attempts=2`` is the first call plus
    one technical retry; ``max_step_executions`` caps total activations
    including conditions, and technical retries count against the retry limit
    instead. Reading them from three different places in one function is the
    only way to keep that true when a scenario changes one of them.
    """
    limits = template.get("limits") if isinstance(template.get("limits"), Mapping) else {}
    # `retry` is a STEP property in the schema, not a member of `limits` —
    # reading it from `limits` found nothing and silently used the default, so
    # a scenario asking for one attempt would still get two.
    retry = step.get("retry") if isinstance(step.get("retry"), Mapping) else {}
    max_rework = limits.get("max_rework_cycles")
    max_attempts = retry.get("max_attempts")
    max_exec = limits.get("max_step_executions")
    return (
        int(max_rework) if isinstance(max_rework, int) else 3,
        int(max_attempts) if isinstance(max_attempts, int) else 2,
        int(max_exec) if isinstance(max_exec, int) else None,
    )


# --- The loop ---------------------------------------------------------------------

class _AdvanceResult:
    def __init__(self, status: str, detail: str = "", *, step_id: Optional[str] = None) -> None:
        self.status = status
        self.detail = detail
        self.step_id = step_id

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return f"_AdvanceResult({self.status!r}, {self.detail!r})"


def _outputs_for(conn: sqlite3.Connection, run_id: str) -> dict[str, Any]:
    """step id -> its completed output, for ref resolution.

    Built from completed attempts only. An attempt that failed or came back
    ``unknown`` contributes nothing: a ref to a step whose result is not known
    must be missing data, not a previous success from an earlier iteration.
    """
    outputs: dict[str, Any] = {}
    for attempt in db.list_attempts(conn, run_id):
        if attempt.status == "completed" and attempt.output is not None:
            # Nested under "output" because a ref reads
            # ``steps.<id>.output.<field>`` (spec §5). Storing the output flat
            # made every ``.output.`` ref unresolvable — and the failure looked
            # like missing data rather than a namespace mistake, so it failed
            # the run as `ref_unavailable`.
            outputs[attempt.step_id] = {"output": attempt.output}
    return outputs


def _pending_attempt(conn: sqlite3.Connection, run_id: str, step_id: str) -> Optional[db.StepAttempt]:
    """The attempt for ``step_id`` that still owes a result, if any.

    A technical retry is a new attempt for the SAME step, so the newest
    non-terminal one is the one the loop owes work on.
    """
    live = [a for a in db.list_attempts(conn, run_id) if a.step_id == step_id and a.status in ("queued", "running")]
    return live[-1] if live else None


def advance(
    conn: sqlite3.Connection, run_id: str, adapter: "StepAdapter", *, owner: str,
    lease_ttl: int = DEFAULT_LEASE_TTL, now: Optional[int] = None,
) -> _AdvanceResult:
    """Drive one run one step, then stop. Never holds a transaction across the call.

    Returns a result describing what happened rather than raising for ordinary
    outcomes: a run that is waiting for a human, finished, or blocked has not
    thrown, and the caller needs to say so differently in each case.
    """
    # `waiting_input` is a status a run can still make progress from, not a
    # resting state: once the request is answered, this call is what consumes
    # the answer and moves on. Leaving it out made that path unreachable — the
    # run accepted a response and then refused every attempt to continue.
    run = db.require_active_run_status(conn, run_id, "queued", "running", "waiting_input")
    template = run.template_snapshot or {}
    if not isinstance(template, Mapping):
        raise ValueError(f"run {run_id} has no template snapshot")

    step_id = run.current_step_id or start_step_id(template)
    if not step_id:
        db.finish_run(conn, run_id, "completed", result=run.result or {})
        return _AdvanceResult("completed", "no steps")
    step = find_step(template, step_id)
    if step is None:
        db.finish_run(conn, run_id, "failed", error=f"step '{step_id}' is not in the snapshot",
                      error_code="template_invalid")
        return _AdvanceResult("failed", f"unknown step {step_id}")

    max_rework, max_attempts, max_exec = _limits(template, step)

    if run.status == "queued":
        db.set_run_status(conn, run_id, "running", payload={"step_id": step_id})

    # A cap on total activations, counted across every step including
    # conditions. Checked before doing work so the run stops rather than
    # starting an activation it would immediately have to abandon.
    if max_exec is not None and run.step_executions >= max_exec:
        db.finish_run(conn, run_id, "failed",
                      error=f"max_step_executions ({max_exec}) reached", error_code="step_executions_exhausted")
        return _AdvanceResult("failed", "max_step_executions")

    step_type = step.get("type")
    if step_type == "condition":
        return _run_condition(conn, run_id, template, step, inputs=run.inputs or {},
                              outputs=_outputs_for(conn, run_id), max_rework=max_rework)
    if step_type == "user_input":
        return _run_user_input(conn, run_id, step, owner=owner, lease_ttl=lease_ttl, now=now)
    if step_type == "delay":
        return _run_delay(conn, run_id, template, step, now=now, owner=owner)
    return _run_model_step(conn, run_id, template, step, adapter, owner=owner,
                          lease_ttl=lease_ttl, max_attempts=max_attempts, now=now)


def _run_delay(conn, run_id, template, step, *, now: int, owner=None) -> _AdvanceResult:
    """Spend wall-clock time without spending a model call or a tool.

    A delay is an activation like any other, so it counts against the run's
    step budget -- otherwise a delay loop would be the one step type that could
    run forever. It records no usage at all: nothing was consumed, and a step
    that reports zero because it did nothing would be indistinguishable from a
    free tool that did.
    """
    db.bump_step_executions(conn, run_id)
    seconds = step.get("seconds")
    try:
        seconds = int(seconds)
    except (TypeError, ValueError):
        seconds = 0
    seconds = max(0, min(300, seconds))
    if seconds:
        # Small waits in slices, so a stop request or a deadline is noticed
        # between them instead of after the whole wait.
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            time.sleep(min(0.25, deadline - time.monotonic()))
    db.append_event(conn, run_id, "step.completed", step_id=step.get("id"),
                    payload={"type": "delay", "seconds": seconds, "status": "completed"})
    return _route_on(conn, run_id, template, step, now=now, owner=owner)


def _run_condition(conn, run_id, template, step, *, inputs, outputs, max_rework) -> _AdvanceResult:
    # A condition is an activation: it consumes budget, and counting it only
    # when it produced an attempt would let a condition loop run unbounded.
    db.bump_step_executions(conn, run_id)
    decision = select_next(template, step, inputs=inputs, outputs=outputs)
    db.append_event(conn, run_id, "step.transition", step_id=step.get("id"),
                    payload={"reason": decision.reason, "next": decision.step_id, "rework": decision.rework})
    if decision.rework:
        cycles = db.bump_rework_cycles(conn, run_id)
        if cycles > max_rework:
            db.finish_run(conn, run_id, "failed",
                          error=f"max_rework_cycles ({max_rework}) reached", error_code="rework_exhausted")
            return _AdvanceResult("failed", "max_rework_cycles", step_id=step.get("id"))
    if decision.fail:
        db.finish_run(conn, run_id, "failed", error=decision.fail, error_code="condition_default_fail")
        return _AdvanceResult("failed", "condition default fail", step_id=step.get("id"))
    if not decision.step_id:
        db.finish_run(conn, run_id, "completed", result=dict(outputs))
        return _AdvanceResult("completed", "condition fell through", step_id=step.get("id"))
    db.set_run_scheduling(conn, run_id, current_step_id=decision.step_id)
    return _AdvanceResult("advanced", decision.reason, step_id=step.get("id"))


def _run_user_input(conn, run_id, step, *, owner, lease_ttl, now) -> _AdvanceResult:
    """Open an InputRequest and hand the run to the human. No model call, no worker.

    Spec §7: waiting for a person must not occupy a worker or start periodic
    model calls, so this state is recorded and the loop simply stops. The
    attempt is left in ``waiting_input`` rather than finished, which is what
    makes the run resumable when the answer lands.
    """
    step_id = step.get("id")
    # Unlike an agent step, a `waiting_input` attempt is NOT superseded here: it
    # is the carrier of the open request, so replacing it would orphan the
    # answer. `_pending_attempt` deliberately excludes it (a technical retry
    # should be a new attempt), which is right for agents and wrong for this
    # step — hence the explicit live set rather than a change to that helper.
    parked = [a for a in db.list_attempts(conn, run_id)
              if a.step_id == step_id and a.status in ("queued", "running", "waiting_input")]
    attempt = parked[-1] if parked else None
    if attempt is None:
        attempt_id = db.create_attempt(conn, run_id, step_id, input_snapshot=step.get("prompt"))
        attempt = db.get_attempt(conn, attempt_id)
        assert attempt is not None

    # Scoped to the attempt, not the step: a rework return gives this step a
    # fresh attempt, and that attempt must ask again. Filtering by step_id made
    # the new attempt inherit the previous iteration's answer, so a rejected
    # review was silently "answered" by the refusal that triggered the rework,
    # and the run looped until it hit max_step_executions.
    existing = [r for r in db.list_input_requests(conn, run_id)
                if r.attempt_id == attempt.id and r.status in ("open", "answered")]
    if existing:
        # Already waiting, or answered but not yet consumed — do not open a
        # second request for the same step.
        if any(r.status == "answered" for r in existing):
            return _consume_input_answer(conn, run_id, step, attempt, lease_ttl=lease_ttl, now=now)
        return _AdvanceResult("waiting_input", "request already open", step_id=step_id)

    with db.write_txn(conn):
        conn.execute("UPDATE step_attempts SET status = 'waiting_input' WHERE id = ?", (attempt.id,))
    wait_timeout = step.get("wait_timeout_seconds")
    db.open_input_request(
        conn, run_id, step_id, attempt.id,
        prompt=str(step.get("prompt", "")),
        response_schema=step.get("response_schema"),
        chat=step.get("chat"),
        wait_timeout_seconds=wait_timeout,
    )
    # A wait timeout is stored as a deadline, not enforced by a running timer:
    # the worker is released here, so nothing would be around to fire it.
    # `null` means no deadline at all rather than "expire immediately".
    deadline = None
    if isinstance(wait_timeout, int) and wait_timeout > 0:
        deadline = (now if now is not None else int(time.time())) + wait_timeout
    db.set_run_scheduling(conn, run_id, deadline=deadline, current_step_id=step_id)
    db.set_run_status(conn, run_id, "waiting_input", payload={"step_id": step_id, "attempt_id": attempt.id})
    return _AdvanceResult("waiting_input", "request opened", step_id=step_id)


def _consume_input_answer(conn, run_id, step, attempt, *, lease_ttl, now) -> _AdvanceResult:
    """Take the accepted answer as the step's output and move on."""
    # Attempt-scoped for the same reason as `_run_user_input`'s `existing`: an
    # answer belongs to the attempt that asked for it.
    answered = [r for r in db.list_input_requests(conn, run_id)
                if r.attempt_id == attempt.id and r.status == "answered"]
    response = answered[-1].accepted_response if answered else None
    if not db.claim_attempt(conn, attempt.id, "executor:consume", ttl_seconds=lease_ttl, now=now):
        return _AdvanceResult("contended", "lease held elsewhere", step_id=attempt.step_id)
    try:
        db.finish_attempt(conn, attempt.id, "completed", output=response if isinstance(response, dict) else {})
        nxt = step.get("next")
        if isinstance(nxt, str) and nxt:
            db.set_run_scheduling(conn, run_id, current_step_id=nxt)
            return _AdvanceResult("advanced", "input answered", step_id=attempt.step_id)
        db.set_run_result(conn, run_id, response if isinstance(response, dict) else {})
        db.finish_run(conn, run_id, "completed")
        return _AdvanceResult("completed", "final step answered", step_id=attempt.step_id)
    finally:
        db.release_attempt(conn, attempt.id, "executor:consume")


def _adopt_result(conn, run_id, attempt, result, *, owner) -> _AdvanceResult:
    """Land a finished adapter result and route on.

    One implementation for both callers: `recover` after a restart, and the live
    driver collecting the turn it is still waiting for. Two copies of this is how
    a submit path and a collect path end up disagreeing about what "completed"
    means.
    """
    run_after = db.get_run(conn, run_id)
    template = run_after.template_snapshot if run_after else {}
    db.finish_attempt(conn, attempt.id, "completed", output=result.output or {})
    _record_usage(conn, run_id, attempt, result)
    if isinstance(template, Mapping) and find_step(template, attempt.step_id) is not None:
        return _record_success(conn, run_id, template, find_step(template, attempt.step_id),
                               attempt, result.output or {}, owner=owner)
    return _AdvanceResult("completed", "adopted adapter result", step_id=attempt.step_id)


def _record_usage(conn, run_id, attempt, result) -> None:
    """Persist this attempt's consumption (#58).

    A step that produced no measurement still gets a row, marked unknown. A
    missing row and a measured zero are different facts, and a report that
    cannot tell them apart is the thing this whole slice exists to prevent.
    """
    from hermes_cli import pipeline_usage as usage_module

    delta = getattr(result, "usage", None)
    kind = (delta or {}).get("kind", "model")
    if kind == "tool":
        # A tool step is recorded, never dropped: a DOCX export has no tokens
        # but it ran, and a cost report that omits it cannot be read as a total.
        # ``None`` here is "the tool did not say", not "the tool was free".
        record = usage_module.Usage(
            step_id=attempt.step_id, kind="tool",
            tool_cost_micros=delta.get("tool_cost_micros"),
        )
    else:
        record = usage_module.Usage(
            step_id=attempt.step_id, kind="model",
            input_tokens=(delta or {}).get("input"),
            cached_input=(delta or {}).get("cache_read"),
            output_tokens=(delta or {}).get("output"),
        )
    try:
        usage_module.price_and_record(
            conn, run_id=run_id, attempt_id=attempt.id, usage=record,
        )
    except Exception:
        # Accounting must never fail a run that otherwise succeeded. A missing
        # cost is a reporting gap; a lost artifact is a lost result.
        logger.warning("could not record usage for %s", attempt.id, exc_info=True)


def _run_model_step(conn, run_id, template, step, adapter, *, owner, lease_ttl, max_attempts, now) -> _AdvanceResult:
    """One activation of an ``agent`` or ``tool`` step: resolve, submit, record, route.

    The transaction boundaries are the point of this function. The lease is
    taken and the attempt recorded, the connection is released, and only then is
    the adapter called — so a process killed mid-call leaves behind a ``running``
    attempt that ``recover`` can reconcile rather than an uncommitted one.
    """
    step_id = step.get("id")
    inputs = (db.get_run(conn, run_id).inputs) or {}
    outputs = _outputs_for(conn, run_id)

    attempt = _pending_attempt(conn, run_id, step_id)
    if attempt is None:
        attempt_id = db.create_attempt(
            conn, run_id, step_id, input_snapshot=step.get("input"),
            idempotency_key=f"{run_id}:{step_id}",
        )
        attempt = db.get_attempt(conn, attempt_id)
        assert attempt is not None
    if attempt.attempt_no > max_attempts:
        db.finish_attempt(conn, attempt.id, "failed", error="retry limit reached",
                          error_code="retry_exhausted")
        db.finish_run(conn, run_id, "failed",
                      error=f"retry.max_attempts ({max_attempts}) reached", error_code="retry_exhausted")
        return _AdvanceResult("failed", "retry_exhausted", step_id=step_id)

    # Contention first: a lease held by *someone else* is the more specific and
    # more actionable answer, and it is the existing contract.
    if not db.claim_attempt(conn, attempt.id, owner, ttl_seconds=lease_ttl, now=now):
        return _AdvanceResult("contended", "another dispatcher holds the lease", step_id=step_id)

    # Then the case the lease cannot catch. An attempt that already carries an
    # execution_id has been submitted and its result has not been collected yet.
    # The lease does not stop a re-submit, because re-claiming a lease you already
    # hold deliberately succeeds — it is what lets a dispatcher resume after
    # losing its own connection. So the same owner could submit the same attempt
    # again, starting a SECOND Hermes turn for it on the same session: two turns
    # interleave on one session, the transcript interleaves with them, and the
    # step never completes. Reclaiming is for a DEAD owner whose lease expired; a
    # live in-flight attempt is not reclaimable, and `recover` is the path that
    # reconciles one found after a restart.
    if attempt.execution_id:
        # Submitted already. If the answer is here, take it — refusing to would
        # leave a finished turn uncollected for ever, because `advance` is the
        # only thing the live driver calls and `recover` is a restart path. This
        # is the same adoption `recover` uses, not a second state machine.
        try:
            pending = adapter.result(attempt.execution_id)
        except Exception as exc:  # an unreachable adapter is an unknown outcome
            db.finish_attempt(conn, attempt.id, "unknown", error=str(exc), error_code="unknown")
            db.set_run_status(conn, run_id, "blocked", error=str(exc), error_code="unknown")
            return _AdvanceResult("blocked", str(exc), step_id=step_id)
        if pending is None:
            return _AdvanceResult("in_flight", "attempt already submitted", step_id=step_id)
        if pending.state == "completed":
            return _adopt_result(conn, run_id, attempt, pending, owner=owner)
        if pending.state == "cancelled":
            db.finish_attempt(conn, attempt.id, "cancelled", error=pending.error,
                              error_code=pending.error_code or "cancelled")
            return _AdvanceResult("cancelled", "attempt cancelled", step_id=step_id)
        code = pending.error_code or "adapter_error"
        return _record_failure(conn, run_id, attempt, step, pending, max_attempts=max_attempts)

    try:
        try:
            resolved_input = resolve_refs(step.get("input", {}), inputs=inputs, outputs=outputs)
        except RefUnavailable as exc:
            # Missing data under a conditional branch is a run-level failure,
            # not a retryable step error: retrying cannot conjure the output.
            db.finish_attempt(conn, attempt.id, "failed", error=str(exc), error_code="ref_unavailable")
            db.finish_run(conn, run_id, "failed", error=str(exc), error_code="ref_unavailable")
            return _AdvanceResult("failed", str(exc), step_id=step_id)

        request = {
            "run_id": run_id, "step_id": step_id, "attempt_id": attempt.id,
            "profile": step.get("profile"), "type": step.get("type"),
            # The tool id is what makes a `tool` step a tool step; the request
            # carried only `type`, so the adapter had nothing to dispatch.
            "tool": step.get("tool"),
            "instruction": step.get("instruction"), "input": resolved_input,
            "output_schema": step.get("output_schema"),
            "idempotency_key": attempt.idempotency_key,
        }

        # --- no transaction open from here to the adapter call and back ---
        try:
            execution_id = adapter.submit(request)
        except UnknownOutcome as exc:
            db.finish_attempt(conn, attempt.id, "unknown", error=str(exc), error_code="unknown")
            db.set_run_status(conn, run_id, "blocked", error=str(exc), error_code="unknown")
            return _AdvanceResult("blocked", str(exc), step_id=step_id)
        except AdapterError as exc:
            return _record_failure(conn, run_id, attempt, step, exc, max_attempts=max_attempts)

        db.start_attempt(conn, attempt.id, execution_id=execution_id, occurred_at=now)
        result = adapter.result(execution_id)
        if result is None or result.state in ("queued", "running", "pending"):
            return _AdvanceResult("in_flight", "adapter has not finished", step_id=step_id)
        if result.state == "unknown":
            db.finish_attempt(conn, attempt.id, "unknown", error=result.error, error_code="unknown")
            db.set_run_status(conn, run_id, "blocked", error=result.error, error_code="unknown")
            return _AdvanceResult("blocked", result.error or "unknown outcome", step_id=step_id)
        if result.state == "failed" or result.error:
            return _record_failure(
                conn, run_id, attempt, step,
                AdapterError(result.error or "adapter reported failure",
                             error_code=result.error_code or "adapter_error"),
                max_attempts=max_attempts,
            )
        # --- transaction closed again ---
        return _record_success(conn, run_id, template, step, attempt, result.output, now=now,
                              owner=owner)
    finally:
        db.release_attempt(conn, attempt.id, owner)


def _record_failure(conn, run_id, attempt, step, exc: AdapterError, *, max_attempts) -> _AdvanceResult:
    """Fail or retry an attempt, honouring the one class of error never retried."""
    code = getattr(exc, "error_code", "adapter_error")
    retryable = code not in TERMINAL_INPUT_ERRORS
    if retryable and attempt.attempt_no < max_attempts:
        retry_id = db.create_attempt(
            conn, run_id, attempt.step_id, iteration=attempt.iteration,
            attempt_no=attempt.attempt_no + 1, input_snapshot=attempt.input_snapshot,
            idempotency_key=attempt.idempotency_key,
        )
        db.finish_attempt(conn, attempt.id, "failed", error=str(exc), error_code=code)
        db.append_event(conn, run_id, "step.retry", step_id=attempt.step_id,
                        attempt_id=retry_id,
                        payload={"after_attempt": attempt.attempt_no, "error_code": code})
        return _AdvanceResult("retrying", f"{code} -> attempt {attempt.attempt_no + 1}", step_id=attempt.step_id)
    db.finish_attempt(conn, attempt.id, "failed", error=str(exc), error_code=code)
    db.finish_run(conn, run_id, "failed", error=str(exc), error_code=code)
    return _AdvanceResult("failed", code, step_id=attempt.step_id)


def _record_success(conn, run_id, template, step, attempt, output, *, now=None,
                   owner=None) -> _AdvanceResult:
    """Land a completed step and route on, in as few transactions as possible."""
    db.finish_attempt(conn, attempt.id, "completed",
                      output=output if isinstance(output, dict) else {}, occurred_at=now)
    return _route_on(conn, run_id, template, step, now=now, owner=owner,
                     attempt_id=attempt.id)


def _route_on(conn, run_id, template, step, *, now=None, owner=None,
              attempt_id=None) -> _AdvanceResult:
    """Decide what a finished step leads to, and write that down.

    Shared by every step type so a `delay` routes exactly like an agent step:
    transitions, rework budget, declared results and completion are one set of
    rules, not one rule for real steps and a reimplementation for the others.
    """
    outputs = _outputs_for(conn, run_id)
    inputs = (db.get_run(conn, run_id).inputs) or {}
    decision = select_next(template, step, inputs=inputs, outputs=outputs)
    db.append_event(conn, run_id, "step.transition", step_id=step.get("id"), attempt_id=attempt_id,
                    payload={"reason": decision.reason, "next": decision.step_id, "rework": decision.rework})
    max_rework, _max_attempts, _max_exec = _limits(template, step)
    if decision.rework:
        cycles = db.bump_rework_cycles(conn, run_id)
        if cycles > max_rework:
            db.finish_run(conn, run_id, "failed",
                          error=f"max_rework_cycles ({max_rework}) reached", error_code="rework_exhausted")
            return _AdvanceResult("failed", "max_rework_cycles", step_id=step.get("id"))
    if decision.fail:
        db.finish_run(conn, run_id, "failed", error=decision.fail, error_code="condition_default_fail")
        return _AdvanceResult("failed", "condition default fail", step_id=step.get("id"))
    if not decision.step_id:
        # A declared `result` (spec §7) is what the run *delivers*; publishing it
        # is what makes a completed run downloadable. Undeclared templates keep
        # the full output map they have always returned.
        result = pipeline_artifacts.resolve_declared_result(
            conn, run_id, template, inputs, outputs, owner=owner, resolve_refs=resolve_refs,
        )
        if result is None:
            result = outputs
        db.set_run_result(conn, run_id, result)
        db.finish_run(conn, run_id, "completed", result=result, occurred_at=now)
        return _AdvanceResult("completed", "run finished", step_id=step.get("id"))
    db.set_run_scheduling(conn, run_id, current_step_id=decision.step_id)
    return _AdvanceResult("advanced", decision.reason, step_id=step.get("id"))


# --- Restart recovery -------------------------------------------------------------

def recover(conn: sqlite3.Connection, adapter: "StepAdapter", *, owner: str,
            run_ids: Optional[list[str]] = None) -> list[_AdvanceResult]:
    """Reconcile runs left mid-flight by a restart (spec §7).

    ``queued`` and ``waiting_input`` are simply picked back up. A ``running``
    step is different: its attempt names an ``execution_id``, and the only safe
    move is to ask the adapter what happened to it. If the adapter still knows,
    the result is recorded; if it does not, the attempt becomes ``unknown`` and
    the run becomes ``blocked``.

    The alternative — resubmitting — is exactly what the spec forbids. The call
    may have had side effects, and we have no evidence either way, so the
    honest answer is "unknown", not "probably fine".
    """
    targets = run_ids
    if targets is None:
        targets = [r.id for r in db.list_runs(conn, status="running")]
    results: list[_AdvanceResult] = []
    for run_id in targets:
        run = db.get_run(conn, run_id)
        if run is None or run.status not in ("running", "queued"):
            continue
        if run.status == "queued":
            results.append(_AdvanceResult("resumed", "queued run picked up", step_id=run.current_step_id))
            continue
        running = [a for a in db.list_attempts(conn, run_id) if a.status == "running"]
        if not running:
            results.append(_AdvanceResult("resumed", "no running attempt", step_id=run.current_step_id))
            continue
        for attempt in running:
            if not attempt.execution_id:
                db.finish_attempt(conn, attempt.id, "unknown",
                                  error="running attempt has no execution_id to reconcile",
                                  error_code="unknown")
                db.set_run_status(conn, run_id, "blocked",
                                  error=f"attempt {attempt.id} has no execution_id", error_code="unknown")
                results.append(_AdvanceResult("blocked", "no execution_id", step_id=attempt.step_id))
                continue
            try:
                result = adapter.result(attempt.execution_id)
            except Exception as exc:  # adapter unreachable is itself an unknown outcome
                db.finish_attempt(conn, attempt.id, "unknown", error=str(exc), error_code="unknown")
                db.set_run_status(conn, run_id, "blocked", error=str(exc), error_code="unknown")
                results.append(_AdvanceResult("blocked", str(exc), step_id=attempt.step_id))
                continue
            if result is None:
                db.finish_attempt(conn, attempt.id, "unknown",
                                  error="adapter no longer knows this execution", error_code="unknown")
                db.set_run_status(conn, run_id, "blocked",
                                  error="adapter no longer knows this execution", error_code="unknown")
                results.append(_AdvanceResult("blocked", "adapter forgot the execution", step_id=attempt.step_id))
                continue
            if result.state in ("completed",):
                results.append(_adopt_result(conn, run_id, attempt, result, owner=owner))
                continue
            if result.state == "failed" or result.error:
                code = result.error_code or "adapter_error"
                db.finish_attempt(conn, attempt.id, "failed", error=result.error, error_code=code)
                db.finish_run(conn, run_id, "failed", error=result.error, error_code=code)
                results.append(_AdvanceResult("failed", code, step_id=attempt.step_id))
                continue
            db.finish_attempt(conn, attempt.id, "unknown",
                              error=f"adapter reports '{result.state}'", error_code="unknown")
            db.set_run_status(conn, run_id, "blocked",
                              error=f"adapter reports '{result.state}'", error_code="unknown")
            results.append(_AdvanceResult("blocked", f"adapter state {result.state!r}", step_id=attempt.step_id))
    return results


# --- Ref resolution ---------------------------------------------------------------

_MISSING = object()


def _lookup(root: Any, parts: list[str]) -> Any:
    """Walk a dotted path, returning ``_MISSING`` rather than raising.

    A ref that names a step which was never reached must be distinguishable
    from a ref that names a step which returned null — the first is missing
    data, the second is data.
    """
    cur = root
    for part in parts:
        if isinstance(cur, Mapping):
            if part not in cur:
                return _MISSING
            cur = cur[part]
        elif isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return _MISSING
        else:
            return _MISSING
    return cur


def resolve_refs(value: Any, *, inputs: Mapping[str, Any], outputs: Mapping[str, Any]) -> Any:
    """Substitute every ``{"ref": ...}`` in ``value``.

    ``outputs`` maps step id -> that step's output object. Spec §5: data
    availability under conditional branches is re-checked at execution, so an
    unavailable ref raises :class:`RefUnavailable` here rather than being
    silently filled with a default. ``optional: true`` with a ``default`` is the
    only way to say "it may be absent, and use this instead".
    """
    if isinstance(value, Mapping):
        if isinstance(value.get("ref"), str):
            return _resolve_one(value, inputs=inputs, outputs=outputs)
        return {k: resolve_refs(v, inputs=inputs, outputs=outputs) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve_refs(v, inputs=inputs, outputs=outputs) for v in value]
    return value


def _resolve_one(spec: Mapping[str, Any], *, inputs: Mapping[str, Any], outputs: Mapping[str, Any]) -> Any:
    ref = spec["ref"].strip()
    parts = [p for p in ref.split(".") if p]
    if len(parts) < 2 or parts[0] not in ("inputs", "steps"):
        raise RefUnavailable(ref)
    if parts[0] == "inputs":
        found = _lookup(inputs, parts[1:])
    else:
        step_id = parts[1]
        # A step that exists but was skipped by a condition is the case the
        # spec singles out; so is a step that has not run yet.
        if step_id not in outputs:
            found = _MISSING
        else:
            found = _lookup(outputs[step_id], parts[2:])
    if found is _MISSING:
        if spec.get("optional") is True and "default" in spec:
            return spec["default"]
        raise RefUnavailable(ref)
    return found
