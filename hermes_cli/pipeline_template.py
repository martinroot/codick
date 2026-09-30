"""CoDick pipeline template format v1 + import validation (spec §5, §6; issue #30).

Two layers, deliberately separate:

* **Structural** — JSON Schema Draft 2020-12 (the dialect pinned as a hard
  dependency in #46) over the v1 shape of spec §5: identity fields,
  ``inputs_schema``, ``limits``, steps with per-type required fields, ``result``.
* **Semantic** — what no schema can express: unique step ids, ``start_step``
  exists, every ``next`` and case transition resolves, every ``{ref}`` has a
  reachable root (``inputs`` or ``steps``), unreachable steps, paths that can
  never reach an end, and a cycle without a required limit.

Every error carries the JSON path and the text (``steps[2].cases[0].next:
unknown step``) — "invalid template" is not a message (§6).

Readiness is checked *through the adapter seams*, per §6: profile ids resolve
through :mod:`hermes_cli.pipeline_profiles` (the ``pipelines.profiles`` binding,
no silent fallback), tool ids through the injectable ``tool_available``
predicate (default: the registered tool names). A missing profile/tool is a
readiness error, not a structural one: the template may be **stored as
``unavailable``** but must not be runnable. The real Hermes adapter lands with
#34 and plugs into the same seams.

Import idempotency (§6): same ``(id, version)`` + same canonical hash is a
no-op; the same pair with different content raises
:class:`TemplateConflict` — a new version is offered, never silently replaced.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass, field
from typing import Any, Callable, List, Mapping, Optional

from jsonschema import Draft202012Validator

from hermes_cli.sqlite_util import write_txn
from hermes_cli.pipeline_profiles import (
    PROFILE_DOES_NOT_EXIST,
    resolve_profile_id,
    unavailable_profile_ids,
)

__all__ = [
    "SCHEMA_VERSION", "CONDITION_OPS",
    "TemplateError", "TemplateValidationError", "TemplateConflict",
    "ImportResult",
    "validate_template", "canonical_template_hash",
    "unavailable_tool_ids", "import_validated_template",
]

SCHEMA_VERSION = "1.0"

# MVP operations of a condition step (spec §5). Anything else is rejected:
# arbitrary expressions are out of scope (spec §3).
CONDITION_OPS = frozenset({"eq", "ne", "exists", "gt", "gte", "lt", "lte", "all", "any"})
_ORDER_OPS = frozenset({"gt", "gte", "lt", "lte"})

STEP_TYPES = ("agent", "tool", "user_input", "condition")


# --- Structural schema (Draft 2020-12) ----------------------------------------

_TEMPLATE_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["schema_version", "id", "version", "start_step", "steps"],
    "additionalProperties": False,
    "properties": {
        "schema_version": {"const": SCHEMA_VERSION},
        "id": {"type": "string", "minLength": 1},
        "version": {"type": "string", "minLength": 1},
        "name": {"type": "string"},
        "description": {"type": "string"},
        "inputs_schema": {"type": "object"},
        "start_step": {"type": "string", "minLength": 1},
        "limits": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "max_step_executions": {"type": "integer", "minimum": 1},
                "max_rework_cycles": {"type": "integer", "minimum": 0},
            },
        },
        "steps": {"type": "array", "minItems": 1, "items": {"$ref": "#/$defs/step"}},
        "result": {"type": "object"},
    },
    "$defs": {
        "ref_or_literal": {},
        "step": {
            "type": "object",
            "required": ["id", "type"],
            "additionalProperties": False,
            "properties": {
                "id": {"type": "string", "minLength": 1},
                "type": {"enum": list(STEP_TYPES)},
                "title": {"type": "string"},
                "input": {"type": "object"},
                "output_schema": {"type": "object"},
                # agent
                "profile": {"type": "string", "minLength": 1},
                "instruction": {"type": "string", "minLength": 1},
                # tool
                "tool": {"type": "string", "minLength": 1},
                # user_input
                "prompt": {"type": "string", "minLength": 1},
                "response_schema": {"type": "object"},
                "chat": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "enabled": {"type": "boolean"},
                        "profile": {"type": "string", "minLength": 1},
                    },
                },
                "wait_timeout_seconds": {"type": ["integer", "null"], "minimum": 0},
                # condition
                "cases": {"type": "array", "minItems": 1},
                "default": {"type": "object"},
                # shared
                "timeout_seconds": {"type": "integer", "minimum": 1},
                "retry": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "max_attempts": {"type": "integer", "minimum": 1},
                        "backoff_seconds": {"type": "integer", "minimum": 0},
                    },
                },
                "next": {"type": ["string", "null"], "minLength": 1},
            },
            "allOf": [
                {
                    "if": {"properties": {"type": {"const": "agent"}}, "required": ["type"]},
                    "then": {"required": ["profile", "instruction", "next"]},
                },
                {
                    "if": {"properties": {"type": {"const": "tool"}}, "required": ["type"]},
                    "then": {"required": ["tool", "next"]},
                },
                {
                    "if": {"properties": {"type": {"const": "user_input"}}, "required": ["type"]},
                    "then": {"required": ["prompt", "response_schema", "next"]},
                },
                {
                    "if": {"properties": {"type": {"const": "condition"}}, "required": ["type"]},
                    "then": {"required": ["cases", "default"]},
                },
            ],
        },
    },
}


# --- Errors ---------------------------------------------------------------------

@dataclass
class TemplateError:
    """One validation finding: the JSON path plus the text (spec §6)."""

    path: str
    message: str

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"{self.path}: {self.message}"


class TemplateValidationError(ValueError):
    """Structural/semantic validation failed; nothing is stored."""

    def __init__(self, errors: List[TemplateError]) -> None:
        self.errors = errors
        shown = "; ".join(str(e) for e in errors[:5])
        super().__init__(f"invalid template ({len(errors)} error(s)): {shown}")


class TemplateConflict(ValueError):
    """Same ``(id, version)`` re-imported with different content (spec §6)."""

    def __init__(self, template_id: str, version: str) -> None:
        self.template_id = template_id
        self.version = version
        super().__init__(
            f"template '{template_id}' version '{version}' already exists with different "
            f"content; import as a new version instead"
        )


@dataclass
class ImportResult:
    """Outcome of :func:`import_validated_template`.

    ``stored`` — validated and runnable. ``unavailable`` — stored but not
    runnable until the missing profile/tool exists (spec §6). ``idempotent`` —
    the exact same ``(id, version, hash)`` was already stored; nothing changed.
    """

    status: str
    template_id: str
    version: str
    template_hash: str
    readiness: List[str] = field(default_factory=list)


# --- Refs ------------------------------------------------------------------------

def response_schema_errors(response: Any, schema: Optional[dict]) -> list[dict]:
    """Validate a user_input response against the step's ``response_schema``.

    Returns one entry per failure, each carrying the JSON path of the offending
    value, so a 422 can name the field instead of saying "invalid". The caller
    is the UI and the API alike — spec §7 requires the same code on both sides,
    otherwise a form that validates in the browser can still be rejected by the
    server with a different message.

    An empty or absent schema accepts any object: it means the step declared no
    shape, not that it forbids everything.
    """
    if not schema:
        return []
    try:
        from jsonschema import Draft202012Validator
    except Exception as exc:  # noqa: BLE001 - surfaced, never silently skipped
        raise RuntimeError(f"jsonschema is required to validate a response: {exc}") from exc
    if not isinstance(response, dict):
        return [{"path": "", "message": "response must be a JSON object"}]
    validator = Draft202012Validator(schema)
    errors = []
    for err in sorted(validator.iter_errors(response), key=lambda e: list(e.absolute_path)):
        base = "$" + "".join(
            f"[{part}]" if isinstance(part, int) else f".{part}" for part in err.absolute_path
        )
        # A missing required property is reported by jsonschema against the
        # *object* that lacks it, so `{"items":[{...no qty}]}` comes back as
        # `$.items[1]`. That is technically true and practically useless — the
        # issue asks for the failing field's path, so expand it per property.
        if err.validator == "required" and isinstance(err.instance, dict):
            missing = [k for k in (err.validator_value or []) if k not in err.instance]
            for name in missing:
                errors.append({
                    "path": f"{base}.{name}",
                    "message": f"{name!r} is required",
                    "validator": "required",
                })
            continue
        errors.append({"path": base or "$", "message": err.message,
                       "validator": str(err.validator)})
    return errors


def _is_ref(value: Any) -> bool:
    return isinstance(value, Mapping) and isinstance(value.get("ref"), str)


def _ref_root_ok(ref: str, inputs_schema: Mapping[str, Any], step_ids: set[str],
                 errors: List[TemplateError], path: str) -> None:
    """A ``{ref}`` must have a reachable root: ``inputs.<prop>`` declared in
    ``inputs_schema.properties``, or ``steps.<id>[.output...]`` naming an
    existing step (spec §6: "every {ref} has a reachable root (inputs or
    steps)"). Segments beyond the step id are the runtime's concern (spec §5:
    data availability under conditional branches is re-checked at execution)."""
    parts = [p for p in ref.split(".") if p]
    if len(parts) < 2:
        errors.append(TemplateError(path, f"ref '{ref}' must start with inputs.<property> or steps.<step_id>"))
        return
    root, second = parts[0], parts[1]
    if root == "inputs":
        props = inputs_schema.get("properties")
        if not isinstance(props, Mapping) or second not in props:
            errors.append(TemplateError(path, f"ref '{ref}': unknown input '{second}'"))
    elif root == "steps":
        if second not in step_ids:
            errors.append(TemplateError(path, f"ref '{ref}': unknown step '{second}'"))
    else:
        errors.append(TemplateError(path, f"ref '{ref}': root must be 'inputs' or 'steps', not '{root}'"))


def _validate_value(value: Any, inputs_schema: Mapping[str, Any], step_ids: set[str],
                    errors: List[TemplateError], path: str) -> None:
    """A value slot: either a ``{ref}`` (validated) or a literal (anything)."""
    if _is_ref(value):
        ref = value["ref"].strip()
        if not ref:
            errors.append(TemplateError(path, "ref must be a non-empty string"))
            return
        optional = value.get("optional") is True
        has_default = "default" in value
        if optional != has_default:
            errors.append(TemplateError(
                path, f"ref '{ref}': optional and default must be given together "
                      f"(an optional ref without a default cannot run)"))
        _ref_root_ok(ref, inputs_schema, step_ids, errors, path)


def _validate_refs(value: Any, inputs_schema: Mapping[str, Any], step_ids: set[str],
                   errors: List[TemplateError], path: str) -> None:
    """Walk any JSON value validating every ``{ref}`` object it contains."""
    if isinstance(value, Mapping):
        if _is_ref(value):
            _validate_value(value, inputs_schema, step_ids, errors, path)
            return
        for key, sub in value.items():
            _validate_refs(sub, inputs_schema, step_ids, errors, f"{path}.{key}")
    elif isinstance(value, list):
        for i, sub in enumerate(value):
            _validate_refs(sub, inputs_schema, step_ids, errors, f"{path}[{i}]")


# --- Semantic validation -----------------------------------------------------------

def _json_path(parts: tuple) -> str:
    """Schema-library path tuple -> the §6 JSON path format:
    ``steps[2].cases[0].next`` (array indices bracketed, keys dotted,
    first segment unqualified: ``steps[0]``, not ``$.steps[0]``)."""
    if not parts:
        return "$"
    head, *rest = parts
    out = str(head)
    for p in rest:
        out += f"[{p}]" if isinstance(p, int) else f".{p}"
    return out


def _structural_errors(template: Mapping[str, Any]) -> List[TemplateError]:
    errors: List[TemplateError] = []
    for err in Draft202012Validator(_TEMPLATE_SCHEMA).iter_errors(template):
        errors.append(TemplateError(_json_path(err.absolute_path), err.message))
    return errors


def _validate_condition(step: Mapping[str, Any], step_ids: set[str], index: int,
                        inputs_schema: Mapping[str, Any], errors: List[TemplateError]) -> None:
    base = f"steps[{index}]"
    sid = step.get("id")
    cases = step.get("cases")
    if not isinstance(cases, list) or not cases:
        errors.append(TemplateError(f"{base}.cases", "condition requires a non-empty cases list"))
        cases = []
    for ci, case in enumerate(cases):
        cpath = f"{base}.cases[{ci}]"
        if not isinstance(case, Mapping):
            errors.append(TemplateError(cpath, "case must be an object"))
            continue
        when = case.get("when")
        if not isinstance(when, Mapping):
            errors.append(TemplateError(f"{cpath}.when", "case requires a when object"))
        else:
            _validate_when(when, step_ids, inputs_schema, errors, f"{cpath}.when")
        nxt = case.get("next")
        if not isinstance(nxt, str) or not nxt.strip():
            errors.append(TemplateError(f"{cpath}.next", "case transition must name the next step"))
        elif nxt not in step_ids:
            errors.append(TemplateError(f"{cpath}.next", f"unknown step '{nxt}'"))
        if case.get("rework") is True and step_ids and nxt not in step_ids:
            pass  # next already reported; rework only makes sense with a target
    default = step.get("default")
    if isinstance(default, Mapping):
        if "fail" in default:
            if not isinstance(default["fail"], str) or not default["fail"].strip():
                errors.append(TemplateError(f"{base}.default.fail", "fail must carry a non-empty reason"))
        elif "next" in default:
            nxt = default["next"]
            if not isinstance(nxt, str) or not nxt.strip():
                errors.append(TemplateError(f"{base}.default.next", "default transition must name the next step"))
            elif nxt not in step_ids:
                errors.append(TemplateError(f"{base}.default.next", f"unknown step '{nxt}'"))
        else:
            errors.append(TemplateError(f"{base}.default", "default must carry either next or fail"))


def _validate_when(when: Mapping[str, Any], step_ids: set[str], inputs_schema: Mapping[str, Any],
                   errors: List[TemplateError], path: str) -> None:
    op = when.get("op")
    if op not in CONDITION_OPS:
        errors.append(TemplateError(f"{path}.op", f"unknown operation '{op}'; MVP supports "
                                                 f"{', '.join(sorted(CONDITION_OPS))}"))
        return
    if op in ("all", "any"):
        sub = when.get("conditions")
        if not isinstance(sub, list) or not sub:
            errors.append(TemplateError(f"{path}.conditions", f"{op} requires a non-empty conditions list"))
            return
        for i, item in enumerate(sub):
            if not isinstance(item, Mapping):
                errors.append(TemplateError(f"{path}.conditions[{i}]", "condition must be an object"))
                continue
            _validate_when(item, step_ids, inputs_schema, errors, f"{path}.conditions[{i}]")
        return
    left = when.get("left")
    if left is None:
        errors.append(TemplateError(f"{path}.left", f"{op} requires a left operand"))
    else:
        _validate_value(left, inputs_schema, step_ids, errors, f"{path}.left")
    if op == "exists":
        if "right" in when:
            errors.append(TemplateError(f"{path}.right", "exists takes no right operand"))
        return
    if "right" not in when:
        errors.append(TemplateError(f"{path}.right", f"{op} requires a right operand"))
    else:
        _validate_value(when["right"], inputs_schema, step_ids, errors, f"{path}.right")


def _edges(template: Mapping[str, Any], step_ids: list[str]) -> dict[str, set[str]]:
    """The step graph: id -> ids it can hand control to."""
    by_index = {i: s for i, s in enumerate(template.get("steps", [])) if isinstance(s, Mapping)}
    edges: dict[str, set[str]] = {sid: set() for sid in step_ids}
    for i, step in by_index.items():
        sid = step.get("id")
        if sid not in edges:
            continue
        if step.get("type") == "condition":
            for case in step.get("cases") or []:
                if isinstance(case, Mapping) and isinstance(case.get("next"), str):
                    edges[sid].add(case["next"])
            default = step.get("default")
            if isinstance(default, Mapping) and isinstance(default.get("next"), str):
                edges[sid].add(default["next"])
        else:
            nxt = step.get("next")
            if isinstance(nxt, str) and nxt:
                edges[sid].add(nxt)
    return edges


def _graph_errors(template: Mapping[str, Any], step_ids: list[str], start: str,
                  limits: Mapping[str, Any], errors: List[TemplateError]) -> None:
    edges = _edges(template, step_ids)
    step_set = set(step_ids)

    # Unreachable steps: never arrived at from start_step.
    seen: set[str] = set()
    stack = [start]
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        stack.extend(edges.get(cur, ()))
    for i, sid in enumerate(step_ids):
        if sid not in seen:
            errors.append(TemplateError(f"steps[{i}]", f"unreachable step '{sid}': no path from start_step"))

    # No path to an end: from a step, can we ever stop? Terminal points are a
    # null `next`, a condition default with `fail`, and (transitively) any step
    # that can itself reach one.
    terminating: set[str] = set()
    for i, step in enumerate(template.get("steps", [])):
        if not isinstance(step, Mapping):
            continue
        sid = step.get("id")
        if sid not in step_set:
            continue
        if step.get("type") == "condition":
            default = step.get("default")
            if isinstance(default, Mapping) and "fail" in default:
                terminating.add(sid)
        elif step.get("next", "missing") is None:
            terminating.add(sid)
    changed = True
    while changed:
        changed = False
        for sid in step_ids:
            if sid in terminating:
                continue
            if any(t in terminating for t in edges.get(sid, ())):
                terminating.add(sid)
                changed = True
    for i, sid in enumerate(step_ids):
        if sid not in terminating:
            errors.append(TemplateError(f"steps[{i}]",
                                        f"no path to an end from step '{sid}': the scenario cannot finish here"))

    # A cycle is only safe with a hard execution limit (spec §6).
    if _has_cycle(edges, step_ids):
        max_exec = limits.get("max_step_executions")
        if not isinstance(max_exec, int) or max_exec < 1:
            errors.append(TemplateError("limits.max_step_executions",
                                        "the scenario contains a cycle, a positive max_step_executions is required"))


def _has_cycle(edges: dict[str, set[str]], step_ids: list[str]) -> bool:
    WHITE, GREY, BLACK = 0, 1, 2
    color = {sid: WHITE for sid in step_ids}

    def dfs(node: str) -> bool:
        color[node] = GREY
        for nxt in edges.get(node, ()):
            if color.get(nxt) == GREY:
                return True
            if color.get(nxt) == WHITE and dfs(nxt):
                return True
        color[node] = BLACK
        return False

    return any(color[sid] == WHITE and dfs(sid) for sid in step_ids)


def _validate_refs_deep(template: Mapping[str, Any], inputs_schema: Mapping[str, Any],
                        step_ids: set[str], errors: List[TemplateError]) -> None:
    """Every ``{ref}`` in inputs of steps, condition operands, and result."""
    steps = template.get("steps")
    for i, step in enumerate(steps or []):
        if not isinstance(step, Mapping):
            continue
        base = f"steps[{i}]"
        _validate_refs(step.get("input"), inputs_schema, step_ids, errors, f"{base}.input")
        if step.get("type") == "condition":
            for ci, case in enumerate(step.get("cases") or []):
                if isinstance(case, Mapping) and isinstance(case.get("when"), Mapping):
                    _validate_refs(case["when"], inputs_schema, step_ids,
                                   errors, f"{base}.cases[{ci}].when")
    _validate_refs(template.get("result"), inputs_schema, step_ids, errors, "result")


def validate_template(template: Mapping[str, Any]) -> List[TemplateError]:
    """All structural and semantic validation findings for a v1 template; an
    empty list means valid. Readiness (profiles/tools) is reported separately
    by :func:`unavailable_tool_ids` and
    :func:`hermes_cli.pipeline_profiles.unavailable_profile_ids` — a missing
    one is a readiness report, not a validation error (spec §6).
    """
    errors: List[TemplateError] = []
    if not isinstance(template, Mapping):
        return [TemplateError("$", "template must be a JSON object")]

    errors.extend(_structural_errors(template))

    steps = template.get("steps")
    step_list: List[Mapping[str, Any]] = [s for s in steps if isinstance(s, Mapping)] if isinstance(steps, list) else []
    step_ids: List[str] = [s.get("id") for s in step_list if isinstance(s.get("id"), str)]
    step_set = set(step_ids)

    # Unique step ids (§6) — one error per duplicate occurrence.
    first_seen: dict[str, int] = {}
    for i, step in enumerate(step_list):
        sid = step.get("id")
        if not isinstance(sid, str):
            continue
        if sid in first_seen:
            errors.append(TemplateError(f"steps[{i}].id", f"duplicate step id '{sid}'"))
        else:
            first_seen[sid] = i

    start = template.get("start_step")
    if isinstance(start, str) and start and start not in step_set:
        errors.append(TemplateError("start_step", f"unknown step '{start}'"))

    inputs_schema = template.get("inputs_schema") if isinstance(template.get("inputs_schema"), Mapping) else {}
    limits = template.get("limits") if isinstance(template.get("limits"), Mapping) else {}

    # Per-type transitions and condition semantics.
    for i, step in enumerate(step_list):
        base = f"steps[{i}]"
        stype = step.get("type")
        if stype in ("agent", "tool", "user_input"):
            nxt = step.get("next", "missing")
            if nxt == "missing":
                errors.append(TemplateError(f"{base}.next", f"{stype} step requires next (a step id or null)"))
            elif nxt is not None and (not isinstance(nxt, str) or nxt not in step_set):
                errors.append(TemplateError(f"{base}.next", f"unknown step '{nxt}'"))
        elif stype == "condition":
            _validate_condition(step, step_set, i, inputs_schema, errors)

    if isinstance(start, str) and start in step_set and step_list:
        _graph_errors(template, step_ids, start, limits, errors)

    if step_set:
        _validate_refs_deep(template, inputs_schema, step_set, errors)

    # Readiness (spec §6): profiles and tools through the adapter seams. These
    # are NOT validation errors — a missing one is a readiness report, the
    # template stores as `unavailable`.
    return errors


def unavailable_tool_ids(template: Mapping[str, Any], tool_available: Optional[Callable[[str], bool]] = None) -> List[str]:
    """Logical tool ids of the template's tool steps that the adapter cannot
    resolve (sorted, deduplicated). The default seam checks the registered
    tool names; #34's real adapter replaces the predicate without touching
    this module."""
    check = tool_available if tool_available is not None else _default_tool_available
    ids: List[str] = []
    steps = template.get("steps") if isinstance(template, Mapping) else None
    if not isinstance(steps, list):
        return ids
    for step in steps:
        if not isinstance(step, Mapping) or step.get("type") != "tool":
            continue
        raw = step.get("tool")
        if not isinstance(raw, str) or not raw.strip():
            continue
        tool_id = raw.strip()
        if tool_id in ids:
            continue
        try:
            ok = bool(check(tool_id))
        except Exception:
            ok = False  # fail closed: an unreadable registry is not a pass
        if not ok:
            ids.append(tool_id)
    return ids


def _default_tool_available(tool_id: str) -> bool:
    from tools.registry import discover_builtin_tools
    return tool_id in set(discover_builtin_tools())


def canonical_template_hash(template: Mapping[str, Any]) -> str:
    """The content hash import idempotency compares (spec §6): sha256 over the
    canonical sorted-keys dump — key order in the submitted JSON never matters."""
    snapshot = json.dumps(template, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(snapshot.encode("utf-8")).hexdigest()


def import_validated_template(
    conn: sqlite3.Connection,
    template: Mapping[str, Any],
    *,
    binding: Optional[Mapping[str, str]] = None,
    tool_available: Optional[Callable[[str], bool]] = None,
    now: Optional[int] = None,
) -> ImportResult:
    """Validate, then store per the §6 import contract. Raises
    :class:`TemplateValidationError` with the full error list before anything
    is written; raises :class:`TemplateConflict` on same id/version + different
    content. Returns an :class:`ImportResult` otherwise.

    ``binding`` — the ``pipelines.profiles`` map (logical profile id -> real
    profile name); the caller derives it from the effective config. Re-import
    of a stored-but-unavailable version with the same content re-runs the
    readiness check — installing the profile/tool and re-importing the same
    JSON is how an ``unavailable`` template becomes ``stored``.
    """
    from hermes_cli import pipelines_db as pdb

    errors = validate_template(template)
    if errors:
        raise TemplateValidationError(errors)

    template_id = str(template["id"]).strip()
    version = str(template["version"]).strip()
    digest = canonical_template_hash(template)

    # Readiness through the adapter seams (spec §6): a missing profile or tool
    # stores the template as `unavailable` — visible, but not runnable. The
    # profile reason text is the spec's exact operator-facing message, with the
    # name resolved through the binding (existence is checked after mapping).
    readiness: List[str] = []
    for logical in unavailable_profile_ids(template, binding):
        reason = PROFILE_DOES_NOT_EXIST.format(name=resolve_profile_id(logical, binding))
        if reason not in readiness:
            readiness.append(reason)
    for tool_id in unavailable_tool_ids(template, tool_available):
        readiness.append(f"tool '{tool_id}' is not available")
    # The stored readiness value is 'ready'/'unavailable'; `stored` is the
    # import result's word for the same thing and never a readiness value.
    status = "unavailable" if readiness else "stored"
    readiness_value = "unavailable" if readiness else "ready"

    existing = pdb.get_template(conn, template_id, version)
    if existing is not None:
        if canonical_template_hash(existing.template) == digest:
            if existing.readiness_status != readiness_value or existing.readiness_detail != readiness:
                _set_readiness(conn, template_id, version, readiness_value, readiness)
            return ImportResult(status="idempotent", template_id=template_id, version=version,
                                template_hash=digest, readiness=readiness)
        raise TemplateConflict(template_id, version)

    pdb.import_template(conn, dict(template), now=now)
    _set_readiness(conn, template_id, version, readiness_value, readiness)
    return ImportResult(status=status, template_id=template_id, version=version,
                        template_hash=digest, readiness=readiness)


def _set_readiness(conn: sqlite3.Connection, template_id: str, version: str,
                   status: str, detail: List[str]) -> None:
    """Stamp the readiness columns of one version. The migration in
    ``pipelines_db.connect`` guarantees the columns exist."""
    with write_txn(conn):
        conn.execute(
            "UPDATE scenario_templates SET readiness = ?, readiness_detail = ? WHERE id = ? AND version = ?",
            (status, json.dumps(detail, ensure_ascii=False) if detail else None, template_id, version),
        )
