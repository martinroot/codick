"""#63 — a registered tool is not an available tool.

``image_generate`` is registered in every install and its ``check_fn`` returns
False unless a provider is configured. Readiness that asks only "is it
registered?" therefore calls such a template ``ready`` — and the failure then
lands at the tool step, with the customer's money already taken. That is the
exact failure ``pipeline_readiness`` exists to prevent, and it was reachable
through its own front door.
"""

import pytest

from hermes_cli import pipeline_readiness as readiness


def with_tool(name):
    # `type`, not `kind`. A step spelled with the wrong key contributes no
    # requirements at all, and a template then reports ready for having no tools.
    return {"steps": [{"id": "art", "type": "tool", "tool": name}]}


def always(_name):
    return True


def never(_name):
    return False


def one_off(target):
    def check(name):
        return name != target

    return check


def raises(_name):
    """A checker that crashes outright, not a factory returning one — passing a
    factory would hand back a truthy function and read as "available"."""
    raise RuntimeError("provider probe exploded")


# --- the gap this closes ------------------------------------------------------


def test_a_tool_the_reader_found_registered_is_never_also_called_unavailable():
    """One verdict must not contain both halves.

    The reader and the checker used to consult the registry differently: the
    reader ran discovery and the checker did not, so a tool whose module had not
    been imported in this process came back "registered but not available" --
    the reader having just said it was registered. The checker now discovers too,
    and this pins the coherence rather than the mechanism.
    """
    from hermes_cli.pipeline_readiness import assess_readiness

    verdict = assess_readiness(
        with_tool("documents.export_docx"),
        tool_names={"documents.export_docx"},
    )
    assert verdict["readiness_status"] == "ready", verdict["readiness_detail"]


def test_a_registered_but_unusable_tool_is_not_ready():
    result = readiness.assess_readiness(
        with_tool("image_generate"), tool_names={"image_generate"}, checker=never,
    )
    assert result["readiness_status"] == readiness.READINESS_UNAVAILABLE


def test_the_detail_names_the_tool_and_the_reason():
    result = readiness.assess_readiness(
        with_tool("image_generate"), tool_names={"image_generate"}, checker=never,
    )
    detail = " ".join(result["readiness_detail"])
    assert "image_generate" in detail
    assert "not available" in detail
    assert "not registered" not in detail, "it *is* registered; the wrong reason misleads"


def test_registered_and_available_is_ready():
    result = readiness.assess_readiness(
        with_tool("image_generate"), tool_names={"image_generate"}, checker=always,
    )
    assert result == {"readiness_status": readiness.READINESS_READY,
                      "readiness_detail": None}


# --- a probe that cannot answer has not said yes ------------------------------


def test_a_raising_check_is_unavailable_not_fine():
    """A crashed probe knows nothing. Treating it as available re-creates the
    sale-then-fail path, and does it silently."""
    result = readiness.assess_readiness(
        with_tool("image_generate"), tool_names={"image_generate"}, checker=raises,
    )
    assert result["readiness_status"] == readiness.READINESS_UNAVAILABLE


# --- both kinds of absence, reported separately -------------------------------


def test_missing_and_unavailable_are_both_reported_with_their_own_reasons():
    template = {
        "steps": [
            {"id": "a", "type": "tool", "tool": "no_such_tool"},
            {"id": "b", "type": "tool", "tool": "image_generate"},
        ]
    }
    result = readiness.assess_readiness(
        template, tool_names={"image_generate"}, checker=never,
    )
    detail = " ".join(result["readiness_detail"])
    assert "no_such_tool" in detail and "not registered" in detail
    assert "image_generate" in detail and "not available" in detail


def test_unavailable_tools_does_not_double_report_a_missing_one():
    """A missing tool is reported as missing only; listing it twice under a
    second reason makes an author fix the same thing twice."""
    assert readiness.unavailable_tools(
        with_tool("no_such_tool"), tool_names={"other"}, checker=never,
    ) == []


# --- unknown stays unknown ----------------------------------------------------


def test_an_unreadable_registry_does_not_call_everything_unavailable():
    def broken_reader():
        raise RuntimeError("registry is on fire")

    assert readiness.unavailable_tools(
        with_tool("image_generate"), reader=broken_reader, checker=never,
    ) == []


def test_a_none_registry_view_does_not_call_everything_unavailable():
    assert readiness.unavailable_tools(
        with_tool("image_generate"), tool_names=None,
        reader=lambda: None, checker=never,
    ) == []


# --- templates with nothing to check ------------------------------------------


def test_a_template_with_no_tool_steps_is_unaffected():
    result = readiness.assess_readiness({"steps": [{"id": "a", "type": "llm"}]},
                                        tool_names=set(), checker=never)
    assert result["readiness_status"] == readiness.READINESS_READY


# --- against the real registry ------------------------------------------------


def test_the_real_registry_answers_for_image_generate():
    """No credentials are set up here, so the honest answer must be 'not
    available'. If this ever reports ready, the probe is not being consulted."""
    from tools.registry import discover_builtin_tools, registry

    discover_builtin_tools()
    entry = registry.get_entry("image_generate")
    assert entry is not None, "the tool should still be registered"
    assert entry.check_fn is not None, "otherwise availability is never consulted"
    result = readiness.assess_readiness(with_tool("image_generate"))
    assert result["readiness_status"] == readiness.READINESS_UNAVAILABLE
    assert "not available" in " ".join(result["readiness_detail"])


def test_the_real_registry_says_docx_is_available():
    """A real stdlib tool with no provider behind it must stay sellable, or the
    availability check has gone and taken the working tools with it."""
    result = readiness.assess_readiness(with_tool("documents.export_docx"))
    assert result["readiness_status"] == readiness.READINESS_READY