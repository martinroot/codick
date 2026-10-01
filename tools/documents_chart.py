"""Charts drawn from verified computation, with no plotting library installed.

There is no matplotlib here, and adding one would make the illustrated scenario
fail on a clean machine — which is the opposite of what it is for. So the
geometry is computed and emitted directly as PDF vector operators.

Three rules, and each one exists because its absence is a specific, quiet lie:

**Every value is traceable.** A chart is built from `(value, source_label)`
pairs. The caller cannot hand in a bare float that no one can trace back to a
cell of the input table. A chart that disagrees with the table it illustrates is
worse than no chart, and that disagreement is invisible to a reader.

**A non-zero baseline is announced.** A bar chart whose axis starts at 90 makes a
2% difference look enormous. When the axis does not start at zero the axis label
says so, rather than leaving the reader to assume the bars are lengths.

**Out of range is an error, not a clipped line.** A value outside the plotted
domain raises. Silently clipping it produces a chart that looks fine and lies
about the one point the reader most wanted to see.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Sequence, Tuple


class ChartDataError(ValueError):
    """The data cannot be drawn honestly. Raised rather than drawn wrong."""


@dataclass(frozen=True)
class Point:
    """One plotted value and where it came from."""

    label: str
    value: float
    source: str

    def __post_init__(self) -> None:
        if not self.source:
            raise ChartDataError(
                f"point {self.label!r} has no source cell; an untraceable value "
                "cannot be plotted"
            )
        if not isinstance(self.value, (int, float)):
            raise ChartDataError(f"point {self.label!r} value is not a number: {self.value!r}")


@dataclass(frozen=True)
class Chart:
    """A chart as PDF-space shapes, plus the label a reader needs to trust it."""

    shapes: List[dict]
    axis_note: str
    domain: Tuple[float, float]
    plotted: List[Tuple[str, float, str]]


# A legible body size; anything smaller and the legibility check should fail the
# document rather than pass it.
LABEL_SIZE = 8.5
AXIS_SIZE = 7.5
MIN_LEGIBLE = 7.0


def _nice_ceiling(value: float) -> float:
    """Round a maximum up to a readable tick value.

    Rounding to a magnitude rather than to the raw maximum is what makes an axis
    read as 100 rather than as 87.
    """
    if value <= 0:
        return 1.0
    magnitude = 10 ** (len(str(int(abs(value)))) - 1)
    for step in (1, 2, 2.5, 5, 10):
        candidate = step * magnitude
        if candidate >= value:
            return float(candidate)
    return float(10 * magnitude)


def _format(value: float) -> str:
    if value == int(value):
        return str(int(value))
    return f"{value:g}"


def bar_chart(
    points: Sequence[Point],
    *,
    x: float,
    y: float,
    width: float,
    height: float,
    unit: str = "",
    series_label: str = "",
) -> Chart:
    """Vertical bars. The y domain is derived from the data, not supplied.

    Starting at zero is the default and the honest choice for bars: bar *length*
    encodes magnitude, and a truncated axis breaks that reading.
    """
    if not points:
        raise ChartDataError("a chart needs at least one point")
    if width <= 0 or height <= 0:
        raise ChartDataError("chart box must have positive extent")

    values = [float(p.value) for p in points]
    low, high = min(values), max(values)
    # Negatives would need a baseline through the middle; refuse rather than draw
    # a chart whose bars all point the same way on negative data.
    if low < 0:
        raise ChartDataError(
            f"bar_chart cannot draw negative values (min {low}); a truncated axis "
            "would misstate them"
        )
    top = _nice_ceiling(high) if high > 0 else 1.0

    shapes: List[dict] = []
    # Axis lines.
    shapes.append({"kind": "line", "x1": x, "y1": y, "x2": x + width, "y2": y, "width": 0.8})
    shapes.append({"kind": "line", "x1": x, "y1": y, "x2": x, "y2": y + height, "width": 0.8})

    slot = width / len(points)
    bar_w = slot * 0.62
    plotted: List[Tuple[str, float, str]] = []
    for index, point in enumerate(points):
        value = float(point.value)
        # `_nice_ceiling` rounds the maximum *up*, so the domain always covers
        # every bar and nothing here is ever clipped. An earlier version also
        # range-checked each value against the domain, which could not fire for
        # non-negative input -- dead code that read as a guarantee.
        bar_h = (value / top) * height if top else 0.0
        bx = x + slot * index + (slot - bar_w) / 2
        shapes.append({
            "kind": "rect", "x": bx, "y": y, "w": bar_w, "h": bar_h,
            "fill": 0.30, "fill_g": 0.47, "fill_b": 0.72,
        })
        shapes.append({
            "kind": "text", "x": bx - 4, "y": y - 10, "size": LABEL_SIZE,
            "text": point.label,
        })
        shapes.append({
            "kind": "text", "x": bx - 2, "y": y + bar_h + 3, "size": AXIS_SIZE,
            "text": _format(value) + (f" {unit}" if unit else ""),
        })
        plotted.append((point.label, value, point.source))

    shapes.append({
        "kind": "text", "x": x, "y": y + height + 10, "size": AXIS_SIZE,
        "text": (series_label or "") + (f" [{unit}]" if unit else ""),
    })
    return Chart(shapes=shapes, axis_note="axis starts at 0", domain=(0.0, top),
                 plotted=plotted)


def line_chart(
    points: Sequence[Point],
    *,
    x: float,
    y: float,
    width: float,
    height: float,
    unit: str = "",
    series_label: str = "",
    domain: Tuple[float, float] | None = None,
) -> Chart:
    """A connected line, which may legitimately use a non-zero baseline.

    Unlike bars, a line encodes change rather than length, so a zoomed domain is
    legitimate — but it has to be **stated**, because a reader who assumes a
    zero baseline will over-read every slope on the chart.
    """
    if not points:
        raise ChartDataError("a chart needs at least one point")
    if width <= 0 or height <= 0:
        raise ChartDataError("chart box must have positive extent")

    values = [float(p.value) for p in points]
    if domain is None:
        low, high = min(values), max(values)
        span = high - low
        if span == 0:
            low, high = low - 1.0, high + 1.0
        else:
            pad = span * 0.1
            low, high = low - pad, high + pad
    else:
        low, high = float(domain[0]), float(domain[1])
    if high <= low:
        raise ChartDataError(f"empty domain {low}..{high}")

    for point in points:
        if not (low <= float(point.value) <= high):
            raise ChartDataError(
                f"{point.label} = {point.value} is outside the plotted domain "
                f"{_format(low)}..{_format(high)}; it would be clipped"
            )

    def to_px(value: float) -> float:
        return y + (value - low) / (high - low) * height

    shapes: List[dict] = [
        {"kind": "line", "x1": x, "y1": y, "x2": x + width, "y2": y, "width": 0.8},
        {"kind": "line", "x1": x, "y1": y, "x2": x, "y2": y + height, "width": 0.8},
    ]
    step = width / max(1, len(points) - 1) if len(points) > 1 else width / 2
    coords = [(x + step * i, to_px(float(p.value))) for i, p in enumerate(points)]
    shapes.append({"kind": "polyline", "points": coords, "width": 1.4,
                   "stroke": 0.13, "stroke_g": 0.36, "stroke_b": 0.61})

    plotted: List[Tuple[str, float, str]] = []
    for index, point in enumerate(points):
        px, py = coords[index]
        shapes.append({"kind": "text", "x": px - 6, "y": py + 4, "size": AXIS_SIZE,
                       "text": _format(float(point.value))})
        shapes.append({"kind": "text", "x": px - 6, "y": y - 10, "size": LABEL_SIZE,
                       "text": point.label})
        plotted.append((point.label, float(point.value), point.source))

    note = f"axis starts at {_format(low)}" if low != 0 else "axis starts at 0"
    shapes.append({
        "kind": "text", "x": x, "y": y + height + 10, "size": AXIS_SIZE,
        "text": f"{series_label} [{unit}] · {note}".strip(" ·"),
    })
    return Chart(shapes=shapes, axis_note=note, domain=(low, high), plotted=plotted)


def tiny_texts(chart: Chart) -> List[str]:
    """Every label the chart draws — used by the legibility check."""
    return [s["text"] for s in chart.shapes if s.get("kind") == "text"]


def illegible_labels(chart: Chart, *, minimum: float = MIN_LEGIBLE) -> List[str]:
    """Labels below the legibility floor, with the size that failed."""
    return [
        f"{s['text']!r} at {s.get('size', 0)}pt"
        for s in chart.shapes
        if s.get("kind") == "text" and float(s.get("size", 0)) < minimum
    ]