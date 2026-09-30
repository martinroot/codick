"""One-shot behaviour probe for the CoDick pipeline storage layer (hermes_cli/pipelines_db.py).

Not a pytest file: the scratch/test environments on this machine have no pytest and none
may be installed. It exercises the real module against a throwaway DB path, the same way
tests/hermes_cli/test_projects_db.py does, and prints one line per invariant. This run
backs the commit that lands the module; it is not wired into CI — CI on this repo does not
run the Python suite (gh api .../actions/workflows shows only web.yml, docs).
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, "/home/grokwin/dev/hermes-multiserver-web-bootstrap")

from hermes_cli import pipelines_db as pdb  # noqa: E402


def check(name: str, cond: bool, detail: str = "") -> None:
    print(("PASS  " if cond else "FAIL  ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        raise SystemExit(f"FAILED: {name}")


TEMPLATE = {
    "schema_version": "1.0",
    "id": "word-edit",
    "version": "1.0.0",
    "name": "Edit Word document",
    "inputs_schema": {"type": "object", "properties": {}, "required": []},
    "start_step": "edit",
    "limits": {"max_step_executions": 30, "max_rework_cycles": 3},
    "steps": [
        {"id": "edit", "type": "agent", "title": "Edit"},
        {"id": "review", "type": "agent", "title": "Review"},
    ],
}

with tempfile.TemporaryDirectory(prefix="pl-smoke-") as tmp:
    db_path = Path(tmp) / "pipelines.db"
    conn = pdb.connect(db_path=db_path)

    # --- templates ---
    tid = pdb.import_template(conn, TEMPLATE)
    t = pdb.get_template(conn, "word-edit")
    check("import + get template", t is not None and t.id == tid and t.template == TEMPLATE)
    TEMPLATE_V2 = dict(TEMPLATE, version="1.1.0", name="Edited twice")
    pdb.import_template(conn, TEMPLATE_V2)
    check("two versions coexist", len(pdb.list_template_versions(conn, "word-edit")) == 2)
    latest = pdb.get_template(conn, "word-edit")
    check("latest version wins without explicit version",
          latest is not None and latest.version == "1.1.0")
    v1 = pdb.get_template(conn, "word-edit", "1.0.0")
    check("explicit version lookup", v1 is not None and v1.version == "1.0.0")
    try:
        pdb.import_template(conn, {"id": "no-version"})
        check("template without version refused", False)
    except ValueError:
        check("template without version refused", True)
    try:
        pdb.import_template(conn, {"version": "1.0.0"})
        check("template without id refused", False)
    except ValueError:
        check("template without id refused", True)

    # --- run creation: immutable snapshot + hash (spec §4 / #36 rule 1) ---
    run_a = pdb.create_run(conn, TEMPLATE, inputs={"document_ref": "src.docx"}, card_id="card-42")
    run = pdb.get_run(conn, run_a)
    snapshot = json.dumps(TEMPLATE, ensure_ascii=False, sort_keys=True)
    check("run starts queued", run is not None and run.status == "queued")
    check("run carries the snapshot", run is not None and run.template_snapshot == TEMPLATE)
    check("run carries the snapshot hash",
          run is not None and run.template_hash == hashlib.sha256(snapshot.encode()).hexdigest())
    check("one card = one run: runs_for_card", [r.id for r in pdb.runs_for_card(conn, "card-42")] == [run_a])
    check("card_id recorded on the run", run is not None and run.card_id == "card-42")
    # editing the template afterwards cannot touch the run (rule 1)
    TEMPLATE["name"] = "MUTATED"
    run_after = pdb.get_run(conn, run_a)
    check("editing the source template leaves the run's snapshot untouched",
          run_after is not None and run_after.template_snapshot["name"] == "Edit Word document")
    pdb.delete_template(conn, "word-edit", "1.1.0")
    check("deleting the template leaves the run", pdb.get_run(conn, run_a) is not None)

    # --- run transitions + events, atomically (rule 3) ---
    events_a = pdb.list_events(conn, run_a)
    check("run.created event on creation", [e.type for e in events_a] == ["run.created"])
    pdb.set_run_status(conn, run_a, "running")
    seq = pdb.finish_run(conn, run_a, "completed", result={"document_ref": "out.docx"})
    run = pdb.get_run(conn, run_a)
    types = [e.type for e in pdb.list_events(conn, run_a)]
    check("status + terminal event atomic", types == ["run.created", "run.running", "run.completed"])
    check("terminal run stamps ended_at",
          run is not None and run.ended_at is not None and run.status == "completed")
    check("started_at stamped on first running", run is not None and run.started_at is not None)
    check("result stored", run is not None and run.result == {"document_ref": "out.docx"})
    seqs = [e.seq for e in pdb.list_events(conn, run_a)]
    check("seq strictly increases within a run", seqs == sorted(seqs) and len(set(seqs)) == len(seqs))
    after = pdb.list_events(conn, run_a, after_seq=seqs[1])
    check("after_seq cursor (catch-up read)", [e.seq for e in after] == seqs[2:])
    ids = [e.event_id for e in pdb.list_events(conn, run_a)]
    check("event_id present for dedupe", all(i.startswith("evt_") for i in ids) and len(set(ids)) == len(ids))
    try:
        pdb.set_run_status(conn, run_a, "running")
        check("terminal run refuses transitions", False)
    except ValueError:
        check("terminal run refuses transitions", True)

    # --- run B: attempts + user_input lifecycle ---
    run_b = pdb.create_run(conn, dict(TEMPLATE, name="second", version="1.0.0"), card_id="card-43")
    pdb.set_run_status(conn, run_b, "running")
    att1 = pdb.create_attempt(conn, run_b, "edit", attempt_no=1,
                              input_snapshot={"instruction": "edit para 2"}, idempotency_key="k-1")
    pdb.start_attempt(conn, att1, execution_id="pid-4711")
    a1 = pdb.get_attempt(conn, att1)
    check("attempt started with execution_id",
          a1 is not None and a1.status == "running" and a1.execution_id == "pid-4711")
    check("ordinal is the per-run attempt order", a1 is not None and a1.ordinal == 1)
    check("first attempt bumps step_executions", pdb.get_run(conn, run_b).step_executions == 1)
    check("current_step_id follows the attempt", pdb.get_run(conn, run_b).current_step_id == "edit")

    # user_input: run waiting + open request, one transaction (rule 4)
    req1 = pdb.open_input_request(conn, run_b, "edit", att1, prompt="Which paragraph?",
                                  wait_timeout_seconds=120)
    run_row = pdb.get_run(conn, run_b)
    r1 = pdb.get_input_request(conn, req1)
    check("run waiting_input with an open request",
          run_row is not None and run_row.status == "waiting_input"
          and r1 is not None and r1.status == "open")
    check("wait deadline recorded",
          r1 is not None and r1.deadline is not None and r1.wait_timeout_seconds == 120)

    # retry: a new request_id invalidates the old one (rule 4)
    att2 = pdb.create_attempt(conn, run_b, "edit", attempt_no=2)
    req2 = pdb.open_input_request(conn, run_b, "edit", att2, prompt="Still which paragraph?")
    r1_old = pdb.get_input_request(conn, req1)
    check("old request invalidated on retry",
          r1_old is not None and r1_old.status == "invalidated" and r1_old.closed_at is not None)
    r2_new = pdb.get_input_request(conn, req2)
    check("new request open", r2_new is not None and r2_new.status == "open")
    check("technical retry does not bump step_executions", pdb.get_run(conn, run_b).step_executions == 1)
    a2_row = pdb.get_attempt(conn, att2)
    check("ordinal still grows across retries", a2_row is not None and a2_row.ordinal == 2)

    # answer: accepted response + closed_at (rule 4)
    answered = pdb.answer_input_request(conn, req2, {"text": "para 2"}, responded_by="ui")
    check("accepted response recorded",
          answered.accepted_response == {"text": "para 2"} and answered.responded_at is not None
          and answered.closed_at is not None and answered.status == "answered")
    try:
        pdb.answer_input_request(conn, req2, {"text": "late duplicate"})
        check("replay of an answered request refused", False)
    except ValueError:
        check("replay of an answered request refused", True)
    try:
        pdb.answer_input_request(conn, req1, {"text": "stale"})
        check("response to an invalidated request refused", False)
    except ValueError:
        check("response to an invalidated request refused", True)

    # attempts finish; unknown is a first-class outcome (rule 5 / spec §7)
    pdb.finish_attempt(conn, att1, "completed", output={"doc": "edited"})
    pdb.finish_attempt(conn, att2, "unknown", error_code="restart_unknown")
    a1_done = pdb.get_attempt(conn, att1)
    check("attempt completed", a1_done is not None and a1_done.status == "completed")
    a2 = pdb.get_attempt(conn, att2)
    check("unknown outcome stored with error_code",
          a2 is not None and a2.status == "unknown" and a2.error_code == "restart_unknown"
          and a2.ended_at is not None)
    step_events = [e.type for e in pdb.list_events(conn, run_b)]
    check("attempt events on the run log",
          "step.started" in step_events and "step.completed" in step_events and "step.failed" in step_events)

    # timeout/stop: close open requests
    req3 = pdb.open_input_request(conn, run_b, "edit", att2, prompt="One more?")
    closed = pdb.invalidate_input_requests(conn, run_id=run_b, status="cancelled", reason="stop")
    r3 = pdb.get_input_request(conn, req3)
    check("invalidate_input_requests closes the open request",
          closed == 1 and r3 is not None and r3.status == "cancelled")
    pdb.set_run_status(conn, run_b, "cancelled", error="user stop", error_code="stopped")

    # --- run C: blocked / rework counters ---
    run_c = pdb.create_run(conn, TEMPLATE, card_id="card-44")
    attc = pdb.create_attempt(conn, run_c, "review")
    pdb.start_attempt(conn, attc, execution_id="pid-42")
    pdb.finish_attempt(conn, attc, "unknown")
    pdb.set_run_status(conn, run_c, "blocked", error="worker lost", error_code="unknown_outcome")
    run_c_row = pdb.get_run(conn, run_c)
    check("blocked run", run_c_row is not None and run_c_row.status == "blocked")
    check("blocked event recorded",
          "run.blocked" in [e.type for e in pdb.list_events(conn, run_c)])
    n = pdb.bump_rework_cycles(conn, run_c)
    check("rework counter", n == 1 and pdb.get_run(conn, run_c).rework_cycles == 1)

    # --- artifacts (rule 5) ---
    art = pdb.register_artifact(
        conn, run_c, filename="edited.docx",
        storage_ref=f"artifacts/{run_c}/edited.docx", size=2048,
        mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        checksum=hashlib.sha256(b"fake docx bytes").hexdigest(), owner="scope-local")
    arts = pdb.list_artifacts(conn, run_c)
    check("artifact registered with metadata",
          len(arts) == 1 and arts[0].filename == "edited.docx" and arts[0].size == 2048
          and bool(arts[0].checksum) and arts[0].owner == "scope-local" and arts[0].id == art)
    payload = arts[0].to_dict()
    check("artifact payload carries no filesystem path",
          "storage_ref" not in payload and "/" not in json.dumps(payload))
    server = arts[0].to_dict(include_storage_ref=True)
    check("server-side row keeps the relative ref",
          server["storage_ref"] == f"artifacts/{run_c}/edited.docx")
    try:
        pdb.register_artifact(conn, run_c, filename="x", storage_ref="/etc/passwd", size=1)
        check("absolute storage_ref refused", False)
    except ValueError:
        check("absolute storage_ref refused", True)
    try:
        pdb.register_artifact(conn, run_c, filename="x", storage_ref="../escape", size=1)
        check("traversal storage_ref refused", False)
    except ValueError:
        check("traversal storage_ref refused", True)

    # --- isolation: two runs, two cards (rule 6) ---
    check("runs_for_card separates the three cards",
          [len(pdb.runs_for_card(conn, c)) for c in ("card-42", "card-43", "card-44")] == [1, 1, 1])
    check("attempt logs do not mix", len(pdb.list_attempts(conn, run_b)) == 2
          and len(pdb.list_attempts(conn, run_c)) == 1)
    b_events = {e.run_id for e in pdb.list_events(conn, run_b)}
    check("event log is per run", b_events == {run_b})

    # --- reopen: schema init is idempotent, data survives ---
    conn.close()
    conn2 = pdb.connect(db_path=db_path)
    run_a_reopened = pdb.get_run(conn2, run_a)
    check("reopen is idempotent and data survives",
          run_a_reopened is not None and run_a_reopened.status == "completed")
    conn2.close()

    # --- the six objects exist as tables; nothing else touched ---
    conn3 = pdb.connect(db_path=db_path)
    tables = {r["name"] for r in conn3.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()}
    conn3.close()
    expected = {"scenario_templates", "pipeline_runs", "step_attempts", "input_requests",
                "run_events", "artifacts"}
    check("the six spec §4 tables exist", expected <= tables)
    check("no unrelated tables invented", tables - expected <= {"sqlite_sequence"})

print("ALL CHECKS PASSED")
