"""#65 — a page that parses can still be wrong.

The writer never looks at the coordinates it is handed. A chart at ``x=0``
renders in the bleed, the page edge clips it, and every structural check still
passes: valid PDF, parseable xref, correct text. The failure is only visible to
a reader at print size. These tests are the ones that look.
"""

import pytest

from tools import documents_chart as charts
from tools import documents_export_pdf_tool as pdf
from tools import documents_layout as layout


# The writer's own content box: A4 minus its 56pt margins.
CONTENT = layout.Box(
    x=pdf.MARGIN,
    y=pdf.MARGIN,
    w=pdf.PAGE_WIDTH - 2 * pdf.MARGIN,
    h=pdf.PAGE_HEIGHT - 2 * pdf.MARGIN,
)


def el(name, x, y, w, h, font=None):
    return layout.Element(name=name, x=x, y=y, w=w, h=h, font=font)


# --- the box ------------------------------------------------------------------


def test_an_element_inside_the_box_is_fine():
    report = layout.check_layout([el("body", 60, 100, 400, 200)], CONTENT)
    assert report.ok


def test_a_chart_placed_in_the_bleed_is_caught():
    """x=0 renders in the trim area and gets clipped. Nothing else would notice."""
    report = layout.check_layout([el("chart", 0, 100, 400, 200)], CONTENT)
    assert not report.ok
    assert any("left" in message for message in report.overflow)


def test_each_edge_is_named_with_how_far_it_escaped():
    """'Does not fit' leaves an author nothing to act on."""
    report = layout.check_layout([el("chart", 0, 0, 900, 900)], CONTENT)
    text = " ".join(report.overflow)
    for edge in ("left", "below", "right", "above"):
        assert edge in text
    assert "pt" in text


def test_touching_the_edge_is_not_overflow():
    report = layout.check_layout(
        [el("full-bleed", CONTENT.x, CONTENT.y, CONTENT.w, CONTENT.h)], CONTENT
    )
    assert report.ok


# --- overlap ------------------------------------------------------------------


def test_a_chart_drawn_over_its_own_caption_is_caught():
    report = layout.check_layout(
        [el("chart", 60, 400, 400, 200), el("caption", 60, 500, 200, 20)], CONTENT
    )
    assert not report.ok
    assert any("chart" in m and "caption" in m for m in report.overlaps)


def test_the_overlap_reports_its_size():
    report = layout.check_layout(
        [el("a", 60, 400, 100, 100), el("b", 100, 400, 100, 100)], CONTENT
    )
    assert "60.0x100.0pt" in report.overlaps[0]


def test_touching_edges_are_not_an_overlap():
    """A rule directly under a caption is a layout, not a collision. Reporting it
    would make the check unusable and people would turn it off."""
    report = layout.check_layout(
        [el("a", 60, 400, 100, 100), el("b", 60, 500, 100, 100)], CONTENT
    )
    assert report.overlaps == []


# --- legibility ---------------------------------------------------------------


def test_type_below_the_floor_is_reported():
    report = layout.check_layout([el("note", 60, 100, 100, 20, font=4.0)], CONTENT)
    assert not report.ok
    assert "4.0pt" in report.tiny_type[0]


def test_the_floor_comes_from_the_writers_own_body_size():
    """The floor is not a number invented in the layout module -- it is the
    writer's own body size, so the two cannot drift apart."""
    ok = layout.check_layout(
        [el("note", 60, 100, 100, 20, font=pdf.BODY_SIZE)], CONTENT,
        min_font=pdf.BODY_SIZE,
    )
    assert ok.tiny_type == []
    under = layout.check_layout(
        [el("note", 60, 100, 100, 20, font=pdf.BODY_SIZE - 2)], CONTENT,
        min_font=pdf.BODY_SIZE,
    )
    assert under.tiny_type, "at the writer's floor, one point under must be caught"


# --- the report ---------------------------------------------------------------


def test_raising_names_every_kind_of_problem():
    report = layout.check_layout(
        [el("chart", 0, 0, 900, 900), el("a", 60, 400, 100, 100, font=3.0)], CONTENT,
    )
    with pytest.raises(ValueError) as excinfo:
        report.raise_if_invalid()
    assert "outside the content box" in str(excinfo.value)


def test_raising_a_valid_report_returns_it():
    report = layout.check_layout([el("body", 60, 100, 100, 100)], CONTENT)
    assert report.raise_if_invalid() is report


def test_the_report_is_serialisable():
    payload = layout.check_layout([el("chart", 0, 0, 900, 900)], CONTENT).as_dict()
    assert payload["ok"] is False
    assert payload["overflow"] and not payload["overlaps"]


# --- from real chart shapes ----------------------------------------------------


def test_a_chart_placed_in_the_bleed_is_caught_from_its_own_shapes():
    """The gap this closes: charts are emitted as bare coordinates, and nothing
    validated them on the way to the page."""
    chart = charts.bar_chart([charts.Point("Mon", 10, "t!B2")],
                             x=10, y=500, width=300, height=150)
    elements = layout.elements_from_shapes(chart.shapes, "chart")
    assert elements
    report = layout.check_layout(elements, CONTENT)
    assert not report.ok


def test_a_chart_placed_well_inside_the_box_passes():
    chart = charts.bar_chart(
        [charts.Point("Mon", 10, "t!B2"), charts.Point("Tue", 20, "t!C2")],
        x=CONTENT.x, y=CONTENT.y + 40, width=CONTENT.w, height=300,
    )
    elements = layout.elements_from_shapes(chart.shapes, "chart")
    report = layout.check_layout(elements, CONTENT)
    assert report.overflow == [], report.overflow


def test_chart_text_is_measured_not_skipped():
    """A caption hanging off the edge is the failure being hunted; a zero-width
    bbox would let it through untouched."""
    chart = charts.bar_chart([charts.Point("Mon", 10, "t!B2")],
                             x=CONTENT.x, y=CONTENT.y + 40, width=200, height=150)
    text_shapes = [s for s in chart.shapes if s.get("kind") == "text"]
    assert text_shapes
    # Every text shape below the box's left edge must be reported when measured.
    low = [s for s in text_shapes if float(s["x"]) < CONTENT.x - 1]
    for shape in low:
        element = layout.Element(name=shape["text"], x=float(shape["x"]),
                                 y=float(shape["y"]) - 8, w=40, h=10)
        assert "left" in " ".join(
            layout.check_layout([element], CONTENT).overflow
        )


# --- stacking -----------------------------------------------------------------


def test_stacking_fits_what_it_can_and_reports_the_rest():
    """A caller still has to render what fitted and say what did not, so the
    report comes back alongside the elements rather than as an exception."""
    assert CONTENT.h < 900, "the fixture must not fit three 300pt items"
    items = [("a", 400, 300, 11.0), ("b", 400, 300, 11.0), ("c", 400, 300, 11.0)]
    elements, report = layout.stack(items, CONTENT)
    assert len(elements) == 3
    assert not report.ok
    assert any("c" in message for message in report.overflow)


def test_stacking_fits_a_short_document():
    elements, report = layout.stack([("a", 400, 100, 11.0), ("b", 400, 100, 11.0)],
                                    CONTENT)
    assert report.ok
    assert elements[0].y > elements[1].y, "items stack top-down"


def test_stacking_nothing_is_valid():
    elements, report = layout.stack([], CONTENT)
    assert elements == [] and report.ok
