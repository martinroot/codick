"""Tests for hermes_cli.kanban_diagnostics — rule-engine that produces
structured distress signals (diagnostics) for kanban tasks.

These tests exercise each rule in isolation using minimal in-memory
task/event/run fixtures (no DB) plus a few integration-style cases
that round-trip through the real kanban_db to make sure the rule
engine works on sqlite3.Row objects as well as dataclasses.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_db_connect as kbc
from hermes_cli import kanban_diagnostics as kd


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


def _task(**overrides):
    base = {
        "id": "t_demo00",
        "title": "demo task",
        "assignee": "demo",
        "status": "ready",
        "consecutive_failures": 0,
        "last_failure_error": None,
    }
    base.update(overrides)
    return base


def _event(kind, ts=None, **payload):
    return {
        "kind": kind,
        "created_at": int(ts if ts is not None else time.time()),
        "payload": payload or None,
    }


def _run(outcome="completed", run_id=1, error=None):
    return {
        "id": run_id,
        "outcome": outcome,
        "error": error,
    }


# ---------------------------------------------------------------------------
# Each rule — positive + negative + clearing
# ---------------------------------------------------------------------------
















def test_running_with_open_parents_fires_only_while_running():
    """A running card whose parent is not terminal is flagged; the same graph
    on a ready/todo card (the gate is holding it) and a done parent are not."""
    graph = {"parents": [{"id": "t_parent", "title": "p", "status": "todo"}], "children": []}
    diags = kd.compute_task_diagnostics(_task(status="running", started_at=100), [], [], graph=graph)
    assert [d.kind for d in diags] == ["running_with_open_parents"]
    assert diags[0].data["open_parents"] == [{"id": "t_parent", "status": "todo"}]
    assert "hermes kanban unlink t_parent t_demo00" in diags[0].actions[0].payload["command"]
    assert kd.compute_task_diagnostics(_task(status="todo"), [], [], graph=graph) == []
    done_graph = {"parents": [{"id": "t_parent", "title": "p", "status": "done"}], "children": []}
    assert kd.compute_task_diagnostics(_task(status="running"), [], [], graph=done_graph) == []


def test_stuck_in_blocked_fires_past_threshold():
    now = int(time.time())
    task = _task(status="blocked")
    events = [
        _event("blocked", ts=now - 3600 * 48, reason="needs approval"),
    ]
    diags = kd.compute_task_diagnostics(
        task, events, [], now=now,
    )
    assert len(diags) == 1
    d = diags[0]
    assert d.kind == "stuck_in_blocked"
    assert d.severity == "warning"
    assert d.data["age_hours"] >= 48


def test_block_loop_detected_fires_on_guard_event():
    now = int(time.time())
    task = _task(status="triage")
    events = [
        _event("blocked", ts=now - 300, reason="compile error", block_kind="failure", recurrences=1),
        _event("unblocked", ts=now - 240),
        _event("blocked", ts=now - 180, reason="compile error", block_kind="failure", recurrences=2),
        _event("block_loop_detected", ts=now - 170, reason="compile error", block_kind="failure",
               recurrences=2, limit=kb.BLOCK_RECURRENCE_LIMIT, source_status="running"),
    ]
    diags = kd.compute_task_diagnostics(task, events, [], now=now)
    loop = [d for d in diags if d.kind == "block_loop_detected"]
    assert len(loop) == 1
    d = loop[0]
    assert d.severity == "warning"
    assert d.data["recurrences"] == 2
    assert d.data["limit"] == kb.BLOCK_RECURRENCE_LIMIT
    assert d.data["block_kind"] == "failure"
    assert d.first_seen_at == now - 170
    assert d.count == 1


def test_block_loop_detected_absent_without_guard_event():
    """A plain blocked/unblocked history below the guard limit must not fire."""
    now = int(time.time())
    events = [
        _event("blocked", ts=now - 60, reason="x", block_kind="failure", recurrences=1),
        _event("unblocked", ts=now - 30),
    ]
    diags = kd.compute_task_diagnostics(_task(status="blocked"), events, [], now=now)
    assert [d for d in diags if d.kind == "block_loop_detected"] == []








# ---------------------------------------------------------------------------
# Severity sorting
# ---------------------------------------------------------------------------




# ---------------------------------------------------------------------------
# Integration — runs through real kanban_db so sqlite.Row fields work
# ---------------------------------------------------------------------------


def test_engine_works_on_sqlite_row_objects(kanban_home):
    """Regression: the rule functions must handle sqlite3.Row (which
    supports mapping access but not attribute access and isn't a dict)
    as well as dataclass Task / plain dict. The API layer passes Row
    objects directly.
    """
    conn = kbc.connect()
    try:
        parent = kb.create_task(conn, title="p", assignee="w")
        real = kb.create_task(conn, title="r", assignee="x", created_by="w")
        with pytest.raises(kb.HallucinatedCardsError):
            kb.complete_task(
                conn, parent,
                summary="with phantom", created_cards=[real, "t_deadbeef1"],
            )
        # Pull Row objects the way the API helper does.
        row = conn.execute(
            "SELECT * FROM tasks WHERE id = ?", (parent,),
        ).fetchone()
        events = list(conn.execute(
            "SELECT * FROM task_events WHERE task_id = ? ORDER BY id",
            (parent,),
        ).fetchall())
        runs = list(conn.execute(
            "SELECT * FROM task_runs WHERE task_id = ? ORDER BY id",
            (parent,),
        ).fetchall())
        diags = kd.compute_task_diagnostics(row, events, runs)
        assert len(diags) == 1
        assert diags[0].kind == "hallucinated_cards"
        assert "t_deadbeef1" in diags[0].data["phantom_ids"]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Error-tolerance: a broken rule shouldn't 500 the whole compute call
# ---------------------------------------------------------------------------




# ---------------------------------------------------------------------------
# stranded_in_ready
#
# Surfaces ready tasks that nobody has claimed within the threshold.
# Identity-agnostic by design: catches typo'd assignees, deleted profiles,
# down external worker pools, and misconfigured dispatchers in one rule.
# ---------------------------------------------------------------------------


def test_stranded_in_ready_fires_for_a_real_machine_profile(monkeypatch):
    """A ready task on a *spawnable* assignee that nobody claimed is a real stall.

    The age rule still applies, and still escalates with age. This is the case
    the rule was written for and it must keep working.
    """
    monkeypatch.setattr(kd, "_assignee_is_machine_lane", lambda assignee: True)
    now = 100_000
    task = _task(status="ready", assignee="demo", claim_lock=None)
    # 45 min = 2700s, threshold = 1800s.
    events = [_event("created", ts=now - 45 * 60)]
    diags = kd.compute_task_diagnostics(task, events, [], now=now)
    stranded = [d for d in diags if d.kind == "stranded_in_ready"]
    assert len(stranded) == 1
    assert stranded[0].severity == "warning"
    assert stranded[0].data["age_seconds"] == 45 * 60
    assert stranded[0].data["assignee"] == "demo"


def test_a_non_profile_assignee_is_not_reported_as_a_stalled_worker(monkeypatch):
    """The false alarm this rule used to raise on human lanes.

    An assignee with no Hermes profile is how a human lane is spelled — the
    dispatcher calls the same fact `skipped_nonspawnable`, "terminal lane, OK".
    Reading it as "a worker should have claimed this and did not", at critical
    severity, is how a board of human-queued work renders as an outage.
    """
    monkeypatch.setattr(kd, "_assignee_is_machine_lane", lambda assignee: False)
    now = 100_000
    task = _task(status="ready", assignee="w", claim_lock=None)
    events = [_event("created", ts=now - 45 * 60)]
    diags = kd.compute_task_diagnostics(task, events, [], now=now)

    # Not a stalled worker, at any severity.
    assert [d for d in diags if d.kind == "stranded_in_ready"] == []
    ours = [d for d in diags if d.kind == "no_machine_will_claim"]
    assert len(ours) == 1
    assert ours[0].severity != "critical"
    assert ours[0].data["machine_lane"] is False
    # The ambiguity is stated rather than guessed at, and the way out is named.
    assert "misspelled" in ours[0].detail
    assert any(a.kind == "reassign" for a in ours[0].actions)


def test_an_unreadable_profile_registry_keeps_the_old_verdict(monkeypatch):
    """Uncertainty must not resolve in the direction of "everything is fine".

    If the registry cannot be imported there is no evidence either way, so the
    rule falls back to the age-based claim it always made.
    """
    monkeypatch.setattr(kd, "_assignee_is_machine_lane", lambda assignee: None)
    now = 100_000
    task = _task(status="ready", assignee="demo", claim_lock=None)
    events = [_event("created", ts=now - 45 * 60)]
    diags = kd.compute_task_diagnostics(task, events, [], now=now)
    assert [d for d in diags if d.kind == "stranded_in_ready"]
    assert [d for d in diags if d.kind == "no_machine_will_claim"] == []




# ---------------------------------------------------------------------------
# triage_aux_unavailable rule — auto-decompose aware
# ---------------------------------------------------------------------------


def _triage_task():
    return _task(id="t_triage1", status="triage")








def test_severity_at_or_above_uses_threshold_semantics():
    assert kd.severity_at_or_above("warning", "warning") is True
    assert kd.severity_at_or_above("error", "warning") is True
    assert kd.severity_at_or_above("critical", "warning") is True
    assert kd.severity_at_or_above("critical", "error") is True
    assert kd.severity_at_or_above("warning", "error") is False
    assert kd.severity_at_or_above("error", "critical") is False
    assert kd.severity_at_or_above("mystery", "warning") is False
    assert kd.severity_at_or_above("warning", None) is True
