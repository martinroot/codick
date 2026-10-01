""" Whether a template can actually run here (spec §6, #30, #34).

## Why this exists, in the marketplace's terms

``readiness_status`` lives on the stored template and used to be *read* but never
*computed*, so every template reported ``ready``. A template whose ``tool`` step
names a tool that is not registered would therefore be listed as available, sold,
paid for, and would fail at the tool step — with the customer's money already
taken. For a catalogue, "available" has to mean available.

## The source of truth is the registry, not a list

The tool names come from ``registry.get_all_tool_names()`` — what is actually
registered in this process — rather than a hand-maintained allowlist. A list would
drift the first time a tool is added or a plugin is unloaded, and a template
marked unavailable for a tool that *is* present is worse than no check at all:
it hides a sellable service.

## The reason is the message

A template that cannot run here says **which** tool is missing, by name. "Not
available" would leave an author with nothing to act on, and a marketplace
listing with no reason is a listing nobody can fix.

## No tools, no opinion

A template with no ``tool`` steps is ``ready`` on the strength of this check
alone. The executor's other requirements — profiles, the adapter — are the
adapter's business, and reporting them here would mean guessing.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Mapping, Optional

logger = logging.getLogger(__name__)

READINESS_READY = "ready"
READINESS_UNAVAILABLE = "unavailable"


def _default_tool_names() -> Optional[set]:
    """The registered tool names, or ``None`` when the registry cannot be read.

    Discovery is run here rather than assumed. ``discover_builtin_tools`` runs at
    ``model_tools`` import time, and a caller that has not imported that — a
    plain script, a route that only touches the pipeline DB — sees an empty
    registry and would report every template that needs a tool as
    ``unavailable``. That is the failure this whole module exists to prevent,
    produced by its own probe.

    **Discovery runs every time, not only when the registry is empty.** An
    earlier version bootstrapped on emptiness alone, and that made the verdict
    depend on import order: a registry that was non-empty but *incomplete*
    (discovery having run in a process where some tool module was not yet
    importable) reported a registered tool as missing. Callers got a different
    answer for the same template depending on which test ran first, which is
    the same class of bug in the opposite direction.

    Re-running is safe and cheap: discovery re-``imports`` its modules, and
    ``sys.modules`` means an already-imported module does not execute its body
    again, so nothing registers twice. Its per-file AST scan is memoised on
    disk by ``(mtime_ns, size)``, so the repeat is a cache read.
    """
    from tools.registry import discover_builtin_tools, registry

    try:
        discover_builtin_tools()
        names = set(registry.get_all_tool_names())
    except Exception:  # noqa: BLE001 - reported as unknown, never as a verdict
        logger.debug("readiness could not read the tool registry", exc_info=True)
        return None
    return names


def required_tool_names(template: Mapping[str, Any]) -> List[str]:
    """The distinct tools a template's ``tool`` steps ask for, in first-seen order.

    Ordered so the reason a template is unavailable reads the same way twice.
    """
    steps = template.get("steps")
    if not isinstance(steps, list):
        return []
    names: List[str] = []
    seen = set()
    for step in steps:
        if not isinstance(step, Mapping) or step.get("type") != "tool":
            continue
        name = step.get("tool")
        if not isinstance(name, str) or not name.strip():
            continue
        if name not in seen:
            seen.add(name)
            names.append(name)
    return names


def missing_tools(
    template: Mapping[str, Any],
    tool_names: Optional[set] = None,
    reader: Callable[[], Optional[set]] = _default_tool_names,
) -> List[str]:
    """The tools this template needs that are not registered.

    Takes the registry as data so a test can pass a set instead of standing up
    the real registry — and so the real adapter can substitute its own view,
    which is the seam the tool-step layer already documents.

    An unreadable registry yields no missing tools rather than a full list of
    them: *unknown* is not *empty*, and reporting every tool as missing is how a
    catalogue goes dark for a reason that has nothing to do with any template.
    """
    if tool_names is None:
        # A reader that raises is the failure this whole module exists to keep
        # off the catalogue, so the guard belongs here — at the consumer — rather
        # than only inside the default reader. A caller who injects a broken view
        # gets the same protection as one who has no registry at all.
        try:
            tool_names = reader()
        except Exception:
            return []
    if tool_names is None:
        return []
    return [name for name in required_tool_names(template) if name not in tool_names]


def assess_readiness(
    template: Mapping[str, Any],
    tool_names: Optional[set] = None,
    reader: Callable[[], Optional[set]] = _default_tool_names,
) -> Dict[str, Any]:
    """``{"readiness_status": ..., "readiness_detail": [...]}`` for a template.

    ``readiness_detail`` is a list even when the status is ``ready``: the column
    is parsed back as JSON, so a string here would be read back as a truthy
    string and then fail to iterate.
    """
    missing = missing_tools(template, tool_names, reader)
    if not missing:
        return {"readiness_status": READINESS_READY, "readiness_detail": None}
    return {
        "readiness_status": READINESS_UNAVAILABLE,
        "readiness_detail": [
            f"tool {name!r} is not registered in this install" for name in missing
        ],
    }
