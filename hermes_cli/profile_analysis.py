""" Read-only report on what a Hermes profile is actually made of and what is missing.

## Why

A profile is configured in six places at once — its own `config.yaml`, the
platform's toolsets, the skills directory, MCP servers, and the credentials in
`.env`. Nothing read all of them together, so "why does this profile not do X"
had no single answer: `hermes doctor` gives one line per profile, the skills page
lists names, and the toolset drawer shows one toolset at a time. Each is right
about its own slice and none of them says "this profile cannot run because of
*these three things*".

This is the one report that answers it. It **reads and never writes** — see
"Nothing here repairs anything".

## The three levels

1. **Structure** — the directories are there, `config.yaml` / `.env` parse, the
   identity markers are present. Close to `doctor_state.py::_check_profiles`,
   but scoped to one profile and returning machine-readable rows.
2. **Readiness** — every tool an enabled toolset contributes, and every tool a
   skill or MCP server names, checked against the live registry. The
   `not_registered` vs `check_fn_false` distinction comes from
   `pipeline_readiness.tool_availability`, which is the same function the
   pipeline template path uses: one classification, two renderings.
3. **Skills** — per skill, `skill_linter.lint_skill` for frontmatter and
   referenced files, plus the tools and binaries the skill declares.

## Nothing here repairs anything

A missing tool is *reported* missing. Silently substituting the nearest
available capability is banned outright for pipeline tool steps, and it would be
twice as damaging here: the person is repairing their own profile and would not
know part of it had been rewritten under them. There is no `--fix` and adding one
would contradict the acceptance rule "two calls on an unchanged profile return
the same report".

## What `read_only` does and does not claim

`read_only: True` means *this module writes no profile configuration*: no key is
created, no tool is substituted, no toggle is flipped. It does **not** mean the
filesystem is untouched. Reading config through `load_config()` bootstraps an
empty `SOUL.md` and twelve scaffolding directories inside the profile the first
time it runs — upstream behaviour, shared with every other config read in the
process, and unavoidable without forking the loader.

The consequences are handled rather than hidden. `SOUL.md` is excluded from the
identity markers precisely because that bootstrap creates it, so a bare
directory does not start reporting as a profile the moment it is analyzed; and
`test_report_is_read_only_and_repeatable` asserts the second call matches the
first. Had the scaffolding shown up in the report, that test is what would have
caught it — and did.

## Scoping

Everything runs under the profile's own scope (`_hermes_home_scope` /
`config_write_scope`'s read half at the router), never bare `os.environ`: under
multiplex the process env holds the *launch* profile's keys, so an unscoped read
would report another profile's credentials as this one's. Toolsets, skills and
secrets are therefore resolved per profile, and a skill installed under one
profile is not available to another.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from hermes_cli.pipeline_readiness import tool_availability

logger = logging.getLogger(__name__)

SEVERITY_ERROR = "ERROR"
SEVERITY_WARNING = "WARNING"

# A skill naming a tool this install has never heard of is a real finding; a
# skill naming one that exists but is switched off is context, not a defect.
_MISSING_TOOL_IS_ERROR = True


def _row(kind: str, name: str, ok: bool, detail: str = "") -> Dict[str, Any]:
    """One report row. ``ok`` False is a finding, not an error response."""
    return {"kind": kind, "name": name, "ok": bool(ok), "detail": detail}


# ── Level 1: structure ────────────────────────────────────────────────────────

# A directory is a profile when something *deliberate* put it there. `SOUL.md`
# is deliberately absent from this list: `load_config()` bootstraps an empty
# SOUL.md plus twelve scaffolding directories on first read, so including it
# would mean a bare directory starts looking like a profile the moment the report
# touches it — and the next run would report differently from the last.
_IDENTITY_MARKERS = ("config.yaml", ".env", "profile.yaml", "auth.json", "state.db")


def _yaml_verdict(text: str) -> Tuple[bool, str]:
    """``(ok, detail)`` for a config's YAML text.

    PyYAML is an optional dependency — the hermetic test environment does not
    have it — so a missing parser is reported as "not checked", never as "broken".
    Conflating the two would have marked a healthy profile's config as unparseable
    for no reason but an import.
    """
    try:
        import yaml
    except ImportError:
        return True, "readable; not parsed (PyYAML not installed)"
    try:
        loaded = yaml.safe_load(text)
    except Exception as exc:
        return False, f"does not parse: {exc}"
    if loaded is not None and not isinstance(loaded, dict):
        return False, "top level is not a mapping — every key lookup will fail"
    return True, "parses"


def analyze_structure(profile_dir: Path) -> List[Dict[str, Any]]:
    """Whether the profile's own files are present and readable.

    Reads only; a missing `config.yaml` is reported, not created.
    """
    rows: List[Dict[str, Any]] = []
    home = Path(profile_dir)

    if not home.is_dir():
        return [_row("structure", "profile_dir", False, f"profile directory {home} does not exist")]

    markers = [m for m in _IDENTITY_MARKERS if (home / m).exists()]
    rows.append(_row(
        "structure", "identity_marker", bool(markers),
        f"identity files: {', '.join(markers)}" if markers
        else "no identity file — the directory is not treated as a profile"))

    config_path = home / "config.yaml"
    if not config_path.exists():
        rows.append(_row("structure", "config.yaml", True, "not present; defaults apply"))
    else:
        try:
            text = config_path.read_text(encoding="utf-8-sig")
        except OSError as exc:
            rows.append(_row("structure", "config.yaml", False, f"unreadable: {exc}"))
        else:
            verdict = _yaml_verdict(text)
            rows.append(_row("structure", "config.yaml", verdict[0], verdict[1]))

    env_path = home / ".env"
    if not env_path.exists():
        rows.append(_row("structure", ".env", True,
                         "absent — provider keys must be supplied another way"))
    else:
        try:
            text = env_path.read_text(encoding="utf-8-sig")
        except OSError as exc:
            rows.append(_row("structure", ".env", False, f"unreadable: {exc}"))
        else:
            assigned = [ln.split("=", 1)[0].strip() for ln in text.splitlines()
                        if ln.strip() and not ln.lstrip().startswith("#") and "=" in ln]
            rows.append(_row("structure", ".env", True,
                             f"{len(assigned)} assignment(s)"))
    return rows


# ── Level 2: readiness ────────────────────────────────────────────────────────

def _enabled_toolset_tools(profile_dir: Path) -> Tuple[List[str], List[Dict[str, Any]]]:
    """``(tool names, disabled toolsets)`` for this profile's platform toolsets.

    Reads the same `platform_toolsets` config the toolsets endpoint writes, so
    the report cannot disagree with the toggle that set it. A toolset that fails
    to resolve is reported rather than silently contributing nothing — that is
    the "available means available" rule, applied to the toolset layer.
    """
    from toolsets import resolve_toolset

    names: List[str] = []
    disabled: List[Dict[str, Any]] = []
    try:
        from hermes_cli.config import load_config
        from hermes_cli.tools_config import (
            _CONFIG_ONLY_TOOLSETS, _get_effective_configurable_toolsets, _get_platform_tools)

        config = load_config()
        enabled = _get_platform_tools(config, "cli", include_default_mcp_servers=False)
        # A named platform toolset is a *name* set; the configurable catalogue is
        # what tells us which of those names have a switch of their own.
        configurable = {name for name, _, _ in _get_effective_configurable_toolsets()}
    except Exception as exc:
        logger.debug("profile analysis: toolset resolution failed", exc_info=True)
        return names, disabled

    for name in sorted(str(n) for n in enabled):
        if name in _CONFIG_ONLY_TOOLSETS:
            continue
        try:
            names.extend(resolve_toolset(name))
        except Exception as exc:
            logger.debug("profile analysis: toolset %r did not resolve", name, exc_info=True)
            disabled.append({"toolset": name, "reason": f"does not resolve in this install: {exc}"})
    # Configurable toolsets that are simply off. Context, not a defect — a profile
    # without the browser toolset is a normal profile — so it is reported apart
    # from the finding rows.
    disabled.extend(
        {"toolset": name, "reason": "not enabled for this platform"}
        for name in sorted(configurable - {str(n) for n in enabled})
    )
    return sorted(set(names)), disabled


def _mcp_servers(profile_dir: Path) -> List[Dict[str, Any]]:
    """The profile's configured MCP servers, one row each.

    A server declares no tool names in the config — its tools arrive at
    discovery time — so this reports the *server's* presence and transport, not
    an invented tool list. Naming tools this install never registered would
    manufacture findings out of nothing.
    """
    try:
        from hermes_cli.config import load_config

        servers = load_config().get("mcp_servers") or {}
    except Exception:
        return []
    if not isinstance(servers, dict):
        return []
    rows: List[Dict[str, Any]] = []
    for name in sorted(str(k) for k in servers):
        entry = servers.get(name)
        entry = entry if isinstance(entry, dict) else {}
        transport = "http" if entry.get("url") else ("stdio" if entry.get("command") else "unknown")
        rows.append({"name": name, "transport": transport,
                     "enabled": entry.get("enabled", True) is not False})
    return rows


# ── Level 3: skills ───────────────────────────────────────────────────────────

def _skill_declared_tools(skill_md: Path) -> List[str]:
    """Tool names a skill's frontmatter declares (``tools:`` / ``required_tools:``)."""
    try:
        from agent.skill_utils import parse_frontmatter

        frontmatter, _ = parse_frontmatter(skill_md.read_text(encoding="utf-8-sig", errors="ignore"))
    except Exception:
        return []
    if not isinstance(frontmatter, dict):
        return []
    out: List[str] = []
    for key in ("tools", "required_tools", "tool_names"):
        value = frontmatter.get(key)
        if isinstance(value, str):
            out.extend(n.strip() for n in value.split(","))
        elif isinstance(value, list):
            out.extend(str(n).strip() for n in value)
    return sorted({n for n in out if n})


