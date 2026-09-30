"""Does the block-loop reset valve reopen the loop it was built to protect against?

`unblock_task` deliberately does not clear `block_recurrences` — that amnesia is
what let a cron-driven unblock/re-block cycle run unbounded, and only
`complete_task` clears the counter. `reset_block_loop` is the supported way out
for a counter set by a probe, a mistake, or a stale actor. It is worth exactly
nothing if it is reachable from the automatic path, so the first half of this
file proves it is not.

Run with pytest, or directly (pytest is not installed in every environment):

    python3 tests/hermes_cli/test_block_loop_reset.py
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

# HERMES_KANBAN_DB, not HERMES_HOME. `kanban_db_connect.connect` resolves its
# path through `kanban_db_path()`, which reads this variable and ignores
# HERMES_HOME entirely — so setting HERMES_HOME alone pointed this test at
# Martin's real board. It wrote cards there, the running gateway's
# auto-decomposer picked one up, spawned four real workers on the resulting
# subtasks, and burned real tokens on a task that did not exist. Pin the path
# explicitly, and assert we got our own file before writing a single row.
_TMP_DB = tempfile.mkdtemp(prefix="block-loop-reset-test-") + "/kanban.db"
os.environ["HERMES_KANBAN_DB"] = _TMP_DB

from hermes_cli import kanban_db_connect as kbc  # noqa: E402

if os.path.realpath(str(kbc._kb.kanban_db_path())) != os.path.realpath(_TMP_DB):  # noqa: SLF001
    raise SystemExit(
        f"refusing to run against the real board: resolved "
        f"{kbc._kb.kanban_db_path()} instead of {_TMP_DB}"  # noqa: SLF001
    )
from hermes_cli import kanban_db as kb
from hermes_cli import kanban_db_connect as kbc


# One long-lived connection. `connect_closing()` is a context manager, so
# `.__enter__()` on a throwaway object hands back an already-closed handle.
_CM = kbc.connect_closing()
CONN = _CM.__enter__()


def connect():
    return CONN


kb.connect = connect

def _ev(conn, t):
    return [row[0] for row in conn.execute(
        "SELECT payload FROM task_events WHERE task_id=? AND kind='block_loop_reset'", (t,))]


FAILURES: list[str] = []


def check(name, cond, extra=""):
    print(("  ok   " if cond else "  FAIL ") + name + (f"  {extra}" if extra else ""))
    if not cond:
        FAILURES.append(name)
    return cond

def mk(status="ready"):
    return kb.create_task(kb.connect(), title=f"valve test {status}")

# --- 1. unblock alone must NOT clear the counter (the loop protection) -----
tid = mk()
c = kb.connect()
kb.block_task(c, tid, reason="cause A", kind="transient")
kb.block_task(c, tid, reason="cause A", kind="transient")
before = kb.get_task(c, tid)
check("counter accumulates across blocks", before.block_recurrences >= 1,
      f"recurrences={before.block_recurrences}")
kb.unblock_task(c, tid)
after = kb.get_task(c, tid)
check("unblock does NOT clear the counter (loop protection intact)",
      after.block_recurrences == before.block_recurrences and after.block_kind is not None,
      f"before={before.block_recurrences} after={after.block_recurrences}")

# ...and a third block still trips the guard, proving the protection is live.
kb.block_task(c, tid, reason="cause A", kind="transient")
t3 = kb.get_task(c, tid)
check("the guard still diverts after unblock+reblock", t3.status != "blocked" or t3.block_recurrences >= 2,
      f"status={t3.status} recurrences={t3.block_recurrences}")

# --- 2. the valve clears it, and only on request ----------------------------
tid2 = mk()
c2 = kb.connect()
kb.block_task(c2, tid2, reason="cause A", kind="transient")
kb.block_task(c2, tid2, reason="cause A", kind="transient")
pre = kb.get_task(c2, tid2)
check("premise: a spent counter exists", pre.block_recurrences >= 1, f"recurrences={pre.block_recurrences}")

ok = kb.reset_block_loop(c2, tid2, reason="set by a probe, not a real block")
post = kb.get_task(c2, tid2)
check("the valve clears the counter", ok is True and post.block_recurrences == 0 and post.block_kind is None,
      f"after recurrences={post.block_recurrences} kind={post.block_kind}")
check("the valve does not change status", post.status == pre.status, f"{pre.status} -> {post.status}")
check("the valve does not complete the task", post.status != "done", f"status={post.status}")
ev = _ev(c2, tid2)
check("it leaves an event naming the cleared value and the reason",
      len(ev) == 1
      and "set by a probe" in ev[0]
      and f'"cleared_recurrences": {pre.block_recurrences}' in ev[0]
      and f'"cleared_kind": "{pre.block_kind}"' in ev[0],
      f"{ev}")

# --- 3. idempotent, and honest when there is nothing to clear ---------------
check("a second reset reports nothing to do", kb.reset_block_loop(c2, tid2) is False)
tid3 = mk()
c3 = kb.connect()
check("reset on a never-blocked task reports nothing to do", kb.reset_block_loop(c3, tid3) is False)

# --- 4. a real block after the reset is counted from zero -------------------
kb.block_task(c2, tid2, reason="a genuinely different cause", kind="dependency")
r4 = kb.get_task(c2, tid2)
check("a real block after the reset starts the count again", r4.block_recurrences == 1,
      f"recurrences={r4.block_recurrences}")

def test_unblock_still_preserves_the_counter():
    """The protection the valve must not weaken."""
    tid = mk()
    c = kb.connect()
    kb.block_task(c, tid, reason="cause A", kind="transient")
    kb.block_task(c, tid, reason="cause A", kind="transient")
    before = kb.get_task(c, tid)
    assert before.block_recurrences >= 1
    kb.unblock_task(c, tid)
    after = kb.get_task(c, tid)
    assert after.block_recurrences == before.block_recurrences
    assert after.block_kind is not None
    # And the guard is genuinely live: a third block still diverts.
    kb.block_task(c, tid, reason="cause A", kind="transient")
    assert kb.get_task(c, tid).status == "triage"


def test_the_valve_clears_without_completing():
    tid = mk()
    c = kb.connect()
    kb.block_task(c, tid, reason="cause A", kind="transient")
    kb.block_task(c, tid, reason="cause A", kind="transient")
    pre = kb.get_task(c, tid)
    assert kb.reset_block_loop(c, tid, reason="set by a probe, not a real block") is True
    post = kb.get_task(c, tid)
    assert post.block_recurrences == 0 and post.block_kind is None
    assert post.status == pre.status, "clearing the counter must not move the card"
    assert post.status != "done"
    ev = _ev(c, tid)
    assert len(ev) == 1
    assert f'"cleared_recurrences": {pre.block_recurrences}' in ev[0]
    assert f'"cleared_kind": "{pre.block_kind}"' in ev[0]
    assert "set by a probe" in ev[0]
    # Idempotent, and honest when there was never anything to clear.
    assert kb.reset_block_loop(c, tid) is False
    never_blocked = mk()
    assert kb.reset_block_loop(kb.connect(), never_blocked) is False
    # A real block afterwards is counted on its own merits.
    kb.block_task(c, tid, reason="a genuinely different cause", kind="dependency")
    assert kb.get_task(c, tid).block_recurrences == 1


if __name__ == "__main__":
    if FAILURES:
        print(f"\nFAILED: {len(FAILURES)} -> {FAILURES}")
        sys.exit(1)
    print("\nvalve holds: unblock still protected, reset clears only on request")
