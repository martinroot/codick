"""Prove the repo's own guard would have caught the incident.

`tests/conftest.py` installs `_forbid_real_hermes_home_io` as an **autouse
pytest fixture**, which patches `sqlite3.connect`. Running a test as
`python3 test.py` loads no conftest, so no fixture fires and the guard is
simply absent.

The block-loop-reset test wrote 12 cards into Martin's real board and caused
the running gateway to spawn four real workers on them, because it resolved
`kanban_db_path()` from the live home. This file is that same mistake,
reproduced deliberately against a disposable "real home" so the guard can be
seen to reject it.

    python3 -m pytest tests/hermes_cli/test_block_loop_home_guard.py -v
"""

from __future__ import annotations

import sqlite3
import textwrap
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def protected_home(tmp_path, monkeypatch):
    """Stand in for the real Hermes root, pointed at a tmp dir."""
    from tests import conftest

    root = tmp_path / "protected_home"
    root.mkdir()
    monkeypatch.setattr(conftest, "_REAL_HERMES_ROOT_CANDIDATES", [root])
    yield root
    # Restore before tmp_path cleanup, even on assertion failure.
    monkeypatch.setattr(conftest, "_REAL_HERMES_ROOT_CANDIDATES", [])


def test_the_guard_blocks_sqlite_writes_into_the_real_home(protected_home):
    """The guard exists, is autouse, and covers sqlite3 — this is the proof.

    Without this, "the suite has a real-home guard" is a claim about a
    mechanism that only exists while pytest is driving.
    """
    target = protected_home / "kanban.db"
    with pytest.raises(Exception) as excinfo:
        sqlite3.connect(str(target)).execute("CREATE TABLE t (x INTEGER)")
    message = str(excinfo.value)
    assert "protected" in message or "real" in message.lower(), message


def test_hermes_kanban_db_is_the_knob_that_isolates_the_board(tmp_path, monkeypatch):
    """HERMES_KANBAN_DB redirects the board; HERMES_HOME does not.

    The incident was a test that set ``HERMES_HOME`` and assumed isolation.
    ``kanban_db_connect.connect`` resolves through ``kanban_db_path()``, which
    reads ``HERMES_KANBAN_DB`` and ignores ``HERMES_HOME`` — so the test wrote
    to the live board. This pins which variable actually works, so the next
    author does not have to discover it by writing to production.
    """
    from hermes_cli import kanban_db_connect as kbc

    redirect = tmp_path / "redirected" / "kanban.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(redirect))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "ignored-home"))
    # The connect path is cached per-process on first use; clear it so this
    # sees the env it was just given rather than an earlier resolution.
    kbc._INITIALIZED_PATHS.clear()  # noqa: SLF001
    try:
        assert Path(str(kbc._kb.kanban_db_path())).resolve() == redirect.resolve()  # noqa: SLF001
    finally:
        kbc._INITIALIZED_PATHS.clear()  # noqa: SLF001
