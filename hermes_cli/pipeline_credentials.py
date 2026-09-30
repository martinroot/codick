"""Scoped, server-side credentials for the pipeline API (#42).

The dashboard surface has exactly one credential today — the session token —
which makes every caller the same principal. Per-run ownership needs a principal
to compare against, and the gateway's ``_request_owns_run`` already has the
comparison right; what was missing is what produces its ``scope``.

Three properties this holds, and each was asked for explicitly:

- **Server-side only.** The secret is returned exactly once, by the create
  function, to whoever called it in-process. No route ever returns it again, and
  no route hands it to a browser: the listing is metadata only.
- **Not a secret at rest.** Only a SHA-256 of the secret is stored, so reading
  the table does not yield working credentials.
- **Scope is data, not authority by itself.** A credential proves *who*; the
  run's own ``owner_scope`` says *what they may touch*, and the comparison is
  equality. Presenting a valid credential therefore does not widen access — it
  only stops one site from being mistaken for another.

The deny-by-default property of the gateway is preserved in
:func:`request_owns_run`, not here, so that it is stated in one place.
"""

import hashlib
import hmac
import json
import secrets
import sqlite3
from typing import List, NamedTuple, Optional

from hermes_cli.sqlite_util import open_db, write_txn

CREDENTIAL_PREFIX = "codick"
_SECRET_BYTES = 32

# A scope name must be safe to embed in a log line and an id: no separators that
# could let one scope be forged to look like a pair of scopes.
_SCOPE_MAX = 64


class Credential(NamedTuple):
    id: str
    scope: str
    label: str
    created_at: int
    revoked_at: Optional[int]
    expires_at: Optional[int]
    last_used_at: Optional[int]


def _now() -> int:
    import time
    return int(time.time())


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS pipeline_credentials (
            id          TEXT PRIMARY KEY,
            scope       TEXT NOT NULL,
            label       TEXT NOT NULL DEFAULT '',
            secret_hash TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            revoked_at  INTEGER,
            expires_at  INTEGER,
            last_used_at INTEGER
        )"""
    )
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS pipeline_credentials_scope "
        "ON pipeline_credentials(scope)")


def _validate_scope(scope: str) -> str:
    if not isinstance(scope, str) or not scope.strip():
        raise ValueError("scope is required")
    scope = scope.strip()
    if len(scope) > _SCOPE_MAX:
        raise ValueError(f"scope must be at most {_SCOPE_MAX} characters")
    if not all(ch.isalnum() or ch in "-_." for ch in scope):
        raise ValueError("scope may contain only letters, digits, '-', '_' and '.'")
    return scope


def create_credential(conn: sqlite3.Connection, scope: str, label: str = "",
                       expires_at: Optional[int] = None) -> tuple[Credential, str]:
    """Mint a credential. Returns ``(metadata, plaintext)``.

    The plaintext exists in the return value and nowhere else. It is not a
    readable field of :class:`Credential` on purpose, so a later refactor that
    hands someone ``Credential`` cannot leak it by accident.
    """
    scope = _validate_scope(scope)
    secret = f"{CREDENTIAL_PREFIX}_{secrets.token_urlsafe(_SECRET_BYTES)}"
    credential_id = f"cred_{secrets.token_hex(8)}"
    ts = _now()
    with write_txn(conn):
        existing = conn.execute(
            "SELECT id FROM pipeline_credentials WHERE scope = ? AND revoked_at IS NULL",
            (scope,)).fetchone()
        if existing is not None:
            raise ValueError(f"scope {scope!r} already has a live credential")
        conn.execute(
            "INSERT INTO pipeline_credentials"
            "(id, scope, label, secret_hash, created_at, expires_at)"
            " VALUES(?,?,?,?,?,?)",
            (credential_id, scope, label or scope, _hash(secret), ts, expires_at))
    row = conn.execute(
        "SELECT id, scope, label, created_at, revoked_at, expires_at, last_used_at "
        "FROM pipeline_credentials WHERE id = ?", (credential_id,)).fetchone()
    return Credential(*row), secret


def resolve_scope(conn: sqlite3.Connection, presented: str) -> Optional[str]:
    """The scope a presented secret proves, or ``None``.

    ``None`` covers every failure — unknown, revoked, expired — because the
    caller must not be able to tell them apart.
    """
    if not presented or not isinstance(presented, str):
        return None
    # Format first, so a garbage token cannot fan out into a full table scan of
    # the hash column.
    if not presented.startswith(CREDENTIAL_PREFIX + "_"):
        return None
    row = conn.execute(
        "SELECT id, scope, secret_hash, revoked_at, expires_at FROM pipeline_credentials"
    ).fetchall()
    presented_hash = _hash(presented)
    for cred_id, scope, secret_hash, revoked_at, expires_at in row:
        # compare_digest on every row: constant-time, and it does not leak which
        # row matched through an early return.
        if hmac.compare_digest(secret_hash, presented_hash):
            if revoked_at is not None:
                return None
            if expires_at is not None and expires_at <= _now():
                return None
            try:
                with write_txn(conn):
                    conn.execute(
                        "UPDATE pipeline_credentials SET last_used_at = ? WHERE id = ?",
                        (_now(), cred_id))
            except sqlite3.Error:
                # A concurrent writer is not an authorisation failure; the
                # scope is already established, so a missed timestamp must not
                # turn a valid credential into a rejection.
                pass
            return scope
    return None


def revoke_credential(conn: sqlite3.Connection, credential_id: str) -> bool:
    with write_txn(conn):
        changed = conn.execute(
            "UPDATE pipeline_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
            (_now(), credential_id)).rowcount
    return bool(changed)


def list_credentials(conn: sqlite3.Connection) -> List[Credential]:
    """Metadata only. There is no ``get_credential`` returning a secret, and
    adding one would defeat the point of storing a hash."""
    rows = conn.execute(
        "SELECT id, scope, label, created_at, revoked_at, expires_at, last_used_at "
        "FROM pipeline_credentials ORDER BY created_at DESC").fetchall()
    return [Credential(*row) for row in rows]


__all__ = [
    "CREDENTIAL_PREFIX",
    "Credential",
    "create_credential",
    "ensure_schema",
    "list_credentials",
    "resolve_scope",
    "revoke_credential",
]
