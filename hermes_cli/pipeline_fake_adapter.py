"""A deterministic step adapter (spec §8, §3).

Real behaviour comes later — #34 wires the actual Hermes adapter. What the
executor needs first is something whose answers are a function of its input, so
the counters, the retries and the rework branch can be tested without a model
in the loop and without the test asserting on anything a model decided.

The determinism is the whole point. A scenario here returns a scripted output
per step, keyed by ``(step_id, occurrence)``, and the occurrence counter is what
lets a scenario say "fail the first review, approve the second" — the rework
branch is only reachable if something is willing to change its mind.
"""

from __future__ import annotations

from typing import Any, Callable, Mapping, Optional

from hermes_cli.pipeline_executor import (
    AccessError,
    AdapterError,
    ContractError,
    ExecutionResult,
    UnknownOutcome,
)

__all__ = ["FakeAdapter", "scripted", "flaky", "unknown_outcome"]


class FakeAdapter:
    """An in-memory adapter whose every answer is decided before the call.

    ``plans`` maps a step id to its list of scripted responses, consumed in
    order; the last one repeats. A response may be:

    * a ``dict`` — the step's output;
    * an ``Exception`` instance — raised from ``submit``;
    * an :class:`ExecutionResult` — reported from ``result``;
    * :func:`unknown_outcome` / :func:`flaky` markers for the awkward cases.

    Every submission is recorded in ``calls`` so a test can assert on what was
    sent — the input resolution and the idempotency key are the parts most
    worth checking, and asserting them from the executor's internals instead
    would only prove the executor agrees with itself.
    """

    def __init__(
        self,
        plans: Optional[Mapping[str, list[Any]]] = None,
        *,
        default: Any = None,
        forget_on_restart: bool = False,
    ) -> None:
        self.plans = {k: list(v) for k, v in (plans or {}).items()}
        self.default = default if default is not None else {}
        # Reconciliation after a restart: an adapter that forgot the execution
        # is what makes `recover` take the `blocked` path, and it has to be
        # something a test can ask for.
        self.forget_on_restart = forget_on_restart
        self.calls: list[dict] = []
        self._results: dict[str, ExecutionResult] = {}
        self._cancelled: set[str] = set()
        self._seq = 0

    # -- StepAdapter -------------------------------------------------------------

    def submit(self, request: dict) -> str:
        self.calls.append(dict(request))
        step_id = request.get("step_id")
        seen = sum(1 for c in self.calls if c.get("step_id") == step_id)
        plan = self.plans.get(step_id) or []
        planned = plan[seen - 1] if seen <= len(plan) else (plan[-1] if plan else self.default)

        if isinstance(planned, BaseException):
            raise planned
        if planned is unknown_outcome:
            raise UnknownOutcome(f"fake adapter lost the thread on {step_id}")

        self._seq += 1
        execution_id = f"exec_{self._seq:04d}"
        if isinstance(planned, ExecutionResult):
            self._results[execution_id] = planned
        elif isinstance(planned, dict):
            self._results[execution_id] = ExecutionResult(state="completed", output=planned)
        else:
            self._results[execution_id] = ExecutionResult(state="completed", output=self.default)
        return execution_id

    def result(self, execution_id: str) -> Optional[ExecutionResult]:
        if self.forget_on_restart:
            # A real adapter that has lost the process would answer "no idea",
            # and that answer is the whole reason `blocked` exists.
            return None
        return self._results.get(execution_id)

    def cancel(self, execution_id: str) -> bool:
        if execution_id in self._results:
            self._cancelled.add(execution_id)
            return True
        return False

    # -- Test helpers ------------------------------------------------------------

    def calls_for(self, step_id: str) -> list[dict]:
        return [c for c in self.calls if c.get("step_id") == step_id]

    def count_for(self, step_id: str) -> int:
        return len(self.calls_for(step_id))


def scripted(**steps: Any) -> dict[str, list[Any]]:
    """``scripted(review=[out1, out2])`` — the readable form for scenarios."""
    return {name: list(values) if isinstance(values, list) else [values] for name, values in steps.items()}


class _UnknownOutcomeMarker:
    """Submit as if the call may or may not have taken effect."""

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return "unknown_outcome"


# A single sentinel, so `planned is unknown_outcome` is the whole check.
unknown_outcome = _UnknownOutcomeMarker()


def flaky(times: int, error: Optional[BaseException] = None) -> list[Any]:
    """``times`` technical failures, then the given output (or a single empty one).

    Used to prove the retry counter is independent of the rework counter: this
    fails the *same* step repeatedly without ever changing what a later step
    returns.
    """
    return [error or AdapterError("fake transient failure", error_code="transient")] * times + [{}]
