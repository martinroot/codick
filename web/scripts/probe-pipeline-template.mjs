"""One-shot behaviour probe for the CoDick pipeline template import (#30).

Not a pytest file: the scratch/test environments on this machine have no pytest and none
may be installed. It exercises the real modules (`hermes_cli/pipeline_template.py`,
`hermes_cli/pipelines_db.py`, `hermes_cli/pipeline_profiles.py`) against a throwaway DB
path and prints one line per invariant. This run backs the commit that lands the
validator; it is not wired into CI — CI on this repo does not run the Python suite.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, "/home/grokwin/dev/hermes-multiserver-web-bootstrap")

from hermes_cli import pipeline_template as pt  # noqa: E402
from hermes_cli import pipelines_db as pdb  # noqa: E402


def check(name: str, cond: bool, detail: str = "") -> None:
    print(("PASS  " if cond else "FAIL  ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        raise SystemExit(f"FAILED: {name}")


def paths(errors):
    return {e.path for e in errors}


# The spec §5 Word scenario, with every logical id bound to `default` and the
# DOCX tool declared available — the definition of a `ready` template.
WORD = {
    "schema_version": "1.0", "id": "word-edit", "version": "1.0.0",
    "name": "Edit Word document", "description": "Editing, auto-review, refinement, DOCX build",
    "inputs_schema": {
        "type": "object",
        "properties": {"document_ref": {"type": "string"}, "instructions": {"type": "string", "minLength": 1}},
        "required": ["document_ref", "instructions"], "additionalProperties": False,
    },
    "start_step": "edit",
    "limits": {"max_step_executions": 30, "max_rework_cycles": 3},
    "steps": [
        {"id": "edit", "type": "agent", "title": "Apply edits", "profile": "word-editor",
         "instruction": "Edit the document per instructions.",
         "input": {"document_ref": {"ref": "inputs.document_ref"},
                   "instructions": {"ref": "inputs.instructions"},
                   "feedback": {"ref": "steps.review.output.feedback", "optional": True, "default": ""}},
         "output_schema": {"type": "object",
                           "properties": {"document_ref": {"type": "string"}, "summary": {"type": "string"}},
                           "required": ["document_ref", "summary"], "additionalProperties": False},
         "timeout_seconds": 600, "retry": {"max_attempts": 2, "backoff_seconds": 5}, "next": "review"},
        {"id": "review", "type": "agent", "title": "Review", "profile": "word-reviewer",
         "instruction": "Review the result; return verdict accepted or rework.",
         "input": {"original_ref": {"ref": "inputs.document_ref"},
                   "document_ref": {"ref": "steps.edit.output.document_ref"},
                   "instructions": {"ref": "inputs.instructions"}},
         "output_schema": {"type": "object",
                           "properties": {"verdict": {"type": "string", "enum": ["accepted", "rework"]},
                                          "feedback": {"type": "string"}},
                           "required": ["verdict", "feedback"], "additionalProperties": False},
         "timeout_seconds": 300, "retry": {"max_attempts": 2, "backoff_seconds": 5}, "next": "review_route"},
        {"id": "review_route", "type": "condition", "title": "Route by verdict",
         "cases": [
             {"when": {"op": "eq", "left": {"ref": "steps.review.output.verdict"}, "right": "accepted"},
              "next": "user_details"},
             {"when": {"op": "eq", "left": {"ref": "steps.review.output.verdict"}, "right": "rework"},
              "next": "edit", "rework": True},
         ],
         "default": {"fail": "Unexpected review verdict"}},
        {"id": "user_details", "type": "user_input", "title": "Ask for details",
         "prompt": "Name the final file and add any extra instructions.",
         "input": {"document_ref": {"ref": "steps.edit.output.document_ref"}},
         "response_schema": {"type": "object",
                             "properties": {"output_filename": {"type": "string", "minLength": 1},
                                            "additional_instructions": {"type": "string"}},
                             "required": ["output_filename", "additional_instructions"],
                             "additionalProperties": False},
         "chat": {"enabled": True, "profile": "input-assistant"},
         "wait_timeout_seconds": None, "next": "finalize"},
        {"id": "finalize", "type": "agent", "title": "Apply additions", "profile": "word-editor",
         "instruction": "Apply additional_instructions; return the final document ref.",
         "input": {"document_ref": {"ref": "steps.edit.output.document_ref"},
                   "additional_instructions": {"ref": "steps.user_details.output.additional_instructions"}},
         "output_schema": {"type": "object", "properties": {"document_ref": {"type": "string"}},
                           "required": ["document_ref"], "additionalProperties": False},
         "timeout_seconds": 600, "retry": {"max_attempts": 2, "backoff_seconds": 5}, "next": "export"},
        {"id": "export", "type": "tool", "title": "Build DOCX", "tool": "documents.export_docx",
         "input": {"document_ref": {"ref": "steps.finalize.output.document_ref"},
                   "output_filename": {"ref": "steps.user_details.output.output_filename"}},
         "output_schema": {"type": "object", "properties": {"artifact_ref": {"type": "string"}},
                           "required": ["artifact_ref"], "additionalProperties": False},
         "timeout_seconds": 120, "retry": {"max_attempts": 2, "backoff_seconds": 5}, "next": None},
    ],
    "result": {"document": {"ref": "steps.export.output.artifact_ref"}},
}


def word_template() -> dict:
    return json.loads(json.dumps(WORD))


with tempfile.TemporaryDirectory(prefix="pl-tmpl-") as tmp:
    db_path = Path(tmp) / "pipelines.db"
    conn = pdb.connect(db_path=db_path)

    GOOD_BINDING = {"word-editor": "default", "word-reviewer": "default", "input-assistant": "default"}
    TOOLS_OK = {"documents.export_docx"}
    tool_ok = lambda t: t in TOOLS_OK  # noqa: E731

    # --- structural + semantic validation on the spec example ---
    word = word_template()
    errs = pt.validate_template(word)
    check("spec Word template validates clean", errs == [], "; ".join(map(str, errs[:3])))

    # --- structural schema errors carry JSON paths ---
    broken = dict(word, schema_version="2.0")
    errs = pt.validate_template(broken)
    check("wrong schema_version rejected", any("schema_version" in e.path for e in errs), str(errs[:1]))
    broken = dict(word, steps=[dict(word["steps"][0], type="branch")])
    errs = pt.validate_template(broken)
    check("unknown step type rejected", any(e.path == "steps[0].type" for e in errs), str(errs[:1]))
    broken = dict(word, unrelated_field=1)
    errs = pt.validate_template(broken)
    check("unknown top-level field rejected",
          any("unrelated_field" in e.message for e in errs), str(errs[:1]))

    # --- step identity ---
    dup = json.loads(json.dumps(word))
    dup["steps"][1]["id"] = "edit"
    errs = pt.validate_template(dup)
    check("duplicate step id reported on the second occurrence",
          "steps[1].id" in paths(errs) and any("duplicate" in e.message for e in errs), str(errs[:2]))
    dup = json.loads(json.dumps(word))
    dup["start_step"] = "ghost"
    errs = pt.validate_template(dup)
    check("start_step must exist", any(e.path == "start_step" and "ghost" in e.message for e in errs),
          str(errs[:1]))

    # --- transitions ---
    dup = json.loads(json.dumps(word))
    dup["steps"][0]["next"] = "ghost"
    errs = pt.validate_template(dup)
    check("unknown next reported as steps[i].next",
          any(e.path == "steps[0].next" and "ghost" in e.message for e in errs), str(errs[:1]))
    dup = json.loads(json.dumps(word))
    dup["steps"][2]["cases"][0]["next"] = "ghost"
    errs = pt.validate_template(dup)
    check("unknown case transition reported as cases[i].next",
          any(e.path == "steps[2].cases[0].next" and "ghost" in e.message for e in errs), str(errs[:1]))
    dup = json.loads(json.dumps(word))
    dup["steps"][2]["default"] = {"neither": 1}
    errs = pt.validate_template(dup)
    check("condition default must carry next or fail",
          any(e.path == "steps[2].default" for e in errs), str(errs[:1]))

    # --- condition operations ---
    dup = json.loads(json.dumps(word))
    dup["steps"][2]["cases"][0]["when"]["op"] = "regex"
    errs = pt.validate_template(dup)
    check("non-MVP condition op rejected",
          any(e.path == "steps[2].cases[0].when.op" for e in errs), str(errs[:1]))
    dup = json.loads(json.dumps(word))
    dup["steps"][2]["cases"][0]["when"]["right"] = {"anything": 1}
    dup["steps"][2]["cases"][0]["when"]["op"] = "exists"
    errs = pt.validate_template(dup)
    check("exists takes no right operand",
          any("right" in e.path for e in errs), str(errs[:1]))
    dup = json.loads(json.dumps(word))
    del dup["steps"][2]["cases"][0]["when"]["right"]
    errs = pt.validate_template(dup)
    check("eq requires a right operand",
          any(e.path == "steps[2].cases[0].when.right" for e in errs), str(errs[:1]))

    # --- refs ---
    dup = json.loads(json.dumps(word))
    dup["steps"][0]["input"]["document_ref"] = {"ref": "config.document_ref"}
    errs = pt.validate_template(dup)
    check("ref root must be inputs or steps",
          any(e.path == "steps[0].input.document_ref" and "root" in e.message for e in errs), str(errs[:1]))
    dup = json.loads(json.dumps(word))
    dup["steps"][0]["input"]["document_ref"] = {"ref": "inputs.missing"}
    errs = pt.validate_template(dup)
    check("ref to an undeclared input reported",
          any("unknown input 'missing'" in e.message for e in errs), str(errs[:1]))
    dup = json.loads(json.dumps(word))
    dup["steps"][1]["input"]["document_ref"] = {"ref": "steps.ghost.output.document_ref"}
    errs = pt.validate_template(dup)
    check("ref to an unknown step reported",
          any("unknown step 'ghost'" in e.message for e in errs), str(errs[:1]))
    dup = json.loads(json.dumps(word))
    dup["steps"][0]["input"]["feedback"] = {"ref": "inputs.a", "optional": True}
    errs = pt.validate_template(dup)
    check("optional ref without default rejected",
          any("optional and default must be given together" in e.message for e in errs), str(errs[:1]))
    dup = json.loads(json.dumps(word))
    dup["steps"][0]["input"]["feedback"] = {"ref": "steps.review.output.feedback",
                                            "optional": True, "default": ""}
    check("optional ref with default accepted", pt.validate_template(dup) == [])

    # --- graph analysis ---
    dup = json.loads(json.dumps(word))
    dup["steps"].append({
        "id": "orphan", "type": "agent", "title": "O", "profile": "word-editor",
        "instruction": "x", "next": None,
    })
    errs = pt.validate_template(dup)
    check("unreachable step reported", any("unreachable step 'orphan'" in e.message for e in errs),
          str(errs[:1]))
    dup = json.loads(json.dumps(word))
    dup["steps"][5]["next"] = "finalize"  # export loops back instead of finishing
    errs = pt.validate_template(dup)
    check("no path to an end reported",
          any("no path to an end" in e.message for e in errs), str(errs[:1]))
    dup = json.loads(json.dumps(word))
    del dup["limits"]
    dup["steps"][2]["cases"][1]["next"] = "review"  # a genuine cycle...
    # ...but export still terminates, so make review the loop and keep an end via default fail
    dup["steps"][2]["default"] = {"fail": "bad verdict"}
    errs = pt.validate_template(dup)
    check("cycle without a required limit reported",
          any(e.path == "limits.max_step_executions" and "cycle" in e.message for e in errs),
          str(errs[:1]))
    dup["limits"] = {"max_step_executions": 30}
    check("cycle with a limit accepted", pt.validate_template(dup) == [], str(pt.validate_template(dup)[:2]))

    # --- invalid input shape ---
    errs = pt.validate_template("not an object")
    check("non-object template rejected", errs and errs[0].path == "$", str(errs[:1]))

    # --- import: ready path ---
    r = pt.import_validated_template(conn, word, binding=GOOD_BINDING, tool_available=tool_ok)
    check("ready import stores", r.status == "stored", r.status)
    t = pdb.get_template(conn, "word-edit", "1.0.0")
    check("stored readiness is ready", t is not None and t.readiness_status == "ready"
          and t.readiness_detail is None, str(t and t.readiness_status))

    # --- import idempotency + conflict (spec §6) ---
    r2 = pt.import_validated_template(conn, word, binding=GOOD_BINDING, tool_available=tool_ok)
    check("same id/version + same hash is idempotent", r2.status == "idempotent", r2.status)
    changed = json.loads(json.dumps(word))
    changed["name"] = "Edited"
    try:
        pt.import_validated_template(conn, changed, binding=GOOD_BINDING, tool_available=tool_ok)
        check("same id/version + different content raises conflict", False)
    except pt.TemplateConflict as e:
        check("same id/version + different content raises conflict", "new version" in str(e), str(e))
    v2 = dict(changed, version="1.1.0")
    r3 = pt.import_validated_template(conn, v2, binding=GOOD_BINDING, tool_available=tool_ok)
    check("new version imports alongside", r3.status == "stored"
          and len(pdb.list_template_versions(conn, "word-edit")) == 2)

    # --- import: unavailable readiness (spec §6) ---
    blocked = dict(WORD, id="word-edit-blocked")
    r4 = pt.import_validated_template(conn, blocked, binding=None, tool_available=lambda t: False)
    check("missing profile + tool stores unavailable", r4.status == "unavailable"
          and len(r4.readiness) == 4, f"{r4.status} {r4.readiness}")
    t = pdb.get_template(conn, "word-edit-blocked", "1.0.0")
    check("readiness detail persisted", t is not None and t.readiness_status == "unavailable"
          and t.readiness_detail and all(
              ("does not exist" in d and t.readiness_detail.count(d) == 1) or "not available" in d
              for d in t.readiness_detail), str(t and t.readiness_detail))
    r5 = pt.import_validated_template(conn, blocked, binding=GOOD_BINDING, tool_available=tool_ok)
    check("re-import after readiness is restored upgrades an unavailable version",
          r5.status == "idempotent" and r5.readiness == [], f"{r5.status} {r5.readiness}")
    t = pdb.get_template(conn, "word-edit-blocked", "1.0.0")
    check("stored readiness upgraded to ready", t.readiness_status == "ready"
          and t.readiness_detail is None, str(t.readiness_status))

    # --- structural errors refuse to store anything ---
    before = len(pdb.list_templates(conn))
    try:
        pt.import_validated_template(conn, dict(word, start_step="ghost"))
        check("invalid template is not stored", False)
    except pt.TemplateValidationError as e:
        check("invalid template is not stored", len(pdb.list_templates(conn)) == before
              and e.errors and e.errors[0].path == "start_step", str(e.errors[:1]))

    # --- validation errors list every finding, not just the first ---
    multi = json.loads(json.dumps(word))
    multi["steps"][0]["next"] = "ghost"
    multi["steps"][1]["input"]["document_ref"] = {"ref": "steps.ghost.output.x"}
    errs = pt.validate_template(multi)
    check("all findings reported together", len(errs) >= 2
          and {"steps[0].next", "steps[1].input.document_ref"} <= paths(errs), str([str(e) for e in errs]))

    # --- migration: a pre-#30 DB gains the readiness columns on open ---
    old = Path(tmp) / "old.db"
    raw = sqlite3.connect(old)
    raw.executescript("""
        CREATE TABLE scenario_templates (
            id TEXT NOT NULL, version TEXT NOT NULL, name TEXT, description TEXT,
            json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY (id, version));
        INSERT INTO scenario_templates VALUES ('legacy', '1', 'L', NULL, '{}', 1, 1);
    """)
    raw.commit()
    raw.close()
    old_conn = pdb.connect(db_path=old)
    t = pdb.get_template(old_conn, "legacy", "1")
    check("pre-#30 DB migrates on open and reads as ready",
          t is not None and t.readiness_status == "ready", str(t and t.readiness_status))
    check("column migration is idempotent on reopen",
          pdb.connect(db_path=old) is not None and pdb.get_template(old_conn, "legacy") is not None)

print("\nprobe-pipeline-template: all invariants passed")
