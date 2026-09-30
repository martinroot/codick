"""One-shot behaviour probe for the pipeline profile binding (hermes_cli/pipeline_profiles.py) — issue #48.

Not a pytest file: the scratch/test environments on this machine have no pytest and none
may be installed (same convention as probe-output-schema-contract.mjs, #46). It imports
the real module and the real profiles roster and prints one line per invariant. This run
backs the commit that makes the spec's logical profile ids concrete; it is not wired into
CI — CI on this repo does not run the Python suite.
"""

from __future__ import annotations

import sys
import unittest.mock as mock

sys.path.insert(0, "/home/grokwin/dev/hermes-multiserver-web-bootstrap")

from hermes_cli import pipeline_profiles as pp  # noqa: E402
from hermes_cli.profiles import list_profile_names  # noqa: E402


def check(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        raise SystemExit(f"FAILED: {name}")


# --- binding_from_config -----------------------------------------------------

check("binding reads a well-formed section",
      pp.binding_from_config({"pipelines": {"profiles": {"word-editor": "default"}}})
      == {"word-editor": "default"})
check("blank and non-string entries are dropped, config does not raise",
      pp.binding_from_config({"pipelines": {"profiles": {"a": "", "b": 5, "c": " default "}}})
      == {"c": "default"})
check("junk config yields an empty binding",
      pp.binding_from_config({"pipelines": "oops"}) == {} and pp.binding_from_config(None) == {})

# --- resolve_profile_id ------------------------------------------------------

b = {"word-editor": "default"}
check("mapped id resolves through the binding",
      pp.resolve_profile_id("word-editor", b) == "default")
check("unmapped id passes through as the profile name itself (no fallback)",
      pp.resolve_profile_id("word-reviewer", b) == "word-reviewer")
check("empty id stays empty (caller's required-field validation reports it)",
      pp.resolve_profile_id("", b) == "")

# --- availability is a fail-closed readiness gate ----------------------------

check("default is always available", pp.profile_is_available("default"))
check("a dot in the name is unavailable by convention (profile-id regex, fail closed)",
      not pp.profile_is_available("word.editor") and not pp.profile_is_available("a/b"))
check("empty name is unavailable", not pp.profile_is_available(""))

TEMPLATE = {"steps": [
    {"id": "edit", "type": "agent", "profile": "word-editor"},
    {"id": "review", "type": "agent", "profile": "word-reviewer"},
    {"id": "ui", "type": "user_input", "chat": {"enabled": True, "profile": "input-assistant"}},
]}

# --- the audit behind the issue: the real roster -----------------------------

roster = list_profile_names()
check("the real roster on this backend names no profiles beyond default",
      roster == ["default"], f"roster={roster}")
unavail = pp.unavailable_profile_ids(TEMPLATE, b)
check("only the unbound, nonexistent ids report unavailable (mapped word-editor is fine)",
      unavail == ["word-reviewer", "input-assistant"], f"unavail={unavail}")
check("with no binding, every spec id is unavailable (the issue's premise)",
      pp.unavailable_profile_ids(TEMPLATE, {}) == ["word-editor", "word-reviewer", "input-assistant"])
check("a full binding makes the whole template ready",
      pp.unavailable_profile_ids(TEMPLATE, {"word-editor": "default", "word-reviewer": "default",
                                            "input-assistant": "default"}) == [])
check("a template without steps yields nothing",
      pp.unavailable_profile_ids({}, b) == [] and pp.unavailable_profile_ids(None, b) == [])

# --- the operator-known message text -----------------------------------------

err = pp.ProfileUnavailableError("word-reviewer")
check("error text matches the dashboard's existing validation shape",
      str(err) == "profile 'word-reviewer' does not exist")

# --- fail-closed on a broken roster lookup -----------------------------------

with mock.patch("hermes_cli.profiles.profile_exists", side_effect=RuntimeError("boom")):
    check("a broken roster lookup reads as unavailable (readiness gate, fail closed)",
          not pp.profile_is_available("default", profiles_mod=None))
    check("the gate's unavailability is reported per logical id, not raised",
          pp.unavailable_profile_ids(TEMPLATE, {"word-editor": "default"})
          == ["word-editor", "word-reviewer", "input-assistant"])

print("ALL PASS")