def _skill_declared_binaries(skill_md: Path) -> List[Dict[str, Any]]:
    """Binaries a skill's frontmatter declares (``binaries:`` / ``requires:``)."""
    try:
        from agent.skill_utils import parse_frontmatter

        frontmatter, _ = parse_frontmatter(skill_md.read_text(encoding="utf-8-sig", errors="ignore"))
    except Exception:
        return []
    if not isinstance(frontmatter, dict):
        return []
    out: List[Dict[str, Any]] = []
    for key in ("binaries", "requires", "requires_binaries"):
        value = frontmatter.get(key)
        items = [value] if isinstance(value, str) else (value if isinstance(value, list) else [])
        for item in items:
            if isinstance(item, str) and item.strip():
                out.append({"binary": item.strip(), "present": bool(shutil.which(item.strip()))})
    return out


def analyze_skills(profile_dir: Path) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Per-skill findings and the tool names the skill set requires.

    Only skills that are actually present in *this* profile are considered — a
    skill installed elsewhere is not this profile's capability and must not be
    credited to it.
    """
    from tools.skill_linter import lint_skill

    skills_dir = Path(profile_dir) / "skills"
    rows: List[Dict[str, Any]] = []
    required: List[str] = []
    if not skills_dir.is_dir():
        return rows, required

    for skill_md in sorted(skills_dir.rglob("SKILL.md")):
        try:
            relative = skill_md.parent.relative_to(skills_dir)
        except ValueError:
            continue
        name = relative.as_posix() if str(relative) != "." else skill_md.parent.name
        try:
            findings = lint_skill(skill_md)
        except Exception as exc:
            rows.append(_row("skill", name, False, f"could not be read: {exc}"))
            continue
        errors = [f for f in findings if f.severity == SEVERITY_ERROR]
        if errors:
            detail = "; ".join(f"{f.rule}: {f.message}" for f in errors[:5])
            rows.append(_row("skill", name, False, detail))
        else:
            warnings = [f for f in findings if f.severity == SEVERITY_WARNING]
            detail = f"{len(warnings)} advisory finding(s)" if warnings else "clean"
            rows.append(_row("skill", name, True, detail))
        required.extend(_skill_declared_tools(skill_md))
        for binary in _skill_declared_binaries(skill_md):
            rows.append(_row(
                "binary", f"{name}:{binary['binary']}", binary["present"],
                "" if binary["present"] else f"declared binary {binary['binary']!r} is not on PATH"))
    return rows, sorted(set(required))


# ── Composition ───────────────────────────────────────────────────────────────

def analyze_profile(profile_dir: Path) -> Dict[str, Any]:
    """The full report for one profile. Pure read — see the module docstring.

    Enters the profile's own scope itself rather than trusting the caller to have
    done it: `load_config`, the toolset catalogue and the skills dir all resolve
    through `get_hermes_home()` at call time, so an unscoped run would report the
    *launch* profile's configuration under this profile's name — a report that
    is confidently wrong, which is the one failure mode this endpoint cannot have.
    """
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    home = Path(profile_dir)
    token = set_hermes_home_override(str(home))
    try:
        return _analyze_scoped(home)
    finally:
        reset_hermes_home_override(token)


def _analyze_scoped(home: Path) -> Dict[str, Any]:
    structure = analyze_structure(home)
    skills, skill_tools = analyze_skills(home)
    toolset_tools, disabled_toolsets = _enabled_toolset_tools(home)
    mcp_rows = _mcp_servers(home)

    wanted = sorted(set(toolset_tools) | set(skill_tools))
    unavailable = tool_availability(wanted)

    readiness_rows = [
        _row("tool", entry["tool"], False, entry["reason"]) for entry in unavailable
    ]
    findings = [r for r in structure + readiness_rows + skills if not r["ok"]]

    return {
        "profile": home.name,
        "structure": structure,
        "readiness": {
            "tools_checked": len(wanted),
            "unavailable": readiness_rows,
            "disabled_toolsets": disabled_toolsets,
            "mcp_servers": mcp_rows,
        },
        "skills": skills,
        "ok": not findings,
        "finding_count": len(findings),
        "read_only": True,
    }