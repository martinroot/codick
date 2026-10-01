"""What a run actually cost (#58).

Three rules shape this module, and all three came from the same failure mode —
a number that looks measured and is not.

**Unknown is not zero.** A provider that reported nothing leaves the token
columns NULL and ``cost_status = 'unknown'``. A zero would be indistinguishable
from a genuinely free step, and the whole point of measuring is to tell those
two apart. This is the same rule the executor already follows for an unknown
*outcome*: it must never be smoothed into a clean value.

**Cached input is not input.** Providers bill cache reads at a different rate,
so the columns are kept apart all the way to the total. Summing them first and
pricing the sum is how a cheap-looking run turns out expensive.

**The rate that applied is kept with the number.** ``step_usage`` stores its own
snapshot of the tariffs used. A rate table that is edited next month must not
retroactively change what last month's run cost, which is the difference between
a measurement and a derivation.

Tool steps are recorded too, with their own cost and no tokens. A DOCX export
costs nothing in tokens and should still appear in the ledger with a zero,
rather than vanishing and making the run look cheaper than it was.
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from dataclasses import dataclass
from typing import Any, Mapping, Optional

from hermes_cli.sqlite_util import write_txn

MONEY = "micros"  # integer minor units; never a float in storage


@dataclass(frozen=True)
class Usage:
    """One step's consumption. ``None`` for a token count means unknown."""

    step_id: str
    kind: str = "model"
    model: Optional[str] = None
    provider: Optional[str] = None
    input_tokens: Optional[int] = None
    cached_input: Optional[int] = None
    output_tokens: Optional[int] = None
    tool_cost_micros: Optional[int] = None

    @property
    def is_known(self) -> bool:
        """Whether anything here was actually measured.

        A tool step with an explicit zero cost *is* known. A step where the
        provider said nothing is not, and says so rather than reporting 0.
        """
        if self.kind == "tool":
            return self.tool_cost_micros is not None
        return None not in (
            self.input_tokens,
            self.cached_input,
            self.output_tokens,
        )


def _new_id() -> str:
    return f"use_{uuid.uuid4().hex[:16]}"


def record_usage(
    conn: sqlite3.Connection,
    *,
    run_id: str,
    attempt_id: Optional[str],
    usage: Usage,
    cost_micros: Optional[int] = None,
    rate_key: Optional[str] = None,
    applied_rates: Optional[Mapping[str, Any]] = None,
    now: Optional[int] = None,
) -> str:
    """Write one usage row. Re-recording the same attempt+kind replaces it."""
    stamp = int(time.time()) if now is None else now
    usage_id = _new_id()
    status = "known" if (usage.is_known and cost_micros is not None) else "unknown"
    with write_txn(conn):
        conn.execute(
            """
            INSERT INTO step_usage
                (id, run_id, attempt_id, step_id, kind, model, provider,
                 input_tokens, cached_input, output_tokens, tool_cost_micros,
                 rate_key, applied_rates, cost_micros, cost_status, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(attempt_id, kind, step_id) DO UPDATE SET
                model = excluded.model,
                provider = excluded.provider,
                input_tokens = excluded.input_tokens,
                cached_input = excluded.cached_input,
                output_tokens = excluded.output_tokens,
                tool_cost_micros = excluded.tool_cost_micros,
                rate_key = excluded.rate_key,
                applied_rates = excluded.applied_rates,
                cost_micros = excluded.cost_micros,
                cost_status = excluded.cost_status,
                recorded_at = excluded.recorded_at
            """,
            (
                usage_id, run_id, attempt_id, usage.step_id, usage.kind,
                usage.model, usage.provider, usage.input_tokens,
                usage.cached_input, usage.output_tokens, usage.tool_cost_micros,
                rate_key,
                json.dumps(dict(applied_rates), sort_keys=True) if applied_rates else None,
                cost_micros, status, stamp,
            ),
        )
    return usage_id


# --- rates --------------------------------------------------------------------


def upsert_rate(
    conn: sqlite3.Connection,
    *,
    rate_key: str,
    provider: str,
    model: str,
    input_micros: int,
    output_micros: int,
    cached_micros: Optional[int] = None,
    currency: str = "USD",
    effective_from: Optional[int] = None,
    source: Optional[str] = None,
    note: Optional[str] = None,
) -> str:
    """Record a tariff. Stored here rather than in code so it can be corrected
    without a deploy, and so a past run keeps the rate that was applied."""
    stamp = int(effective_from if effective_from is not None else time.time())
    with write_txn(conn):
        conn.execute(
            """
            INSERT INTO provider_rates
                (rate_key, provider, model, currency, input_micros, cached_micros,
                 output_micros, effective_from, source, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(rate_key) DO UPDATE SET
                provider = excluded.provider,
                model = excluded.model,
                currency = excluded.currency,
                input_micros = excluded.input_micros,
                cached_micros = excluded.cached_micros,
                output_micros = excluded.output_micros,
                effective_from = excluded.effective_from,
                source = excluded.source,
                note = excluded.note
            """,
            (rate_key, provider, model, currency, input_micros, cached_micros,
             output_micros, stamp, source, note),
        )
    return rate_key


