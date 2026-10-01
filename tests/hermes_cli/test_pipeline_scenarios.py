"""The two documented scenarios, loaded from the files the docs point at.

Documentation with an example that does not run is worse than documentation
without one, so these are not copies of the examples — they *are* the examples,
and `docs/pipelines/format.md` links to these paths.
"""

from __future__ import annotations

import json
import os

import pytest

from hermes_cli.pipeline_readiness import assess_readiness
from hermes_cli.pipeline_template import validate_template

SCENARIOS = os.path.join(os.path.dirname(__file__), "scenarios")


def _load(name: str) -> dict:
    with open(os.path.join(SCENARIOS, name), encoding="utf-8") as handle:
        return json.load(handle)


@pytest.mark.parametrize("name", ["word-report.json", "inbox-triage.json"])
def test_the_documented_scenarios_are_valid(name):
    assert validate_template(_load(name)) == []


@pytest.mark.parametrize("name", ["word-report.json", "inbox-triage.json"])
def test_the_documented_scenarios_are_ready_on_this_install(name):
    """A documented scenario that is `unavailable` here is a broken example."""
    readiness = assess_readiness(_load(name))
    assert readiness["readiness_status"] == "ready", readiness["readiness_detail"]


def test_the_word_scenario_uses_the_tool_that_exists():
    """`documents.export_docx` is the id spec §8 names and the one that ships."""
    steps = _load("word-report.json")["steps"]
    tools = [s["tool"] for s in steps if s["type"] == "tool"]
    assert tools == ["documents.export_docx"]


def test_the_word_scenario_has_a_rework_branch_and_a_person():
    """Both halves #35 asks a demo to include, present in the shipped example."""
    template = _load("word-report.json")
    ids = {s["id"]: s for s in template["steps"]}
    assert ids["approve"]["type"] == "user_input", "one external input"
    rework = [c for c in ids["gate"]["cases"] if c.get("rework")]
    assert rework, "one rework return after review"


def test_the_triage_scenario_needs_no_external_tool():
    """The shape a marketplace template can actually be sold as today."""
    template = _load("inbox-triage.json")
    assert not [s for s in template["steps"] if s["type"] == "tool"]


def test_every_ref_in_the_documented_scenarios_points_at_something_real():
    """A dangling ref validates lazily and fails at run time, which is the
    worst moment to discover it."""
    for name in ("word-report.json", "inbox-triage.json"):
        template = _load(name)
        ids = {s["id"] for s in template["steps"]}
        for step in template["steps"]:
            for target in _refs(step.get("input", {})):
                parts = target.split(".")
                if parts[0] != "steps":
                    continue
                assert parts[1] in ids, f"{name}: {step['id']} reads from unknown step {parts[1]!r}"
            nxt = step.get("next")
            if isinstance(nxt, str) and nxt:
                assert nxt in ids, f"{name}: {step['id']} transitions to unknown step {nxt!r}"
            if step["type"] == "condition":
                for case in step.get("cases", []):
                    target = case.get("next")
                    if isinstance(target, str) and target:
                        assert target in ids, f"{name}: case transitions to unknown {target!r}"


def _refs(value):
    if isinstance(value, dict):
        if isinstance(value.get("ref"), str):
            yield value["ref"]
        for inner in value.values():
            yield from _refs(inner)
    elif isinstance(value, list):
        for inner in value:
            yield from _refs(inner)