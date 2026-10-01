"""Tool step runtime: validated args and execution semantics (spec §8; issue #47).

Two responsibilities of a pipeline tool step, both layered *over* the registry
— the registry's own ``dispatch()`` deliberately does not validate (it serves
every turn on the hot path; the pipeline step owns its stricter contract):

* **Arg validation** — a Draft 2020-12 pass of the step's ``args`` against the
  registered tool's ``schema['parameters']`` (the same dialect pinned in #46).
  This is where spec §8's rule is actually enforced: no command is ever read
  out of an arbitrary JSON field, because anything the executor would hand the
  handler has passed this gate first. Errors carry JSON paths like
  ``args.items[0].mode`` (the §6 path format, same as the template validator).
* **Semantics** — read-only / idempotent / cancellable, read from
  :meth:`tools.registry.ToolRegistry.get_tool_semantics` (the ``ToolEntry``
  fields landed with #47). ``retry_safe`` is the executor's contract: a
  side-effecting, non-idempotent tool must never be silently retried, and
  ``cancellable=False`` means Stop cannot promise the external operation was
  undone (UI shows that honestly).

Both functions take injection seams like :mod:`hermes_cli.pipeline_template`
so the real Hermes adapter (#34) can substitute its own registry view without
touching this module.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, List, Mapping, Optional

from jsonschema import Draft202012Validator

from hermes_cli.pipeline_template import TemplateError, _json_path

__all__ = [
    "ToolSemantics",
    "registered_tool_schema", "validate_tool_args", "tool_step_semantics",
]


# --- Seams (mirroring pipeline_template's tool_available pattern) -------------

def registered_tool_schema(tool_id: str) -> Optional[Mapping[str, Any]]:
    """The registered tool's ``parameters`` JSON Schema, or ``None`` when the
    tool is unknown. Injectable replacement lives in :func:`validate_tool_args`.

    A tool that exists in this install but has not been imported yet is not
    unknown -- it is undiscovered, and reporting "not registered" sends the
    author hunting for a typo that is not there. Discovery is memoized on disk,
    so the extra call is a cache read after the first time.
    """
    from tools.registry import registry
    schema = registry.get_schema(tool_id)
    if schema is None:
        try:
            from tools.registry import discover_builtin_tools

            discover_builtin_tools()
            schema = registry.get_schema(tool_id)
        except Exception:  # pragma: no cover - discovery must never fail a step
            pass
    if not isinstance(schema, dict):
        return None
    params = schema.get("parameters")
    return params if isinstance(params, dict) else {}


def _default_semantics_reader(tool_id: str) -> Optional[dict]:
    from tools.registry import registry
    return registry.get_tool_semantics(tool_id)


# --- Arg validation ------------------------------------------------------------

def validate_tool_args(
    tool_id: str, args: Any, *,
    schema_for: Optional[Callable[[str], Optional[Mapping[str, Any]]]] = None,
    tool_available: Optional[Callable[[str], bool]] = None,
) -> List[TemplateError]:
    """Validate a tool step's ``args`` against the registered input schema.

    An unknown tool is a readiness fact, not a validation error (spec §6, same
    split as :func:`hermes_cli.pipeline_template.unavailable_tool_ids`), so it
    is reported here only when the caller passes ``tool_available`` — the
    executor resolves that separately and skips validation for missing tools.
    Returns findings as :class:`~hermes_cli.pipeline_template.TemplateError`;
    an empty list means the args may be handed to the handler.
    """
    errors: List[TemplateError] = []
    if tool_available is not None and not tool_available(tool_id):
        return errors
    lookup = schema_for if schema_for is not None else registered_tool_schema
    schema = lookup(tool_id)
    if schema is None:
        errors.append(TemplateError("tool", f"tool '{tool_id}' is not registered"))
        return errors
    if not isinstance(args, Mapping):
        errors.append(TemplateError("args", f"args must be an object, got {type(args).__name__}"))
        return errors
    root = "args"
    for err in Draft202012Validator(dict(schema)).iter_errors(dict(args)):
        parts = tuple(err.absolute_path)
        path = root if not parts else f"{root}.{_json_path(parts)}"
        errors.append(TemplateError(path, err.message))
    return errors


# --- Semantics -------------------------------------------------------------------

@dataclass(frozen=True)
class ToolSemantics:
    """Spec §8 properties of one tool, plus the executor's derived contract."""

    tool_id: str
    read_only: bool
    idempotent: bool
    cancellable: bool

    @property
    def retry_safe(self) -> bool:
        """Silent retries allowed only for read-only or declared-idempotent tools."""
        return self.read_only or self.idempotent


def tool_step_semantics(
    tool_id: str, *,
    semantics_reader: Optional[Callable[[str], Optional[dict]]] = None,
) -> Optional[ToolSemantics]:
    """Read a tool's execution semantics; ``None`` when the tool is unknown
    (readiness — the executor refuses to run the step, like an unavailable
    profile). A known tool with no declared properties is conservatively
    side-effecting and non-idempotent: ``retry_safe`` is False."""
    read = semantics_reader if semantics_reader is not None else _default_semantics_reader
    raw = read(tool_id)
    if raw is None:
        return None
    return ToolSemantics(
        tool_id=tool_id,
        read_only=bool(raw.get("read_only")),
        idempotent=bool(raw.get("idempotent")),
        cancellable=bool(raw.get("cancellable")),
    )
