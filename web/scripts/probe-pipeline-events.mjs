"""One-shot behaviour probe for the pipeline events feed (issue #43).

Python in a .mjs file is this repo's probe convention (probe-pipeline-storage.mjs
and the other pipeline probes are run with ``python3``, not node) — kept so the
family stays uniform. Not a pytest file: the scratch/test environments on this
machine have no pytest and none may be installed; CI on this repo does not run
the Python suite.

Exercises the real router (hermes_cli/web_routers/pipelines.py) over the real
pipelines_db through a Starlette TestClient, against a throwaway HERMES_HOME,
then proves the route is actually mounted on the dashboard app.
"""

from __future__ import annotations

import os
import sys
import contextlib
import tempfile
from pathlib import Path

sys.path.insert(0, "/home/grokwin/dev/hermes-multiserver-web-bootstrap")

REPO = Path("/home/grokwin/dev/hermes-multiserver-web-bootstrap")
tmp = tempfile.mkdtemp(prefix="pl-events-")
os.environ["HERMES_HOME"] = tmp  # resolved on every call by pipelines_db

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from hermes_cli import pipelines_db as pdb  # noqa: E402
from hermes_cli.web_routers import pipelines as pl_api  # noqa: E402

assert str(Path(os.environ["HERMES_HOME"])) == tmp


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
    "steps": [{"id": "edit", "type": "agent", "title": "Edit"}],
}

with contextlib.closing(pdb.connect()) as conn:
    pdb.import_template(conn, TEMPLATE)
    run_id = pdb.create_run(conn, TEMPLATE, inputs={"document_ref": "src.docx"})
    for ev_type, payload in [("run.started", None), ("step.started", {"step_id": "edit"}),
                             ("step.progress", {"note": "halfway"}), ("run.completed", {"ok": True})]:
        pdb.append_event(conn, run_id, ev_type, payload=payload, step_id="edit")

app = FastAPI()
app.include_router(pl_api.router)
client = TestClient(app)

# --- 1. unknown run is a 404, not an empty feed --------------------------------
r = client.get("/api/pipelines/runs/run_nope/events")
check("unknown run -> 404", r.status_code == 404, f"got {r.status_code}")

# --- 2. full feed: seq strictly ascending, full event shape --------------------
r = client.get(f"/api/pipelines/runs/{run_id}/events")
check("full feed -> 200", r.status_code == 200, f"got {r.status_code}")
body = r.json()
seqs = [e["seq"] for e in body["events"]]
check("count matches", body["count"] == 5 and len(seqs) == 5)
check("seq strictly ascending", seqs == sorted(set(seqs)) and len(seqs) == len(set(seqs)))
first = body["events"][0]
shape = {"event_id", "schema_version", "run_id", "step_id", "attempt_id", "request_id",
         "seq", "occurred_at", "type", "payload"}
check("event shape (spec §11)", set(first.keys()) == shape, str(sorted(first.keys())))
check("types preserved", [e["type"] for e in body["events"]] ==
      ["run.created", "run.started", "step.started", "step.progress", "run.completed"])
check("run_id echoes", body["run_id"] == run_id)
check("latest_seq is the tail", body["latest_seq"] == max(seqs))

# --- 3. cursor: after_seq excludes, dedupe stays consistent --------------------
k = seqs[2]
r = client.get(f"/api/pipelines/runs/{run_id}/events", params={"after_seq": k})
after = r.json()
check("after_seq returns strictly later events",
      [e["seq"] for e in after["events"]] == [s for s in seqs if s > k])
r = client.get(f"/api/pipelines/runs/{run_id}/events", params={"after_seq": body["latest_seq"]})
check("cursor at tail -> empty feed", r.json()["events"] == [])

# --- 4. limit ------------------------------------------------------------------
r = client.get(f"/api/pipelines/runs/{run_id}/events", params={"limit": 1})
check("limit caps the page", r.json()["count"] == 1 and r.json()["events"][0]["seq"] == seqs[0])

# --- 5. input validation -------------------------------------------------------
r = client.get(f"/api/pipelines/runs/{run_id}/events", params={"after_seq": -1})
check("negative after_seq -> 422", r.status_code == 422, f"got {r.status_code}")
r = client.get(f"/api/pipelines/runs/{run_id}/events", params={"limit": 0})
check("limit=0 -> 422", r.status_code == 422, f"got {r.status_code}")

# --- 6. mounted on the real dashboard app -------------------------------------
from hermes_cli.web_server import app as dashboard_app  # noqa: E402

routes = {getattr(rt, "path", "") for rt in dashboard_app.routes}
check("route mounted on the dashboard app",
      "/api/pipelines/runs/{run_id}/events" in routes,
      str(sorted(p for p in routes if "pipelines" in p)))

print("ALL PASS")
