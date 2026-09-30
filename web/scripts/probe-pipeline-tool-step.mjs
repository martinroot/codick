"""One-shot behaviour probe for the CoDick pipeline tool step (spec §8, issue #47).

Same convention as the other probe-pipeline-*.mjs scripts: a Python script (not
wired into CI — no pytest on this machine) exercising the real modules
(`hermes_cli/pipeline_tool_step.py`, `tools/registry.py`) in-process, one line
per invariant.
"""

from __future__ import annotations

import sys

sys.path.insert(0, "/home/grokwin/dev/hermes-multiserver-web-bootstrap")

from hermes_cli import pipeline_tool_step as pts  # noqa: E402
from tools.registry import registry  # noqa: E402


def check(name: str, cond: bool, detail: str = "") -> None:
    print(("PASS  " if cond else "FAIL  ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        raise SystemExit(f"FAILED: {name}")


def paths(errors):
    return {e.path for e in errors}


# --- A registered probe tool with declared semantics (real registry) ----------

DOCX_SCHEMA = {
    "name": "probe_docx_build",
    "description": "probe",
    "parameters": {
        "type": "object",
        "properties": {
            "document_ref": {"type": "string", "minLength": 1},
            "mode": {"enum": ["build", "patch"]},
            "items": {"type": "array", "items": {
                "type": "object",
                "properties": {"section": {"type": "string"}},
                "required": ["section"], "additionalProperties": False,
            }},
        },
        "required": ["document_ref"],
        "additionalProperties": False,
    },
}
registry.register(
    name="probe_docx_build", toolset="probe", schema=DOCX_SCHEMA,
    handler=lambda args: "{}", read_only=False, idempotent=True, cancellable=True)
registry.register(
    name="probe_docx_read", toolset="probe", schema=DOCX_SCHEMA,
    handler=lambda args: "{}", read_only=True)

# --- Arg validation ------------------------------------------------------------

check("valid args pass", pts.validate_tool_args("probe_docx_build", {
    "document_ref": "doc1", "mode": "build", "items": [{"section": "intro"}],
}) == [])

errs = pts.validate_tool_args("probe_docx_build", {})
e0 = errs[0]
check("missing required reported at the object root, property named in the message",
      paths(errs) == {"args"} and "document_ref" in e0.message, str(errs))

errs = pts.validate_tool_args("probe_docx_build", {"document_ref": "d", "mode": "nope"})
check("enum violation path", paths(errs) == {"args.mode"}, str(errs))

errs = pts.validate_tool_args("probe_docx_build", {
    "document_ref": "d", "items": [{"section": 7}]})
check("nested array path uses §6 format", paths(errs) == {"args.items[0].section"}, str(errs))

errs = pts.validate_tool_args("probe_docx_build", {"document_ref": "d", "extra": 1})
check("additionalProperties rejected (root path, property named)",
      paths(errs) == {"args"} and "extra" in errs[0].message, str(errs))

errs = pts.validate_tool_args("probe_docx_build", ["not", "an", "object"])
check("non-object args rejected at args", paths(errs) == {"args"}, str(errs))

errs = pts.validate_tool_args("no_such_tool", {"x": 1})
check("unregistered tool reported", paths(errs) == {"tool"} and
      "not registered" in list(errs)[0].message, str(errs))

check("unknown tool is readiness-empty when tool_available says so",
      pts.validate_tool_args("no_such_tool", {"x": 1}, tool_available=lambda t: False) == [])

check("tool_available=False skips validation even for bad args",
      pts.validate_tool_args("probe_docx_build", {}, tool_available=lambda t: False) == [])

errs = pts.validate_tool_args("anything", {}, schema_for=lambda t: {
    "type": "object", "required": ["q"]})
check("schema_for seam substitutes the schema source",
      paths(errs) == {"args"} and "q" in errs[0].message, str(errs))

# --- Semantics -------------------------------------------------------------------

sem = pts.tool_step_semantics("probe_docx_build")
check("idempotent+side-effecting is retry_safe", sem.retry_safe and sem.idempotent
      and not sem.read_only, str(sem))
check("cancellable read through", sem.cancellable, str(sem))

sem = pts.tool_step_semantics("probe_docx_read")
check("read_only is retry_safe", sem.retry_safe and sem.read_only, str(sem))

sem = pts.tool_step_semantics("probe_docx_undeclared", semantics_reader=lambda t: {})
check("undeclared defaults conservative: no silent retry", sem is not None and
      not sem.retry_safe and not sem.cancellable, str(sem))

check("unknown tool semantics is None (readiness, not error)",
      pts.tool_step_semantics("no_such_tool") is None)

# --- Registry surface -------------------------------------------------------------

sem = registry.get_tool_semantics("probe_docx_read")
check("get_tool_semantics derives retry_safe", sem == {
    "read_only": True, "idempotent": False, "cancellable": False, "retry_safe": True}, str(sem))
check("get_tool_semantics unknown -> None", registry.get_tool_semantics("nope") is None)

from tools.registry import discover_builtin_tools  # noqa: E402
discover_builtin_tools()
sem = registry.get_tool_semantics("execute_code")
check("existing built-in conservatively non-retry-safe", sem is not None and not sem["retry_safe"], str(sem))

print("ALL PASS")
