"""Import readiness (spec §6, #30, #34).

A template reports `ready` today because nothing computes it. These tests pin the
computation, and they take the registry as a set of names — the tool-step layer
already documents that seam for the real adapter.
"""

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


def test_a_registered_tool_leaves_it_ready():
    verdict = assess_readiness(
        tpl(TOOL_STEP), tool_names={"documents.export_docx"}
    )
    assert verdict["readiness_status"] == READINESS_READY
    assert verdict["readiness_detail"] is None


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
