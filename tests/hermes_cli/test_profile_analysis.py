"""Profile analysis: the report behind the console's "Analyze" button.

The properties asserted here are the ones that make the report trustworthy, not
its shape — a test that pins "the payload has a `structure` key" would pass
against an implementation that reports nothing at all.
"""

from __future__ import annotations

import importlib.util
import textwrap
from pathlib import Path

import pytest

from hermes_cli import profile_analysis
from hermes_cli.pipeline_readiness import (
    TOOL_CHECK_FAILED, TOOL_NOT_REGISTERED, assess_readiness, tool_availability)


# ── tool_availability: the shared classification ──────────────────────────────

def test_unavailable_names_its_reason_not_just_the_tool():
    rows = tool_availability(["terminal"], tool_names={"read_file"}, checker=lambda n: True)
    assert [r["tool"] for r in rows] == ["terminal"]
    assert rows[0]["status"] == TOOL_NOT_REGISTERED
    assert "not registered" in rows[0]["reason"]


def test_registered_but_unavailable_is_a_different_verdict():
    """The distinction the whole module exists for: ``image_generation`` is always
    registered and always fails its check_fn until a provider is configured."""
    rows = tool_availability(["image_generation"], tool_names={"image_generation"},
                             checker=lambda n: False)
    assert rows[0]["status"] == TOOL_CHECK_FAILED
    assert "not registered" not in rows[0]["reason"]


def test_a_checker_that_raises_is_never_yes():
    def boom(_name):
        raise RuntimeError("probe exploded")

    rows = tool_availability(["terminal"], tool_names={"terminal"}, checker=boom)
    assert rows[0]["status"] == TOOL_CHECK_FAILED


def test_an_unreadable_registry_reports_nothing_not_everything():
    """Unknown is not empty. Reporting every tool as missing makes a healthy
    profile look broken for a reason that has nothing to do with it."""
    def broken():
        raise RuntimeError("registry unavailable")

    assert tool_availability(["terminal", "web_search"], reader=broken) == []
    assert tool_availability(["terminal"], tool_names=None) == []


def test_usable_tools_produce_no_rows():
    assert tool_availability(["a", "b"], tool_names={"a", "b"}, checker=lambda n: True) == []


def test_template_verdict_is_rendered_from_the_same_rows():
    """Two implementations of 'available' drift, and then the marketplace and the
    console disagree about the same install."""
    template = {"steps": [{"type": "tool", "tool": "ghost"}]}
    verdict = assess_readiness(template, tool_names={"read_file"}, checker=lambda n: True)
    rows = tool_availability(["ghost"], tool_names={"read_file"}, checker=lambda n: True)
    assert verdict["readiness_status"] == "unavailable"
    assert verdict["readiness_detail"] == [rows[0]["reason"]]


# ── structure ─────────────────────────────────────────────────────────────────

def test_missing_profile_directory_is_a_finding_not_an_empty_report(tmp_path):
    rows = profile_analysis.analyze_structure(tmp_path / "does-not-exist")
    assert [r["ok"] for r in rows] == [False]
    assert "does not exist" in rows[0]["detail"]


def test_a_bare_directory_is_not_a_profile(tmp_path):
    """A directory with no identity file is not treated as a profile, and the report
    says which of the six markers are missing rather than staying quiet."""
    (tmp_path / "notes.txt").write_text("hello")
    rows = profile_analysis.analyze_structure(tmp_path)
    marker = next(r for r in rows if r["name"] == "identity_marker")
    assert marker["ok"] is False


def test_absent_config_and_env_are_context_not_defects(tmp_path):
    """Defaults apply when config.yaml is missing; keys can come from elsewhere. A
    profile with neither is a normal profile — as long as something marks it as one."""
    (tmp_path / "profile.yaml").write_text("name: demo\n")
    rows = {r["name"]: r for r in profile_analysis.analyze_structure(tmp_path)}
    assert rows["config.yaml"]["ok"] is True
    assert rows[".env"]["ok"] is True


_HAS_YAML = importlib.util.find_spec("yaml") is not None


