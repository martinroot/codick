"""Pipeline runs — REST routes (spec ``docs/pipelines/spec.md`` §11).

Only the read-side events feed lives here so far; the remaining §11 routes are
owned by the stage issues that introduce their executors (#31, #32). The feed is
a plain JSON catch-up read (``?after_seq=N``), not SSE — a client rebuilds after
a break, dedupes on ``event_id``/``seq``, and ``latest_seq`` tells it when it has
reached the tail.
"""

from __future__ import annotations

from contextlib import closing

from fastapi import APIRouter, HTTPException, Query

from hermes_cli import pipelines_db as pdb

router = APIRouter(prefix="/api/pipelines")


def _run_conn():
    """Open the pipelines DB (init is idempotent, so a fresh install self-heals)."""
    return pdb.connect()


@router.get("/runs/{run_id}/events")
def list_run_events(
    run_id: str,
    after_seq: int = Query(0, ge=0, description="Return events with seq strictly greater than this"),
    limit: int | None = Query(None, gt=0, description="Cap on returned events (default: all)"),
) -> dict:
    """Events of one run after ``after_seq`` in strictly ascending ``seq`` order.

    ``run_id`` is resolved first so an unknown run is a 404 even when it also has
    no events — the catch-up read must not be readable for a run that is not
    ours to see (spec §11: ownership is checked on every route).
    """
    with closing(_run_conn()) as conn:
        if pdb.get_run(conn, run_id) is None:
            raise HTTPException(status_code=404, detail=f"run {run_id} not found")
        events = [e.to_dict() for e in pdb.list_events(conn, run_id, after_seq=after_seq, limit=limit)]
        row = conn.execute(
            "SELECT COALESCE(MAX(seq), 0) AS latest FROM run_events WHERE run_id = ?", (run_id,)
        ).fetchone()
    latest_seq = int(row["latest"]) if row is not None else 0
    return {"run_id": run_id, "after_seq": after_seq, "latest_seq": latest_seq, "count": len(events), "events": events}
