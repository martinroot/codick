"""Dispatching a routed task, and writing the result back (#56)

Routing decided *where* a delivery goes. This module starts the work and
reports what came of it, with three properties that each fix a specific way an
operations layer goes quietly wrong.

## Dispatch is idempotent, and the identity is the delivery's

A platform retries. Webhooks repeat. A user re-saves. Each retry carries the
same ``(platform, external_id)``, and dispatching it twice would start two runs
for one task and pay for both. So dispatch is keyed on the delivery identity and
returns the **existing** run rather than a new one.

## Enrichment is recorded, not inferred

The routed profile and project travel into the run's inputs, and the decision
that produced them is attached. A run whose inputs cannot be explained is a run
nobody can debug, and the enrichment is the first thing anyone asks about.

## Writeback is the same record the UI reads

State, questions and artifacts go back onto the task, each with the correlation
id, and each idempotent. A question written twice shows the user the same
question twice; an artifact recorded twice shows two downloads of one file.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Dict, List, Optional

from hermes_cli import pipelines_db
from hermes_cli import task_ingress as ingress
from hermes_cli import task_routing as routing

# Task states. Kept as constants because a typo in a state string is a delivery
# that stops being visible without anything reporting an error.
STATE_DISPATCHING = "dispatching"
STATE_RUNNING = "running"
STATE_WAITING = "waiting_input"
STATE_DONE = "done"
STATE_FAILED = "failed"
STATE_UNROUTED = routing.UNROUTED


class DispatchError(RuntimeError):
    """Dispatch could not be completed. Never swallowed."""


@dataclass
class DispatchResult:
    run_id: str
    created: bool
    profile: Optional[str]
    project: Optional[str]
    correlation_id: str
    routing_reason: str
    routing_source: str
    #: How this run was obtained. ``created`` vs ``existing`` is the difference
    #: between "we started it" and "a retry found it already running", and an
    #: operator reading a log needs to know which.
    dispatch_reason: str
    inputs: Dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "run_id": self.run_id,
            "created": self.created,
            "profile": self.profile,
            "project": self.project,
            "correlation_id": self.correlation_id,
            "routing_reason": self.routing_reason,
            "routing_source": self.routing_source,
            "dispatch_reason": self.dispatch_reason,
            "inputs": self.inputs,
        }


def enrich_inputs(task: Any, decision: routing.RouteDecision) -> Dict[str, Any]:
    """The run inputs a routed task implies.

    Enrichment is a copy: the delivery's own ``detail`` is passed under a
    reserved key rather than merged, so a key collision cannot make a routing
    decision look like something the sender chose.
    """
    inputs: Dict[str, Any] = {}
    if decision.profile:
        inputs["profile"] = decision.profile
    if decision.project:
        inputs["project"] = decision.project
    if decision.channel:
        inputs["channel"] = decision.channel
    detail = getattr(task, "detail", None)
    if isinstance(detail, dict):
        inputs["task_detail"] = dict(detail)
    inputs["correlation_id"] = getattr(task, "correlation_id", None)
    return {k: v for k, v in inputs.items() if v is not None}


def dispatch(
    conn,
    task: Any,
    template: dict,
    *,
    rules: tuple = (),
    default_profile: Optional[str] = None,
    create_run: Optional[Callable[..., str]] = None,
    now: Optional[float] = None,
) -> DispatchResult:
    """Route the task, then start a run for it -- once.

    ``create_run`` is injected so the routing, enrichment and idempotency can be
    tested without a pipelines database, and so a caller can substitute its own
    creation path.
    """
    create = create_run or pipelines_db.create_run

    # Already dispatched: return the same run rather than starting a second.
    # The binding is read from the **database**, not from the object handed in.
    # A caller in the same process that re-dispatches the task it dispatched a
    # moment ago still holds the old value, and trusting it would start a second
    # run for one delivery -- the exact thing the retry protection exists to
    # prevent, defeated by the caller's own memory.
    stored = ingress.get_task(
        conn, platform=task.platform, external_id=task.external_id,
    )
    existing = getattr(stored or task, "run_id", None)
    if existing:
        bound = stored or task
        return DispatchResult(
            run_id=existing, created=False, profile=bound.profile, project=bound.project,
            correlation_id=bound.correlation_id,
            routing_reason="already bound to a run",
            routing_source="task.run_id",
            dispatch_reason="a previous delivery already dispatched this task",
        )

    decision = routing.route(
        {
            "platform": task.platform,
            "external_id": task.external_id,
            "profile": task.profile,
            "project": task.project,
            "channel": task.channel,
            "title": task.title,
        },
        rules,
        default_profile=default_profile,
    )

    if not decision.routed:
        # Refuse. Do not invent a profile, and do not silently do nothing.
        ingress.set_state(
            conn, platform=task.platform, external_id=task.external_id,
            state=STATE_UNROUTED, now=now,
        )
        raise DispatchError(decision.reason)

    inputs = enrich_inputs(task, decision)
    run_id = create(conn, template, inputs=inputs, now=now)
    if not run_id:
        raise DispatchError("create_run returned no run id")

    ingress.bind_run(
        conn,
        platform=task.platform,
        external_id=task.external_id,
        run_id=run_id,
        session_id=getattr(task, "session_id", None),
        now=now,
    )
    # `ExternalTask` is frozen: the new value is returned rather than assigned
    # onto a caller's object, so a caller holding the old one is not left with a
    # task that pretends to be undispatched.
    task = replace(decision.apply_to(task), run_id=run_id, state=STATE_DISPATCHING)
    ingress.set_state(
        conn, platform=task.platform, external_id=task.external_id,
        state=STATE_DISPATCHING, now=now,
    )

    return DispatchResult(
        run_id=run_id, created=True, profile=decision.profile,
        project=decision.project, correlation_id=task.correlation_id,
        routing_reason=decision.reason, routing_source=decision.source,
        dispatch_reason="dispatched from a routed delivery",
        inputs=inputs,
    )


# --- writeback ---------------------------------------------------------------


def _write_detail(conn, task: Any, detail: Dict[str, Any], now: Optional[float]) -> None:
    """Persist a task's detail blob. One place, because two hand-written UPDATEs
    is how one of them ends up missing a column."""
    conn.execute(
        "UPDATE external_tasks SET detail_json = ?, updated_at = ? "
        "WHERE platform = ? AND external_id = ?",
        (json.dumps(detail, ensure_ascii=False),
         now if now is not None else time.time(), task.platform, task.external_id),
    )


def writeback_state(conn, task: Any, state: str, *, now: Optional[float] = None) -> Any:
    """The task with its new state.

    Writing the state that is already recorded returns the **same** task rather
    than issuing a redundant write, so every writeback is checked the same way.
    """
    if getattr(task, "state", None) == state:
        return task
    ingress.set_state(
        conn, platform=task.platform, external_id=task.external_id, state=state, now=now,
    )
    return replace(task, state=state)


def writeback_question(conn, task: Any, prompt: str, *, now: Optional[float] = None) -> Any:
    """Attach a question to the task, once; returns the task.

    A task that already carries that exact question comes back **unchanged**, so
    the caller can tell "asked" from "already asked" by identity. A user
    answering the same prompt twice is a bug report, not a feature.
    """
    detail = dict(getattr(task, "detail", None) or {})
    questions = list(detail.get("questions") or [])
    if any(q.get("prompt") == prompt for q in questions):
        return task
    entry = {
        "prompt": prompt,
        "asked_at": now if now is not None else time.time(),
        "correlation_id": task.correlation_id,
    }
    questions.append(entry)
    detail["questions"] = questions
    _write_detail(conn, task, detail, now)
    return replace(task, detail=detail)


def writeback_artifact(conn, task: Any, artifact_id: str, name: str = "",
                       *, now: Optional[float] = None) -> Any:
    """Record a produced artifact against the task, once; returns the task.

    An artifact already recorded comes back **unchanged**, which is the normal
    outcome of a replayed writeback rather than an error. All three writebacks
    share that contract: a returned task that is the same object means nothing
    was written.
    """
    detail = dict(getattr(task, "detail", None) or {})
    artifacts = list(detail.get("artifacts") or [])
    if any(a.get("artifact_id") == artifact_id for a in artifacts):
        return task
    artifacts.append({
        "artifact_id": artifact_id,
        "name": name or artifact_id,
        "recorded_at": now if now is not None else time.time(),
        "correlation_id": task.correlation_id,
    })
    detail["artifacts"] = artifacts
    _write_detail(conn, task, detail, now)
    return replace(task, detail=detail)
