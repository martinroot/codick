"""Import readiness (spec §6, #30, #34).

A template reports `ready` today because nothing computes it. These tests pin the
computation, and they take the registry as a set of names — the tool-step layer
already documents that seam for the real adapter.
"""

import os
import sys

import pytest

from hermes_cli.pipeline_readiness import (
    READINESS_READY,
    READINESS_UNAVAILABLE,
    assess_readiness,
    missing_tools,
    required_tool_names,
)


def tpl(*steps):
    return {"schema_version": "1", "id": "t", "start_step": "s", "steps": list(steps)}


TOOL_STEP = {"id": "s", "type": "tool", "tool": "documents.export_docx"}
AGENT_STEP = {"id": "s", "type": "agent"}


def test_a_template_that_needs_nothing_is_ready():
    assert assess_readiness(tpl(AGENT_STEP), tool_names={"terminal"})["readiness_status"] == READINESS_READY


def test_a_missing_tool_makes_the_template_unavailable_with_its_name():
    # The reason is the message. "Not available" leaves an author with nothing to
    # act on, and a catalogue entry with no reason is an entry nobody can fix.
    verdict = assess_readiness(tpl(TOOL_STEP), tool_names={"terminal", "read_file"})
    assert verdict["readiness_status"] == READINESS_UNAVAILABLE
    assert verdict["readiness_detail"] == [
        "tool 'documents.export_docx' is not registered in this install"
    ]


def test_a_registered_and_available_tool_leaves_it_ready():
    """Both questions, answered yes.

    The checker is injected so the test says what it means. Without it this
    resolves against the real registry, and it stops being a test of readiness
    at all -- it becomes a test of whether this machine happens to have a DOCX
    provider configured, which is #63's subject and lives in
    ``test_pipeline_readiness_availability.py``.
    """
    verdict = assess_readiness(
        tpl(TOOL_STEP), tool_names={"documents.export_docx"},
        checker=lambda name: True,
    )
    assert verdict["readiness_status"] == READINESS_READY
    assert verdict["readiness_detail"] is None


def test_a_registered_but_unavailable_tool_is_not_ready():
    """The distinction #63 exists for, in the module that grew it."""
    verdict = assess_readiness(
        tpl(TOOL_STEP), tool_names={"documents.export_docx"},
        checker=lambda name: False,
    )
    assert verdict["readiness_status"] == READINESS_UNAVAILABLE
    assert "registered but not available" in verdict["readiness_detail"][0]


def test_detail_is_a_list_or_none_never_a_bare_string():
    # The column is parsed back as JSON, so a string here reads back as a truthy
    # string and then fails to iterate.
    for names in ({"terminal"}, set()):
        detail = assess_readiness(tpl(TOOL_STEP), tool_names=names)["readiness_detail"]
        assert detail is None or isinstance(detail, list)


def test_an_unreadable_registry_does_not_take_the_catalogue_offline():
    # None means *unknown*, which is not *empty*. Marking every template
    # unavailable because an import failed would hide the whole catalogue for a
    # reason that has nothing to do with any template.
    def broken():
        raise RuntimeError("registry is having a bad day")

    assert missing_tools(tpl(TOOL_STEP), tool_names=None, reader=broken) == []
    assert assess_readiness(tpl(TOOL_STEP), tool_names=None, reader=broken)[
        "readiness_status"
    ] == READINESS_READY


def test_only_tool_steps_contribute_a_requirement():
    # An agent step has no tool; an arbitrary string in some other field must not
    # be read as a missing tool and take the template down.
    assert required_tool_names(tpl(AGENT_STEP, {"id": "u", "type": "user_input"})) == []


def test_required_names_are_distinct_and_in_first_seen_order():
    steps = (
        {"id": "a", "type": "tool", "tool": "b_tool"},
        {"id": "b", "type": "tool", "tool": "a_tool"},
        {"id": "c", "type": "tool", "tool": "b_tool"},
    )
    assert required_tool_names(tpl(*steps)) == ["b_tool", "a_tool"]


def test_a_step_with_a_blank_tool_name_is_not_a_requirement():
    # "" is not a tool, and reporting "tool '' is not registered" is noise.
    assert required_tool_names(tpl({"id": "a", "type": "tool", "tool": "  "})) == []


def test_every_missing_tool_is_reported_not_just_the_first():
    steps = (
        {"id": "a", "type": "tool", "tool": "one"},
        {"id": "b", "type": "tool", "tool": "two"},
    )
    verdict = assess_readiness(tpl(*steps), tool_names=set())
    assert verdict["readiness_detail"] == [
        "tool 'one' is not registered in this install",
        "tool 'two' is not registered in this install",
    ]


def test_a_template_with_no_steps_is_not_a_catalogue_outage():
    assert assess_readiness({"steps": []}, tool_names=set())["readiness_status"] == READINESS_READY
    assert assess_readiness({}, tool_names=set())["readiness_status"] == READINESS_READY


def test_readiness_bootstraps_discovery_rather_than_trusting_an_empty_registry():
    """The probe must not report a template `unavailable` because nothing
    imported `model_tools` yet.

    `discover_builtin_tools()` runs at `model_tools` import time. A caller that
    has not imported it sees an empty registry — and a readiness check that
    trusted that empty registry would mark every template needing a tool as
    unavailable, which is the exact failure this module exists to prevent,
    produced by its own probe. Run in a subprocess because this test file's
    imports have already populated the registry.
    """
    import subprocess

    script = (
        "import json, sys; sys.path.insert(0, %r);"
        "from hermes_cli.pipeline_readiness import assess_readiness;"
        "print(assess_readiness(json.load(open(%r)))['readiness_status'])"
        % (
            os.path.join(os.path.dirname(__file__), "..", ".."),
            os.path.join(os.path.dirname(__file__), "scenarios", "word-report.json"),
        )
    )
    out = subprocess.run([sys.executable, "-c", script], capture_output=True,
                         text=True, timeout=180)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "ready", out.stdout


def test_an_incomplete_registry_is_still_completed_by_discovery(monkeypatch):
    """Discovery runs every time, because a non-empty registry is not a complete one.

    The first version bootstrapped only on an empty registry. That made the
    verdict depend on import order: a registry that was populated but missing a
    tool reported that tool as unregistered, and the same template was `ready`
    or `unavailable` depending on which test had run first.

    Re-running is safe because discovery re-imports its modules and `sys.modules`
    stops an already-imported module from executing its body again — so nothing
    registers twice. The assertion below is the point: the tool appears after
    the call, and is still there on a second call.
    """
    import tools.registry as registry_module

    calls = []
    real = registry_module.discover_builtin_tools

    def counting(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(registry_module, "discover_builtin_tools", counting)

    from hermes_cli.pipeline_readiness import _default_tool_names

    _default_tool_names()
    _default_tool_names()
    assert len(calls) == 2, (
        "discovery must run on every read: a non-empty registry is not a "
        f"complete one, and a bootstrap-on-empty rule made the verdict depend on "
        f"import order (saw {len(calls)} call(s) for two reads)"
    )


def test_repeated_discovery_does_not_disturb_the_registry(monkeypatch):
    """The reason unconditional discovery is safe, asserted rather than assumed.

    Discovery re-imports tool modules; `sys.modules` is what stops an
    already-imported module from executing its `register()` again. If that ever
    stopped being true, the tool list would grow on every readiness check.
    """
    from tools.registry import registry

    from hermes_cli.pipeline_readiness import _default_tool_names

    first = _default_tool_names()
    second = _default_tool_names()
    assert first == second, (len(first), len(second))
    assert set(registry.get_all_tool_names()) == second