@pytest.mark.skipif(not _HAS_YAML, reason="PyYAML is optional and absent from the hermetic environment")
def test_unparseable_config_is_reported(tmp_path):
    (tmp_path / "config.yaml").write_text("model: [unclosed\n")
    (tmp_path / ".env").write_text("OPENROUTER_API_KEY=sk-x\n")
    rows = {r["name"]: r for r in profile_analysis.analyze_structure(tmp_path)}
    assert rows["config.yaml"]["ok"] is False


@pytest.mark.skipif(not _HAS_YAML, reason="PyYAML is optional and absent from the hermetic environment")
def test_config_top_level_that_is_not_a_mapping_is_reported(tmp_path):
    (tmp_path / "config.yaml").write_text("- just\n- a\n- list\n")
    rows = {r["name"]: r for r in profile_analysis.analyze_structure(tmp_path)}
    assert rows["config.yaml"]["ok"] is False


def test_a_missing_yaml_parser_is_not_reported_as_a_broken_config():
    """The hermetic test environment has no PyYAML. Reporting that as "does not
    parse" would accuse a healthy profile's config for the sake of an import —
    even text that is obviously valid."""
    if _HAS_YAML:
        pytest.skip("PyYAML is installed here, so the missing-parser branch cannot be reached")
    ok, detail = profile_analysis._yaml_verdict("model: [unclosed\n")
    assert ok is True
    assert "not parsed" in detail


def test_env_assignment_count_ignores_comments_and_blanks(tmp_path):
    (tmp_path / ".env").write_text("# a comment\n\nKEY=1\n\nOTHER = 2\n")
    rows = {r["name"]: r for r in profile_analysis.analyze_structure(tmp_path)}
    assert rows[".env"]["ok"] is True
    assert rows[".env"]["detail"] == "2 assignment(s)"


# ── skills ────────────────────────────────────────────────────────────────────

def _write_skill(skills_dir: Path, name: str, body: str, frontmatter: str = "") -> Path:
    target = skills_dir / name
    target.mkdir(parents=True, exist_ok=True)
    front = frontmatter or "name: x\ndescription: d\n"
    (target / "SKILL.md").write_text(f"---\n{front}---\n\n{body}\n", encoding="utf-8")
    return target / "SKILL.md"


def test_a_skill_with_a_dangling_reference_is_flagged(tmp_path):
    skills = tmp_path / "skills"
    skill_md = _write_skill(skills, "demo", textwrap.dedent("""
        # Demo

        See [notes](references/notes.md) for details.
        """))
    rows, _ = profile_analysis.analyze_skills(tmp_path)
    entry = next(r for r in rows if r["name"] == "demo")
    # The linter owns the rule; this asserts the report surfaces its verdict rather
    # than re-implementing it.
    from tools.skill_linter import lint_skill

    expected = [f.severity for f in lint_skill(skill_md)]
    assert (entry["ok"] is False) == ("ERROR" in expected)


def test_only_this_profiles_skills_are_considered(tmp_path):
    """A skill installed under another profile is not this profile's capability."""
    other = tmp_path / "elsewhere" / "skills"
    _write_skill(other, "borrowed", "body")
    rows, required = profile_analysis.analyze_skills(tmp_path)
    assert rows == []
    assert required == []


def test_skill_declared_tools_are_collected(tmp_path):
    skills = tmp_path / "skills"
    _write_skill(skills, "withtools", "body",
                 frontmatter="name: withtools\ndescription: d\ntools: [terminal, web_search]\n")
    _, required = profile_analysis.analyze_skills(tmp_path)
    assert required == ["terminal", "web_search"]


def test_a_missing_declared_binary_is_named(tmp_path):
    skills = tmp_path / "skills"
    _write_skill(skills, "needsbinary", "body",
                 frontmatter="name: needsbinary\ndescription: d\nbinaries: [definitely-not-installed-xyz]\n")
    rows, _ = profile_analysis.analyze_skills(tmp_path)
    binary = next(r for r in rows if r["kind"] == "binary")
    assert binary["ok"] is False
    assert "definitely-not-installed-xyz" in binary["name"]


