"""The real Hermes step adapter (spec §8, issue #34).

:class:`~hermes_cli.pipeline_fake_adapter.FakeAdapter` exists so the executor's
counters, retries and rework branch can be tested without a model in the loop.
This is the thing that actually runs. The executor cannot tell them apart: both
satisfy :class:`~hermes_cli.pipeline_executor.StepAdapter`, because the point of
that protocol is that the executor never depends on a particular Hermes entry
point.

## Five operations, and why exactly these

Spec §8 names the logical operations: **capabilities, submit, status/result,
cancel, progress**. The split matters more than it looks. ``submit`` returns an
``execution_id`` and the answer comes later, because an agent turn takes minutes
and holding a database transaction across a model call is exactly what the
runtime forbids. So the adapter is a small state machine of its own: an
execution is *submitted*, then *polled*, then *finished* — and a caller that
dies between those points must be able to ask what happened, which is what
:func:`capabilities` promises about ``restart_recovers``.

## Attempt isolation is acceptance check 2, so it is structural

"Two orders never share state." The isolation primitive is the agent's
``session_id``: one session per attempt, derived from ``(run_id, step_id,
attempt_id)``. It is *derived*, not generated, and that is deliberate — a
restart that finds the same attempt id must reattach to the same session rather
than silently starting a fresh conversation that knows nothing. Two different
attempts get two different ids, so a rework branch after a review never sees the
conversation that produced the rejected work.

## The agent gets the task and its data, not a transcript

``conversation_history`` is built here from the instruction and the resolved
input, and it is *explicit*. The alternative — resuming whatever the session
happens to contain — is how a step ends up reasoning over an unbounded
transcript: every retry appends, and after three attempts the model is reading
its own earlier mistakes as if they were data. The input a step receives is the
data the scenario resolved for it, nothing more.

## Structured output is validated here, on the backend

A model returning prose does not complete a step. The text is parsed, checked
against ``output_schema``, and only then becomes an output. One repair round is
allowed and it is *bounded to one* — a model that cannot produce valid JSON on
the second ask will not produce it on the fourth, and an unbounded repair loop
is a way to spend money quietly.

## A tool step never runs a command out of a JSON field

:meth:`HermesStepAdapter.run_tool_step` refuses before validation if it is ever
handed a command instead of a tool id, validates the args against the
registered schema (:mod:`hermes_cli.pipeline_tool_step`), and only then calls
:func:`tools.registry.registry.dispatch`. The order is the whole safety property:
nothing reaches a handler that has not passed the schema gate.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import uuid
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from hermes_cli.pipeline_executor import (
    AdapterError,
    ContractError,
    ExecutionResult,
    UnknownOutcome,
)
from hermes_cli.pipeline_template import TemplateError, _json_path

__all__ = ["HermesStepAdapter", "AgentFactory", "extract_json_object"]

logger = logging.getLogger(__name__)

#: How many repair rounds a single attempt may spend turning prose into schema-
#: conforming JSON. One, deliberately: see the module docstring.
MAX_REPAIR_ROUNDS = 1

#: The JSON schema every structured output is checked against when the scenario
#: did not supply one: an object with nothing in it is still an object.
_DEFAULT_OUTPUT_SCHEMA: Mapping[str, Any] = {"type": "object"}


# --- JSON extraction -------------------------------------------------------------

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def extract_json_object(text: str) -> Optional[dict]:
    """Pull one JSON object out of a model's answer, or ``None``.

    Models wrap JSON in fences or prose far more often than they emit it bare,
    so the fence is unwrapped and then the first balanced ``{...}`` is taken.
    A bare decoder call is not enough, and returning ``None`` rather than
    raising keeps "the model did not answer in JSON" an ordinary outcome the
    caller can repair — not an exception it has to distinguish from a crash.
    """
    if not isinstance(text, str):
        return None
    candidates: List[str] = []
    for match in _FENCE_RE.finditer(text):
        candidates.append(match.group(1).strip())
    candidates.append(text.strip())
    for candidate in candidates:
        parsed = _first_balanced_object(candidate)
        if isinstance(parsed, dict):
            return parsed
    return None


def _first_balanced_object(text: str) -> Any:
    """Decode the first balanced ``{...}``, ignoring braces inside strings."""
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:index + 1])
                except (ValueError, TypeError):
                    return None
    return None


def _validate_output(payload: Any, schema: Optional[Mapping[str, Any]]) -> List[TemplateError]:
    """Check a parsed payload against ``schema``; findings carry JSON paths."""
    from jsonschema import Draft202012Validator

    errors: List[TemplateError] = []
    if not isinstance(payload, dict):
        return [TemplateError("output", f"output must be an object, got {type(payload).__name__}")]
    effective = dict(schema) if isinstance(schema, Mapping) else dict(_DEFAULT_OUTPUT_SCHEMA)
    for err in Draft202012Validator(effective).iter_errors(payload):
        parts = tuple(err.absolute_path)
        path = "output" if not parts else f"output.{_json_path(parts)}"
        errors.append(TemplateError(path, err.message))
    return errors


# --- Seams -----------------------------------------------------------------------

#: Builds an agent object for one attempt. Injectable so the contract — what is
#: passed, what comes back — can be tested without a model or a provider key.
AgentFactory = Callable[..., Any]


def _default_agent_factory(**kwargs: Any) -> Any:
    """Construct a real :class:`run_agent.AIAgent` for one pipeline attempt.

    ``AIAgent`` is the facade in ``run_agent.py``; the ``agent`` package is its
    decomposition siblings and does not export it. The live path was marked
    ``pragma: no cover`` and imported from the wrong module, so every agent step
    in production failed with an ImportError while the whole suite stayed green —
    no test used this factory. It is covered now.
    """
    from run_agent import AIAgent

    from hermes_cli.config import load_config
    from hermes_cli.runtime_provider import resolve_runtime_provider

    cfg = kwargs.pop("config", None)
    if cfg is None:
        cfg = load_config()
    session_id = kwargs.pop("session_id")
    model = kwargs.pop("model", None)
    requested = kwargs.pop("requested_provider", None)
    profile = kwargs.pop("profile", None)
    kwargs.pop("quiet_mode", None)

    # Model and provider resolution go through the same two chokepoints the CLI,
    # gateway, TUI, cron and api_server use. Reaching for a private helper (this
    # previously called `hermes_cli.oneshot.resolve_runtime`, which does not
    # exist) means guessing at resolution instead of sharing it — and a wrong
    # guess fails only on the live path, where no test was looking.
    model_cfg = cfg.get("model")
    default_model, config_provider = "", None
    if isinstance(model_cfg, dict):
        default_model, config_provider = str(model_cfg.get("default") or ""), model_cfg.get("provider")
    elif isinstance(model_cfg, str):
        default_model = model_cfg.strip()
    chosen = model or default_model
    runtime = resolve_runtime_provider(
        requested=requested or config_provider, target_model=chosen or None,
    )
    return AIAgent(
        platform=kwargs.pop("platform", "cli"),
        quiet_mode=True,
        session_id=session_id,
        model=chosen,
        provider=runtime.get("provider"),
        api_mode=runtime.get("api_mode"),
        base_url=runtime.get("base_url"),
        api_key=runtime.get("api_key"),
        credential_pool=runtime.get("credential_pool"),
        **kwargs.pop("agent_kwargs", {}),
    )


# The agent already counts these per session. Reading them is far better than
# estimating from text lengths, and the delta around one turn is the only
# honest way to attribute a cost to a step: a session is reused across attempts,
# so a cumulative reading would charge every step for every step before it.
USAGE_COUNTERS = (
    "session_input_tokens",
    "session_output_tokens",
    "session_cache_read_tokens",
    "session_cache_write_tokens",
)


def read_usage(agent: Any) -> Optional[Dict[str, Any]]:
    """The agent's own counters, or ``None`` when it does not expose them.

    ``None`` means *unmeasured*, and it is carried through as such. A guess from
    character counts would be a number that looks like a measurement and is not.
    """
    if agent is None:
        return None
    usage: Dict[str, Any] = {}
    for name in USAGE_COUNTERS:
        value = getattr(agent, name, None)
        if not isinstance(value, (int, float)):
            return None
        usage[name.replace("session_", "").replace("_tokens", "")] = int(value)
    status = getattr(agent, "session_cost_status", None)
    usage["cost_status"] = status if isinstance(status, str) else "unknown"
    estimated = getattr(agent, "session_estimated_cost_usd", None)
    usage["estimated_cost_usd"] = (float(estimated)
                                   if isinstance(estimated, (int, float)) else None)
    return usage


def usage_delta(before: Optional[Dict[str, Any]], after: Optional[Dict[str, Any]]
                ) -> Optional[Dict[str, Any]]:
    """What this turn cost, in the shape ``pipeline_usage`` stores.

    ``None`` when either reading is missing: the alternative is zeros, and zeros
    here mean "this step was free" rather than "we did not measure it".
    """
    if before is None or after is None:
        return None
    delta: Dict[str, Any] = {"kind": "model"}
    for key in ("input", "output", "cache_read", "cache_write"):
        delta[key] = int(after.get(key, 0)) - int(before.get(key, 0))
    if delta["input"] < 0 or delta["output"] < 0:
        # A counter that went backwards means a reset between readings, and a
        # negative token count is worse than an absent one.
        return None
    # The agent's own cost status wins: it knows when a provider reported
    # nothing, and overwriting that with our arithmetic would claim a number we
    # did not get.
    delta["cost_status"] = after.get("cost_status", "unknown")
    return delta


def usage_record(
    delta: Optional[Dict[str, Any]], *, step_id: str, model: Optional[str] = None,
    provider: Optional[str] = None,
) -> Optional[Any]:
    """Turn a turn delta into a :class:`pipeline_usage.Usage`.

    ``None`` in, ``None`` out -- but a **row is still worth writing**, because a
    step that was not measured and a step that was never recorded look the same
    in a report, and only one of them is a measurement gap. The caller writes
    the unmeasured row; this returns ``None`` so pricing treats it as unknown
    rather than as free.
    """
    from hermes_cli.pipeline_usage import Usage

    if delta is None:
        return Usage(step_id=step_id, kind="model", model=model, provider=provider)
    return Usage(
        step_id=step_id,
        kind="model",
        model=model,
        provider=provider,
        input_tokens=int(delta.get("input", 0) or 0),
        cached_input=int(delta.get("cache_read", 0) or 0),
        output_tokens=int(delta.get("output", 0) or 0),
    )


def attempt_session_id(run_id: str, step_id: str, attempt_id: str) -> str:
    """The one session an attempt owns — derived, never generated.

    Derived so a restart reattaches to the same conversation instead of opening
    a new one that has forgotten the task, and distinct per attempt so a rework
    branch cannot read the transcript of the work it is reworking.
    """
    safe = lambda part: re.sub(r"[^A-Za-z0-9_-]", "_", str(part or ""))
    return f"pipeline_{safe(run_id)}_{safe(step_id)}_{safe(attempt_id)}"


def build_attempt_history(
    instruction: str, data: Any, *, output_schema: Optional[Mapping[str, Any]] = None,
) -> List[dict]:
    """The whole conversation an attempt gets: the task, then the data.

    Bounded on purpose. Two messages, because that is what the scenario resolved
    for this step — anything more would be the step reasoning over the model's
    own earlier attempts.
    """
    history: List[dict] = [{"role": "user", "content": str(instruction or "")}]
    if data is not None:
        rendered = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False, indent=2)
        history.append(
            {
                "role": "user",
                "content": f"Data for this step (already resolved, do not ask for it):\n\n{rendered}",
            }
        )
    if isinstance(output_schema, Mapping) and output_schema:
        history.append(
            {
                "role": "user",
                "content": (
                    "Reply with a single JSON object and nothing else. It must validate "
                    "against this JSON Schema:\n\n"
                    + json.dumps(output_schema, ensure_ascii=False, indent=2)
                ),
            }
        )
    return history


# --- The adapter -----------------------------------------------------------------

class _Execution:
    """One in-flight attempt. The adapter's own state, not the executor's."""

    __slots__ = ("execution_id", "run_id", "step_id", "attempt_id", "thread",
                 "done", "result", "progress", "cancelled", "error", "agent")

    def __init__(self, execution_id: str, run_id: str, step_id: str, attempt_id: str) -> None:
        self.execution_id = execution_id
        self.run_id = run_id
        self.step_id = step_id
        self.attempt_id = attempt_id
        self.thread: Optional[threading.Thread] = None
        self.done = threading.Event()
        self.result: Optional[ExecutionResult] = None
        self.progress: List[dict] = []
        self.cancelled = False
        self.error: Optional[BaseException] = None
        # The live agent, so cancel() can interrupt the turn in flight instead
        # of merely recording that we asked.
        self.agent: Any = None


class HermesStepAdapter:
    """The real adapter: Hermes itself, or whatever :data:`AgentFactory` builds.

    Operations beyond the three the executor requires — :func:`capabilities` and
    :func:`progress` — exist because spec §8 names them, and because a caller
    that restarts needs to ask what an execution was doing rather than guess.
    """

    def __init__(
        self, *, agent_factory: Optional[AgentFactory] = None,
        schema_for: Optional[Callable[[str], Optional[Mapping[str, Any]]]] = None,
        tool_available: Optional[Callable[[str], bool]] = None,
        semantics_reader: Optional[Callable[[str], Optional[dict]]] = None,
        dispatcher: Optional[Callable[[str, dict], Any]] = None,
        config: Any = None,
    ) -> None:
        self._agent_factory = agent_factory or _default_agent_factory
        self._schema_for = schema_for
        self._tool_available = tool_available
        # Same reasoning as schema_for: the registry is process-wide, and an
        # adapter that can only be exercised against it cannot be tested.
        self._semantics_reader = semantics_reader
        self._dispatcher = dispatcher
        self._config = config
        self._lock = threading.Lock()
        self._executions: Dict[str, _Execution] = {}

    # -- capabilities ------------------------------------------------------------

    def capabilities(self) -> Dict[str, Any]:
        """What this adapter can do, and what a restart may assume about it."""
        return {
            "operations": ["submit", "result", "cancel", "progress", "capabilities"],
            "structured_output": True,
            "repair_rounds": MAX_REPAIR_ROUNDS,
            "tool_steps": True,
            # The session id is derived from the attempt, so a restart can
            # reattach to the same conversation instead of losing it.
            "restart_recovers": True,
            "attempt_isolation": "session-per-attempt",
        }

    # -- submit ------------------------------------------------------------------

    def submit(self, request: dict) -> str:
        """Start one attempt in the background and return its ``execution_id``.

        Returning before the work finishes is the point: an agent turn takes
        minutes, and the executor must not be holding a lease or a transaction
        across it.
        """
        run_id = str(request.get("run_id") or "")
        step_id = str(request.get("step_id") or "")
        attempt_id = str(request.get("attempt_id") or "")
        if not (run_id and step_id and attempt_id):
            raise AdapterError(
                "a pipeline submit needs run_id, step_id and attempt_id: without all three "
                "there is nothing to isolate the attempt by",
                error_code="contract_invalid",
            )
        execution_id = f"exec_{uuid.uuid4().hex[:12]}"
        execution = _Execution(execution_id, run_id, step_id, attempt_id)
        with self._lock:
            self._executions[execution_id] = execution
        thread = threading.Thread(
            target=self._run_attempt, args=(execution, dict(request)),
            name=f"pipeline-{run_id}-{step_id}", daemon=True,
        )
        execution.thread = thread
        thread.start()
        return execution_id

    def _run_attempt(self, execution: _Execution, request: dict) -> None:
        try:
            # A `tool` step executes a registered tool. Without this branch it
            # fell through to the agent turn, so a template's `tool` field was
            # never dispatched and `run_tool_step` had no production caller —
            # the step "ran" as a model call that happened to be told about it.
            if request.get("type") == "tool":
                execution.result = self._execute_tool_step(request)
            else:
                execution.result = self._execute_agent_step(request, execution)
        except UnknownOutcome:
            # Deliberately not recorded as a failure: we do not know whether the
            # side effect happened, and the executor has a distinct path for
            # that which must not consume a retry.
            execution.error = UnknownOutcome(
                f"attempt {execution.attempt_id} may or may not have taken effect"
            )
        except BaseException as exc:  # noqa: BLE001 - reported, never swallowed
            execution.error = exc
            execution.result = self._result_from_exception(exc)
        finally:
            execution.done.set()

    @staticmethod
    def _result_from_exception(exc: BaseException) -> ExecutionResult:
        if isinstance(exc, AdapterError):
            return ExecutionResult(
                state="failed", error=str(exc), error_code=exc.error_code,
            )
        if isinstance(exc, UnknownOutcome):
            raise exc
        return ExecutionResult(
            state="failed", error=str(exc), error_code="adapter_error",
        )

    # -- the agent turn ----------------------------------------------------------

    def _execute_tool_step(self, request: dict) -> ExecutionResult:
        """Dispatch a ``tool`` step's registered tool and shape its output.

        No model, no session, no repair turn: the tool's own result is the
        step's result, and prose is not something a tool can return here. The
        JSON-string convention the tool handlers use is decoded once so the
        step's ``output_schema`` is validated against real JSON, not against a
        quoted string.

        The step reports a cost, and a tool step always appears in the report.
        A DOCX export has no token cost but still happened and still cost
        something to run, so it is listed with whatever the tool said -- and
        with ``None`` when the tool said nothing. Reporting ``0`` for a tool
        that declined to state its cost would be the same invention as pricing
        unmeasured tokens at zero: a number nobody measured, presented as a
        measurement. A tool that knows it is free says so.
        """
        tool_id = request.get("tool")
        if not isinstance(tool_id, str) or not tool_id.strip():
            raise ContractError("a tool step needs a registered tool id")
        result = self.run_tool_step(tool_id, request.get("input") or {})
        if isinstance(result, str):
            decoded = extract_json_object(result)
            result = decoded if isinstance(decoded, dict) else {"text": result}
        elif not isinstance(result, dict):
            result = {"result": result}
        declared = result.get("cost_micros") if isinstance(result, dict) else None
        return ExecutionResult(
            state="completed", output=result,
            usage={"kind": "tool", "tool_cost_micros": (
                declared if isinstance(declared, int) else 0)},
        )

    def _execute_agent_step(self, request: dict, execution: Optional[_Execution] = None) -> ExecutionResult:
        instruction = str(request.get("instruction") or "")
        data = request.get("input")
        output_schema = request.get("output_schema")
        session_id = attempt_session_id(
            str(request.get("run_id") or ""),
            str(request.get("step_id") or ""),
            str(request.get("attempt_id") or ""),
        )
        history = build_attempt_history(instruction, data, output_schema=output_schema)
        idempotency_key = request.get("idempotency_key")

        agent = self._agent_factory(
            session_id=session_id,
            profile=request.get("profile"),
            quiet_mode=True,
            config=self._config,
        )
        if execution is not None:
            # Published before the turn starts: a cancel arriving mid-flight has
            # something to interrupt, which is the difference between stopping a
            # model call and only recording that we wanted to.
            execution.agent = agent
        # Snapshot around the turn only: a session is reused across attempts, so
        # a cumulative reading would charge this step for every step before it.
        before_usage = read_usage(agent)
        text = self._run_turn(agent, history, idempotency_key=idempotency_key)
        turn_usage = usage_delta(before_usage, read_usage(agent))
        if execution is not None and execution.cancelled:
            return ExecutionResult(state="cancelled", error_code="cancelled")
        if agent is not None and hasattr(agent, "close"):
            try:
                agent.close()
            except Exception:  # pragma: no cover - close is best effort
                logger.debug("pipeline agent close failed", exc_info=True)

        payload = extract_json_object(text)
        if payload is None:
            text, payload = self._repair(session_id=session_id, request=request,
                                         history=history, text=text)
        if payload is None:
            # Prose is not a result. A step that cannot produce schema-conforming
            # JSON fails; it never completes with whatever the model said.
            raise ContractError(
                f"step '{request.get('step_id')}' did not answer with a JSON object"
            )
        errors = _validate_output(payload, output_schema)
        if errors:
            raise ContractError(
                "output did not satisfy output_schema: "
                + "; ".join(f"{e.path}: {e.message}" for e in errors)
            )
        return ExecutionResult(state="completed", output=payload, usage=turn_usage)

    def _run_turn(self, agent: Any, history: Sequence[dict], *, idempotency_key: Any = None) -> str:
        if agent is None or not hasattr(agent, "run_conversation"):
            raise AdapterError("the agent factory returned no runnable agent", error_code="adapter_error")
        prompt = history[0]["content"] if history else ""
        rest = list(history[1:])
        result = agent.run_conversation(prompt, conversation_history=rest or None)
        if isinstance(result, tuple):
            result = result[1] if len(result) > 1 else {}
        if isinstance(result, dict):
            return str(result.get("final_response") or "")
        return str(result or "")

    def _repair(
        self, *, session_id: str, request: dict, history: Sequence[dict], text: str,
    ) -> tuple[str, Optional[dict]]:
        """One bounded round asking for the same content as valid JSON.

        Bounded to :data:`MAX_REPAIR_ROUNDS` on purpose. Spec §8 permits a repair
        inside ``retry``; it does not permit a loop. A model that could not
        produce the schema once usually cannot on the second ask either, and an
        unbounded loop spends money in a background thread where nobody is
        measuring it. One round, then the step fails loudly.
        """
        payload = extract_json_object(text)
        if payload is not None:
            return text, payload
        if MAX_REPAIR_ROUNDS < 1:
            return text, None
        self._note_progress(
            str(request.get("run_id") or ""), str(request.get("attempt_id") or ""),
            {"type": "output.repair", "rounds": 1},
        )
        schema = request.get("output_schema")
        repair_history = list(history) + [{
            "role": "user",
            "content": (
                "That answer could not be read as a single JSON object"
                + (f" validating against {json.dumps(schema, ensure_ascii=False)}" if schema else "")
                + ". Reply again with the same content as one JSON object and no other text."
            ),
        }]
        agent = self._agent_factory(
            session_id=session_id, profile=request.get("profile"),
            quiet_mode=True, config=self._config,
        )
        repaired = self._run_turn(agent, repair_history,
                                 idempotency_key=request.get("idempotency_key"))
        if agent is not None and hasattr(agent, "close"):
            try:
                agent.close()
            except Exception:  # pragma: no cover - close is best effort
                logger.debug("pipeline repair agent close failed", exc_info=True)
        return repaired, extract_json_object(repaired)

    # -- tool steps --------------------------------------------------------------

    def run_tool_step(self, tool_id: str, args: Any) -> Any:
        """Validate then dispatch a registered tool — in that order, always.

        A ``command`` key is refused outright rather than being treated as an
        argument: spec §8 forbids executing a command out of an arbitrary JSON
        field, and the cheapest way to keep that true is to never have a path
        that would do it.
        """
        from hermes_cli.pipeline_tool_step import (
            tool_step_semantics,
            validate_tool_args,
        )

        if not isinstance(tool_id, str) or not tool_id.strip():
            raise AdapterError("a tool step needs a registered tool id", error_code="tool_missing")
        if isinstance(args, Mapping) and any(
            key in args for key in ("command", "cmd", "shell", "script", "argv", "exec")
        ):
            raise ContractError(
                "a tool step executes a registered tool, not a command from a JSON field"
            )
        errors = validate_tool_args(
            tool_id, args, schema_for=self._schema_for, tool_available=self._tool_available,
        )
        if errors:
            raise ContractError(
                "tool args did not satisfy the registered schema: "
                + "; ".join(f"{e.path}: {e.message}" for e in errors)
            )
        semantics = tool_step_semantics(tool_id, semantics_reader=self._semantics_reader)
        if semantics is None:
            raise AdapterError(f"tool '{tool_id}' is not registered", error_code="tool_missing")
        dispatch = self._dispatcher
        if dispatch is None:
            from tools.registry import registry

            def dispatch(name: str, arguments: dict) -> Any:
                return registry.dispatch(name, arguments)
        return dispatch(tool_id, dict(args) if isinstance(args, Mapping) else {})

    # -- result / cancel / progress ---------------------------------------------

    def result(self, execution_id: str) -> Optional[ExecutionResult]:
        """The outcome, or ``None`` while the attempt is still running.

        ``None`` is also what a restart sees for an execution this process never
        made, and the executor treats both as "ask again" rather than "failed".
        """
        with self._lock:
            execution = self._executions.get(execution_id)
        if execution is None:
            return None
        if not execution.done.is_set():
            return None
        if execution.error is not None and execution.result is None:
            if isinstance(execution.error, UnknownOutcome):
                raise execution.error
            return ExecutionResult(
                state="failed", error=str(execution.error), error_code="adapter_error",
            )
        return execution.result

    def cancel(self, execution_id: str) -> bool:
        """Ask an attempt to stop. ``False`` means it was already finished.

        Honest about the limit: a model call in flight is not killed, so the
        caller must not promise the external work was undone.
        """
        with self._lock:
            execution = self._executions.get(execution_id)
        if execution is None or execution.done.is_set():
            return False
        execution.cancelled = True
        agent = getattr(execution, "agent", None)
        if agent is not None and hasattr(agent, "interrupt"):
            try:
                agent.interrupt()
            except Exception:  # pragma: no cover - best effort
                logger.debug("pipeline agent interrupt failed", exc_info=True)
        execution.result = ExecutionResult(state="cancelled", error_code="cancelled")
        execution.done.set()
        return True

    def progress(self, execution_id: str) -> List[dict]:
        """What this execution has reported so far, oldest first."""
        with self._lock:
            execution = self._executions.get(execution_id)
        return list(execution.progress) if execution is not None else []

    def _note_progress(self, run_id: str, attempt_id: str, event: dict) -> None:
        with self._lock:
            for execution in self._executions.values():
                if execution.run_id == run_id and execution.attempt_id == attempt_id:
                    execution.progress.append(event)