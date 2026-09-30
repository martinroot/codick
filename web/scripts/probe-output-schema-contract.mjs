"""One-shot behaviour probe for the structured-output contract (tools/delegation_output_schema.py) — issue #46.

Not a pytest file: the scratch/test environments on this machine have no pytest and none
may be installed. It imports the real module and drives the real delegate_task dispatch
(mocked parent, the same shape tests/tools/test_delegate_output_schema.py uses) and prints
one line per invariant. This run backs the commit that makes jsonschema a hard dependency
and pins the Draft 2020-12 dialect; it is not wired into CI — CI on this repo does not run
the Python suite (gh api .../actions/workflows shows only web.yml).
"""

from __future__ import annotations

import importlib
import json
import sys
import threading
from unittest.mock import MagicMock, patch

sys.path.insert(0, "/home/grokwin/dev/hermes-multiserver-web-bootstrap")

from tools import delegation_output_schema as contract  # noqa: E402


def check(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        raise SystemExit(f"FAILED: {name}")


ADDRESS_SCHEMA = {
    "type": "object",
    "properties": {"city": {"type": "string"}, "zip": {"type": "string"}},
    "required": ["city"],
}

# ---------------------------------------------------------------------------
# 1. Dialect pin (spec §5: one documented version)
# ---------------------------------------------------------------------------

check("SUPPORTED_DIALECT is Draft 2020-12",
      contract.SUPPORTED_DIALECT == "https://json-schema.org/draft/2020-12/schema",
      str(contract.SUPPORTED_DIALECT))

# ---------------------------------------------------------------------------
# 2. Baseline contract behaviours (regression: the rewrite must keep them)
# ---------------------------------------------------------------------------

ok, errs = contract.validate_output('{"city": "Berlin"}', ADDRESS_SCHEMA)
check("valid JSON matching schema passes", ok is True and errs == [], str(errs))

ok, errs = contract.validate_output('{"zip": "10115"}', ADDRESS_SCHEMA)
# §6 errors carry a JSON path; a missing required property errors at the root, whose path is "$".
check("missing required city -> path-carrying error",
      ok is False and any(e.startswith("$") and "city" in e for e in errs), str(errs))

ok, _ = contract.validate_output('```json\n{"city": "Oslo"}\n```', ADDRESS_SCHEMA)
check("code-fenced JSON accepted", ok is True)

ok, _ = contract.validate_output('Here: {"city": "Lima"} — hope that helps', ADDRESS_SCHEMA)
check("prose-wrapped JSON accepted", ok is True)

ok, _ = contract.validate_output('Verdicts.\n```json\n[{"n": 1}, {"n": 2}]\n```\n',
                                 {"type": "array", "items": {"type": "object"}})
check("prose-wrapped fenced ARRAY accepted (extractor regression)", ok is True)

ok, errs = contract.validate_output("", ADDRESS_SCHEMA)
check("empty answer rejected", ok is False and errs, str(errs))

ok, errs = contract.validate_output("I could not produce JSON, sorry.", ADDRESS_SCHEMA)
check("non-JSON prose rejected with parse error",
      ok is False and any("not valid JSON" in e for e in errs), str(errs))

ok, errs = contract.validate_output('{"city": 7}', ADDRESS_SCHEMA)
check("wrong type reported on the property path",
      ok is False and any(".city" in e for e in errs), str(errs))

# ---------------------------------------------------------------------------
# 3. Dialect pin enforced at meta-validation (coerce_output_schema)
# ---------------------------------------------------------------------------

DRAFT7_TUPLE = {"type": "array", "items": [{"type": "integer"}]}  # draft-07 tuple form
schema, err = contract.coerce_output_schema(DRAFT7_TUPLE)
check("draft-07 tuple-form items rejected as not Draft 2020-12",
      schema is None and err is not None and "Draft 2020-12" in err, str(err))

DRAFT4_EXCL = {"type": "number", "minimum": 5, "exclusiveMinimum": True,
               "$schema": "http://json-schema.org/draft-04/schema#"}
schema, err = contract.coerce_output_schema(DRAFT4_EXCL)
check("draft-04 boolean exclusiveMinimum rejected ($schema header does not win)",
      schema is None and err is not None and "Draft 2020-12" in err, str(err))

DRAFT7_HEADER = {"$schema": "http://json-schema.org/draft-07/schema#",
                 "type": "object", "properties": {"city": {"type": "string"}},
                 "required": ["city"]}
schema, err = contract.coerce_output_schema(DRAFT7_HEADER)
check("draft-07 $schema header with 2020-12-compatible body still accepted",
      schema is not None and err is None, str(err))

# ---------------------------------------------------------------------------
# 4. The silent trap is closed: unimportable jsonschema -> loud ImportError
# ---------------------------------------------------------------------------

_saved_mod, _saved_val = sys.modules.get("jsonschema"), sys.modules.get("jsonschema.validators")
sys.modules["jsonschema"] = None
sys.modules["jsonschema.validators"] = None
try:
    importlib.reload(contract)
    check("jsonschema missing -> module import raises ImportError", False,
          "reload returned without ImportError — silent skip is back")
except ImportError:
    check("jsonschema missing -> module import raises ImportError (no silent skip)", True)
finally:
    if _saved_mod is not None:
        sys.modules["jsonschema"] = _saved_mod
    else:
        sys.modules.pop("jsonschema", None)
    if _saved_val is not None:
        sys.modules["jsonschema.validators"] = _saved_val
    else:
        sys.modules.pop("jsonschema.validators", None)

# reload with the real jsonschema back: the module must be healthy again
contract = importlib.reload(contract)
ok, _ = contract.validate_output('{"city": "Berlin"}', ADDRESS_SCHEMA)
check("module healthy again after the reload cycle", ok is True)

# ---------------------------------------------------------------------------
# 5. Dispatch boundary (issue text): malformed and wrong-dialect schemas
#    fail the call before any child spawns
# ---------------------------------------------------------------------------

from tools.delegate_tool import delegate_task  # noqa: E402

CREDS = {"provider": None, "model": None, "base_url": None, "api_key": None, "api_mode": None}


def _make_mock_parent():
    parent = MagicMock()
    parent._delegate_depth = 0
    parent._active_children = []
    parent._active_children_lock = threading.Lock()
    return parent


def _dispatch(tasks):
    with (patch("tools.delegate_tool._load_config", return_value={}),
          patch("tools.delegate_tool._resolve_delegation_credentials", return_value=CREDS)):
        return delegate_task(tasks=tasks, parent_agent=_make_mock_parent())


payload = json.loads(_dispatch([
    {"goal": "Summarize the release notes for module A", "output_schema": "not-a-dict"},
    {"goal": "Summarize the release notes for module B"},
]))
check("dispatch: output_schema must be a JSON Schema object (string rejected)",
      bool(payload.get("error")) and "output_schema" in payload["error"], json.dumps(payload)[:200])

payload = json.loads(_dispatch([
    {"goal": "Summarize the release notes for module A", "output_schema": {"type": 42}},
    {"goal": "Summarize the release notes for module B"},
]))
check("dispatch: invalid schema rejected at meta-validation",
      bool(payload.get("error")) and "output_schema" in payload["error"], json.dumps(payload)[:200])

payload = json.loads(_dispatch([
    {"goal": "Summarize the release notes for module A", "output_schema": DRAFT7_TUPLE},
    {"goal": "Summarize the release notes for module B"},
]))
err_text = json.dumps(payload)
check("dispatch: draft-07 tuple items rejected — dialect pinned at the boundary",
      bool(payload.get("error")) and "Draft 2020-12" in err_text, err_text[:300])

print("\nALL INVARIANTS PASS")