def current_rate(conn: sqlite3.Connection, provider: str, model: str) -> Optional[sqlite3.Row]:
    """The tariff in force right now for one provider/model pair."""
    return conn.execute(
        """
        SELECT * FROM provider_rates
         WHERE provider = ? AND model = ? AND effective_from <= ?
         ORDER BY effective_from DESC LIMIT 1
        """,
        (provider, model, int(time.time())),
    ).fetchone()


def price(usage: Usage, rate: Optional[sqlite3.Row]) -> Optional[int]:
    """Cost in micros, or ``None`` when it cannot be known.

    ``None`` here is load-bearing: it becomes ``cost_status = 'unknown'`` and it
    stops the run total from claiming a price nobody measured.
    """
    if not usage.is_known:
        return None
    if usage.kind == "tool":
        # A tool's own cost is whatever the tool said, not something a token
        # tariff can derive.
        return usage.tool_cost_micros
    if rate is None:
        return None
    total = 0
    if usage.input_tokens:
        total += usage.input_tokens * int(rate["input_micros"])
    if usage.cached_input:
        # Absent a cached rate, cached tokens are priced as ordinary input
        # rather than dropped: under-reporting a cost is worse than over it.
        cached_rate = rate["cached_micros"]
        per = int(cached_rate) if cached_rate is not None else int(rate["input_micros"])
        total += usage.cached_input * per
    if usage.output_tokens:
        total += usage.output_tokens * int(rate["output_micros"])
    return total


def price_and_record(
    conn: sqlite3.Connection,
    *,
    run_id: str,
    attempt_id: Optional[str],
    usage: Usage,
    now: Optional[int] = None,
) -> str:
    """Look up the current rate, price the step, and store both.

    The rate snapshot is written alongside the number so the row still says what
    it was priced at after the tariff changes.
    """
    rate = None
    if usage.provider and usage.model:
        rate = current_rate(conn, usage.provider, usage.model)
    cost = price(usage, rate)
    snapshot = None
    if rate is not None:
        snapshot = {
            "rate_key": rate["rate_key"],
            "input_micros": rate["input_micros"],
            "cached_micros": rate["cached_micros"],
            "output_micros": rate["output_micros"],
            "currency": rate["currency"],
            "effective_from": rate["effective_from"],
        }
    return record_usage(
        conn,
        run_id=run_id,
        attempt_id=attempt_id,
        usage=usage,
        cost_micros=cost,
        rate_key=rate["rate_key"] if rate is not None else None,
        applied_rates=snapshot,
        now=now,
    )


# --- reporting ----------------------------------------------------------------


def run_usage(conn: sqlite3.Connection, run_id: str) -> dict:
    """Per-step rows plus a total that is honest about being incomplete."""
    rows = conn.execute(
        "SELECT * FROM step_usage WHERE run_id = ? ORDER BY recorded_at, step_id",
        (run_id,),
    ).fetchall()

    steps = []
    total = 0
    unknown = 0
    for row in rows:
        cost = row["cost_micros"]
        if row["cost_status"] == "known" and cost is not None:
            total += cost
        else:
            unknown += 1
        steps.append({
            "step_id": row["step_id"],
            "kind": row["kind"],
            "model": row["model"],
            "provider": row["provider"],
            "input_tokens": row["input_tokens"],
            "cached_input": row["cached_input"],
            "output_tokens": row["output_tokens"],
            "tool_cost_micros": row["tool_cost_micros"],
            "cost_micros": cost,
            "cost_status": row["cost_status"],
            "rate_key": row["rate_key"],
        })

    measured = [r for r in rows if r["cost_status"] == "known"]
    # A run with no usage rows at all has measured nothing. Reporting `0` there
    # would be the exact failure this module exists to prevent: "nothing was
    # spent" and "nothing was counted" look identical once they are both zero.
    if not rows:
        unknown = 1
    return {
        "run_id": run_id,
        "steps": steps,
        "cost_micros": None if unknown else total,
        "cost_status": "unknown" if unknown else "known",
        "unpriced_steps": unknown,
        "steps_counted": len(measured),
        "model_steps": sum(1 for r in measured if r["kind"] == "model"),
        "tool_steps": sum(1 for r in measured if r["kind"] == "tool"),
        "input_tokens_total": sum(
            r["input_tokens"] for r in rows if r["input_tokens"] is not None
        ),
        "cached_input_total": sum(
            r["cached_input"] for r in rows if r["cached_input"] is not None
        ),
        "output_tokens_total": sum(
            r["output_tokens"] for r in rows if r["output_tokens"] is not None
        ),
    }