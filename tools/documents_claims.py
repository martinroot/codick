"""Does the prose agree with the chart? (#64)

An illustrated report has two independent statements of the same fact: a number
in the computed data, and a sentence claiming that number. Nothing forces them
to match, and the disagreement is the dangerous direction — a chart can be
perfectly drawn from real data while the sentence beside it says something the
data does not support. A reader trusts the sentence more than the axis.

So this module reads the numeric claims out of the text and holds them against
the data that was actually plotted.

## The default is that a number is unexplained

A claim matches if it equals a plotted value. It does **not** match merely
because it looks plausible, and a claim nobody can account for is a finding.
The alternative — scanning for "numbers that look wrong" — requires knowing what
right looks like, which is the dataset's job and not the checker's.

Genuinely legitimate numbers still exist: years, counts of items, percentages the
narrative derived itself. They are passed explicitly via ``allowed``. That
inversion is the point. Nothing is waved through by default, because a
default-exception rule is where every real exception ends up.

## Numbers a chart legitimately transforms are allowed explicitly

A total, an average, a percentage and a year are not in the data and are not
fabrications. Callers that produce them list them. A checker that tried to
recompute them would be guessing at intent, and a checker that guessed wrong would
reject a correct report — which trains people to ignore it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable, List, Optional, Sequence, Set

# Numbers as they appear in prose: 1200, 1,200, 3.5, -2, 12%. A bare "1st" and a
# version string are deliberately not matched -- ordinals are not measurements.
# A trailing `.` followed by a digit means the number is part of a dotted
# identifier -- `1.2.3` is a version, not the measurement 1.2. Without this the
# checker reports a version number as a prose claim, and a report with several
# version strings drowns in findings that mean nothing.
_ETA = r"(?!\.\d)"
_CLAIM = re.compile(
    r"(?<![\w.])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?" + _ETA + r"(?![\w])"   # 1,200
    r"|(?<![\w.])-?\d+\.\d+" + _ETA + r"(?![\w])"                        # 3.5
    r"|(?<![\w.])-?\d{2,}" + _ETA + r"(?![\w])"                            # 1200
)


def _parse(raw: str) -> float:
    return float(raw.replace(",", ""))


def numeric_claims(text: str) -> List[tuple]:
    """``[(value, surrounding_text)]`` for every number stated in the prose."""
    claims = []
    for match in _CLAIM.finditer(text or ""):
        try:
            value = _parse(match.group(0))
        except ValueError:
            continue
        start = max(0, match.start() - 30)
        claims.append((value, (text[start:match.end() + 30] or "").strip()))
    return claims


@dataclass
class Claim:
    value: float
    context: str
    reason: str


@dataclass
class ConsistencyReport:
    checked: int = 0
    explained: List[Claim] = field(default_factory=list)
    allowed: List[float] = field(default_factory=list)

    @property
    def consistent(self) -> bool:
        return not self.explained

    def as_dict(self) -> dict:
        return {
            "checked": self.checked,
            "consistent": self.consistent,
            "unexplained": [
                {"value": c.value, "context": c.context, "reason": c.reason}
                for c in self.explained
            ],
        }

    def raise_if_inconsistent(self) -> "ConsistencyReport":
        if self.consistent:
            return self
        first = self.explained[0]
        raise ValueError(
            f"{len(self.explained)} number(s) in the text are not traceable to the "
            f"data: {first.value!r} in {first.context!r} ({first.reason}). "
            "Pass it via `allowed` if the narrative derived it deliberately."
        )
        return self


def verify_claims(
    text: str,
    data_values: Iterable[float],
    *,
    allowed: Optional[Sequence[float]] = None,
    tolerance: float = 0.0,
) -> ConsistencyReport:
    """Hold the numbers in *text* against the numbers that were actually computed.

    A claim is explained when it matches a data value, or is explicitly allowed.
    Everything else is unexplained -- which is a finding, and the caller's choice
    whether to raise, list or allow it.

    ``tolerance`` exists for values that survive floating-point arithmetic, not to
    make approximate claims pass. It defaults to exact equality, and a report
    generated from computed data should be able to state its numbers exactly.
    """
    values = [float(v) for v in data_values]
    allowed_values: Set[float] = {float(v) for v in (allowed or [])}
    report = ConsistencyReport()

    for value, context in numeric_claims(text):
        report.checked += 1
        if any(abs(value - v) <= tolerance for v in values):
            continue
        if any(abs(value - a) <= tolerance for a in allowed_values):
            report.allowed.append(value)
            continue
        report.explained.append(Claim(
            value=value,
            context=context,
            reason="no computed value or declared allowance matches it",
        ))
    return report