def test_nested_skills_are_named_by_their_path(tmp_path):
    skills = tmp_path / "skills"
    _write_skill(skills / "productivity", "notes", "body")
    rows, _ = profile_analysis.analyze_skills(tmp_path)
    assert [r["name"] for r in rows] == ["productivity/notes"]


# ── the whole report ──────────────────────────────────────────────────────────

def test_report_is_read_only_and_repeatable(tmp_path, monkeypatch):
    """The acceptance rule: two calls on an unchanged profile return the same report.

    This is also the test that caught the real bug: `load_config()` bootstraps
    `SOUL.md` into the profile on first read, which had made the second call
    report an identity marker the first one had not seen.
    """
    (tmp_path / "config.yaml").write_text("model: {}\n")
    monkeypatch.setattr(profile_analysis, "_enabled_toolset_tools", lambda _d: (["ghost_tool"], []))
    first = profile_analysis.analyze_profile(tmp_path)
    second = profile_analysis.analyze_profile(tmp_path)
    assert first == second
    assert first["read_only"] is True


def test_a_bootstrapped_soul_is_not_mistaken_for_an_identity(tmp_path, monkeypatch):
    """Reading config creates an empty SOUL.md. It is not evidence of a profile."""
    monkeypatch.setattr(profile_analysis, "_enabled_toolset_tools", lambda _d: ([], []))
    profile_analysis.analyze_profile(tmp_path)
    assert (tmp_path / "SOUL.md").exists(), "load_config bootstraps this"
    report = profile_analysis.analyze_profile(tmp_path)
    marker = next(r for r in report["structure"] if r["name"] == "identity_marker")
    assert marker["ok"] is False


def test_report_names_the_unavailable_tool_with_a_reason(tmp_path, monkeypatch):
    monkeypatch.setattr(profile_analysis, "_enabled_toolset_tools", lambda _d: (["ghost_tool"], []))
    report = profile_analysis.analyze_profile(tmp_path)
    assert report["ok"] is False
    assert report["finding_count"] >= 1
    entry = next(r for r in report["readiness"]["unavailable"] if r["name"] == "ghost_tool")
    assert entry["detail"]
    assert "ghost_tool" in entry["detail"]


def test_a_healthy_profile_reports_no_findings(tmp_path, monkeypatch):
    monkeypatch.setattr(profile_analysis, "_enabled_toolset_tools", lambda _d: (["terminal"], []))
    (tmp_path / "config.yaml").write_text("model: {}\n")
    (tmp_path / ".env").write_text("K=1\n")
    report = profile_analysis.analyze_profile(tmp_path)
    assert report["finding_count"] == 0, report
    assert report["ok"] is True


def test_disabled_toolsets_are_context_not_findings(tmp_path, monkeypatch):
    (tmp_path / "config.yaml").write_text("model: {}\n")
    monkeypatch.setattr(
        profile_analysis, "_enabled_toolset_tools",
        lambda _d: ([], [{"toolset": "browser", "reason": "not enabled for this platform"}]))
    report = profile_analysis.analyze_profile(tmp_path)
    assert report["ok"] is True
    assert report["readiness"]["disabled_toolsets"][0]["toolset"] == "browser"


def test_mcp_servers_are_reported_without_inventing_tool_names(tmp_path, monkeypatch):
    """A server declares no tools in the config; naming unregistered ones would
    manufacture findings out of nothing."""
    (tmp_path / "config.yaml").write_text(
        "mcp_servers:\n  docs:\n    url: https://example.test/mcp\n  local:\n    command: npx\n")

    def _fake_tools(_dir):
        return [], []

    monkeypatch.setattr(profile_analysis, "_enabled_toolset_tools", _fake_tools)
    report = profile_analysis.analyze_profile(tmp_path)
    servers = {s["name"]: s for s in report["readiness"]["mcp_servers"]}
    assert servers["docs"]["transport"] == "http"
    assert servers["local"]["transport"] == "stdio"
    # No tool rows were manufactured from the server list.
    assert all(r["kind"] != "tool" for r in report["readiness"]["unavailable"])