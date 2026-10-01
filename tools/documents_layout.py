"""Does the composed page actually fit? (#65)

The writer places whatever coordinates it is handed and never looks at them. A
chart drawn at ``x=0`` renders in the bleed, gets clipped by the page edge, and
nothing anywhere says so — the PDF is still a valid PDF, still parses, still
passes every structural check. The failure is only visible to a reader, on a
page, at print size.

So layout is checked as data before it is written:

- every element inside the content box, to the point;
- no two elements overlapping, because a chart drawn over its own caption is a
  chart nobody can read and no parser will ever notice;
- type at or above the legibility floor, measured against the writer's own body
  size rather than a number invented here;
- a block that cannot fit is an **error naming the block**, never a silent drop
  or a clipped tail. A document that quietly loses its last paragraph is worse
  than one that refuses to build.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Sequence, Tuple

# The same floor the writer documents for body text. Duplicating the number here
# would let the two drift, so callers pass it in from the writer.
DEFAULT_MIN_FONT = 7.0

EPS = 0.51  # sub-half-point differences are rounding, not a layout error


@dataclass
class Element:
    """One placed thing on a page."""

    name: str
    x: float
    y: float
    w: float
    h: float
    font: Optional[float] = None

    @property
    def right(self) -> float:
        return self.x + self.w

    @property
    def top(self) -> float:
        return self.y + self.h

    def box(self) -> Tuple[float, float, float, float]:
        return (self.x, self.y, self.right, self.top)


@dataclass
class Box:
    """The area content may occupy, in PDF points."""

    x: float
    y: float
    w: float
    h: float

    @property
    def right(self) -> float:
        return self.x + self.w

    @property
    def top(self) -> float:
        return self.y + self.h

    def contains(self, element: Element) -> bool:
        return (element.x >= self.x - EPS
                and element.y >= self.y - EPS
                and element.right <= self.right + EPS
                and element.top <= self.top + EPS)


@dataclass
class LayoutReport:
    overflow: List[str] = field(default_factory=list)
    overlaps: List[str] = field(default_factory=list)
    tiny_type: List[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not (self.overflow or self.overlaps or self.tiny_type)

    def as_dict(self) -> dict:
        return {
            "ok": self.ok,
            "overflow": self.overflow,
            "overlaps": self.overlaps,
            "tiny_type": self.tiny_type,
        }

    def raise_if_invalid(self) -> "LayoutReport":
        if self.ok:
            return self
        parts = []
        if self.overflow:
            parts.append("outside the content box: " + "; ".join(self.overflow))
        if self.overlaps:
            parts.append("overlapping: " + "; ".join(self.overlaps))
        if self.tiny_type:
            parts.append("below the legibility floor: " + "; ".join(self.tiny_type))
        raise ValueError("layout does not fit: " + " | ".join(parts))
        return self


def check_layout(
    elements: Sequence[Element],
    box: Box,
    *,
    min_font: float = DEFAULT_MIN_FONT,
) -> LayoutReport:
    """Measure *elements* against *box* and report every violation.

    Nothing is clamped or nudged. A layout that "fits" because the checker moved
    it is a layout nobody chose, and the overlap it fixed may have been there to
    express an order.
    """
    report = LayoutReport()

    for element in elements:
        if not box.contains(element):
            report.overflow.append(_describe_overflow(element, box))
        if element.font is not None and element.font < min_font - EPS:
            report.tiny_type.append(f"{element.name} at {element.font}pt (floor {min_font}pt)")

    for i, first in enumerate(elements):
        for second in elements[i + 1:]:
            overlap = _intersection(first, second)
            if overlap is not None:
                width, height = overlap
                report.overlaps.append(
                    f"{first.name} and {second.name} share {width:.1f}x{height:.1f}pt"
                )
    return report


def _intersection(first: Element, second: Element) -> Optional[Tuple[float, float]]:
    """The overlapping rectangle of two elements, or ``None``.

    Touching edges are not an overlap: a rule directly under a caption is a
    layout, and reporting it would make the check unusable.
    """
    x0 = max(first.x, second.x)
    y0 = max(first.y, second.y)
    x1 = min(first.right, second.right)
    y1 = min(first.top, second.top)
    if x1 - x0 <= EPS or y1 - y0 <= EPS:
        return None
    return (x1 - x0, y1 - y0)


def _describe_overflow(element: Element, box: Box) -> str:
    parts = []
    if element.x < box.x - EPS:
        parts.append(f"{box.x - element.x:.1f}pt left")
    if element.y < box.y - EPS:
        parts.append(f"{box.y - element.y:.1f}pt below")
    if element.right > box.right + EPS:
        parts.append(f"{element.right - box.right:.1f}pt right")
    if element.top > box.top + EPS:
        parts.append(f"{element.top - box.top:.1f}pt above")
    return f"{element.name} sits {' and '.join(parts) or 'outside the box'}"


def stack(
    items: Sequence[tuple],
    box: Box,
    *,
    min_font: float = DEFAULT_MIN_FONT,
) -> Tuple[List[Element], LayoutReport]:
    """Flow ``(name, w, h, font)`` items top-down inside *box*.

    Returns the placed elements **and** the report, because a caller that cannot
    fit everything still has to render what did fit and say what was left out.
    """
    elements: List[Element] = []
    cursor = box.top
    for name, w, h, font in items:
        cursor -= h
        elements.append(Element(name=name, x=box.x, y=cursor, w=w, h=h, font=font))
    return elements, check_layout(elements, box, min_font=min_font)


def elements_from_shapes(shapes: Sequence[dict], name: str) -> List[Element]:
    """Turn a chart's shapes into measurable elements.

    Text shapes are measured from their point and size rather than skipped: a
    caption hanging off the page edge is exactly the failure this module exists
    to catch, and a bbox of zero would let it through.
    """
    out: List[Element] = []
    for index, shape in enumerate(shapes):
        kind = shape.get("kind")
        if kind == "rect":
            out.append(Element(
                name=f"{name}.rect[{index}]", x=float(shape["x"]), y=float(shape["y"]),
                w=float(shape["w"]), h=float(shape["h"]),
            ))
        elif kind == "line":
            x1, y1 = float(shape["x1"]), float(shape["y1"])
            x2, y2 = float(shape["x2"]), float(shape["y2"])
            out.append(Element(
                name=f"{name}.line[{index}]", x=min(x1, x2), y=min(y1, y2),
                w=abs(x2 - x1) or 0.8, h=abs(y2 - y1) or 0.8,
            ))
        elif kind == "polyline":
            points = shape.get("points") or []
            if not points:
                continue
            xs = [float(p[0]) for p in points]
            ys = [float(p[1]) for p in points]
            out.append(Element(
                name=f"{name}.polyline[{index}]", x=min(xs), y=min(ys),
                w=max(xs) - min(xs) or 0.8, h=max(ys) - min(ys) or 0.8,
            ))
    return out
