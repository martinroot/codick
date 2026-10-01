"""#62 — charts built from verified computation.

The property under test is not "does it draw". It is that a plotted number can
always be traced back to a named cell of the input data, and that the three ways
a chart can lie — an unstated truncated axis, a clipped outlier, a value nobody
can account for — are refused rather than rendered.
"""

import pytest

from tools import documents_chart as charts
from tools import documents_export_pdf_tool as pdf


def point(label, value, source=None):
    return charts.Point(label=label, value=value, source=source or f"table[{label}].value")


# --- traceability -------------------------------------------------------------


def test_every_plotted_value_carries_its_source_cell():
    chart = charts.bar_chart(
        [point("Mon", 10, "revenue.csv!B2"), point("Tue", 20, "revenue.csv!C2")],
        x=50, y=100, width=300, height=120,
    )
    assert chart.plotted == [("Mon", 10.0, "revenue.csv!B2"), ("Tue", 20.0, "revenue.csv!C2")]


def test_a_value_with_no_source_is_refused():
    """A bare float has no provenance, and a chart of unaccountable numbers is
    indistinguishable from a chart of invented ones."""
    with pytest.raises(charts.ChartDataError) as excinfo:
        charts.Point(label="Mon", value=10, source="")
    assert "no source cell" in str(excinfo.value)


def test_a_non_numeric_value_is_refused():
    with pytest.raises(charts.ChartDataError):
        charts.Point(label="Mon", value="twelve", source="t!B2")


def test_a_chart_needs_data():
    for draw in (charts.bar_chart, charts.line_chart):
        with pytest.raises(charts.ChartDataError):
            draw([], x=0, y=0, width=10, height=10)


# --- the axis must not lie ----------------------------------------------------


def test_bars_start_at_zero_because_bar_length_encodes_magnitude():
    chart = charts.bar_chart([point("a", 97)], x=0, y=0, width=100, height=100)
    assert chart.domain[0] == 0.0
    assert chart.axis_note == "axis starts at 0"


def test_a_truncated_line_axis_is_stated_in_the_text_on_the_chart():
    """A zoomed axis is legitimate for a line, but a reader who assumes a zero
    baseline over-reads every slope, so it has to be written down."""
    chart = charts.line_chart(
        [point("a", 90), point("b", 92)], x=0, y=0, width=100, height=100,
        domain=(88, 94),
    )
    assert chart.axis_note != "axis starts at 0"
    assert any("axis starts at 88" in t for t in charts.tiny_texts(chart))


def test_a_line_with_a_zero_baseline_does_not_claim_otherwise():
    chart = charts.line_chart([point("a", 0), point("b", 10)], x=0, y=0,
                              width=100, height=100, domain=(0, 10))
    assert chart.axis_note == "axis starts at 0"


def test_the_axis_is_a_readable_round_number_not_the_raw_maximum():
    chart = charts.bar_chart([point("a", 87)], x=0, y=0, width=100, height=100)
    assert chart.domain[1] == 100.0


# --- out of range is an error ------------------------------------------------


def test_an_out_of_domain_value_is_refused_not_clipped():
    with pytest.raises(charts.ChartDataError) as excinfo:
        charts.line_chart([point("a", 1), point("b", 500)], x=0, y=0,
                          width=100, height=100, domain=(0, 10))
    assert "outside the plotted domain" in str(excinfo.value)


def test_the_bar_domain_always_covers_the_tallest_bar():
    """Bars are never clipped, because the domain rounds up from the data. The
    axis has to stay a readable number, so the ceiling moves rather than the bar.
    """
    for values in ([1, 1000], [87], [3, 3, 3], [999_999, 1], [0, 5]):
        chart = charts.bar_chart([point(str(i), v) for i, v in enumerate(values)],
                                 x=0, y=0, width=100, height=100)
        top = chart.domain[1]
        assert top >= max(values)
        rects = [s for s in chart.shapes if s.get("kind") == "rect"]
        assert len(rects) == len(values)
        for rect in rects:
            assert rect["h"] <= 100.0 + 1e-6
        if top == max(values):
            assert max(r["h"] for r in rects) == pytest.approx(100.0)


def test_negative_values_are_refused_for_bars():
    """Bars all pointing the same way on negative data would misstate the sign
    more quietly than any other chart error."""
    with pytest.raises(charts.ChartDataError) as excinfo:
        charts.bar_chart([point("a", -5)], x=0, y=0, width=100, height=100)
    assert "negative" in str(excinfo.value)


def test_an_empty_domain_is_refused():
    with pytest.raises(charts.ChartDataError):
        charts.line_chart([point("a", 5)], x=0, y=0, width=100, height=100, domain=(5, 5))


# --- legibility ---------------------------------------------------------------


def test_every_label_is_above_the_legibility_floor():
    chart = charts.bar_chart([point("Mon", 10), point("Tue", 20)],
                             x=0, y=0, width=200, height=100, unit="EUR")
    assert charts.illegible_labels(chart) == []


def test_a_tiny_label_is_reported_rather_than_rendered_quietly():
    chart = charts.bar_chart([point("Mon", 10)], x=0, y=0, width=100, height=100)
    chart.shapes.append({"kind": "text", "x": 0, "y": 0, "size": 4.0, "text": "tiny"})
    bad = charts.illegible_labels(chart)
    assert len(bad) == 1 and "tiny" in bad[0]


# --- geometry -----------------------------------------------------------------


def test_bar_heights_are_proportional_to_the_values():
    chart = charts.bar_chart([point("a", 50), point("b", 100)],
                             x=0, y=0, width=200, height=100)
    rects = [s for s in chart.shapes if s.get("kind") == "rect"]
    heights = [r["h"] for r in rects]
    assert heights[1] == pytest.approx(heights[0] * 2)


def test_bars_stay_inside_their_box():
    chart = charts.bar_chart([point("a", 10), point("b", 20)],
                             x=50, y=100, width=200, height=100)
    for rect in (s for s in chart.shapes if s.get("kind") == "rect"):
        assert rect["x"] >= 50
        assert rect["x"] + rect["w"] <= 50 + 200 + 1e-6
        assert rect["y"] + rect["h"] <= 100 + 100 + 1e-6


def test_a_degenerate_box_is_refused():
    for draw in (charts.bar_chart, charts.line_chart):
        with pytest.raises(charts.ChartDataError):
            draw([point("a", 1)], x=0, y=0, width=0, height=10)


# --- into a real PDF ----------------------------------------------------------


def test_a_chart_lands_in_a_pdf_and_its_labels_come_back(tmp_path):
    """End to end: geometry becomes operators, operators become a file, and the
    labels are read back out of the bytes."""
    chart = charts.bar_chart(
        [point("Mon", 1200, "sales.csv!B2"), point("Tue", 1850, "sales.csv!C2")],
        x=60, y=500, width=300, height=150, unit="EUR", series_label="Revenue",
    )
    out = tmp_path / "chart.pdf"
    pdf.export_pdf("Revenue by day", str(out))
    pdf.write_pdf(
        [{"text": "Revenue by day", "shapes": chart.shapes}],
        str(out),
        title="Revenue",
    )
    data = out.read_bytes()
    assert data.startswith(b"%PDF-")

    import re
    import zlib
    text = []
    for match in re.finditer(
        rb"<< /Length \d+ /Filter /FlateDecode >>\nstream\n(.*?)\nendstream", data, re.S
    ):
        stream = zlib.decompress(match.group(1))
        text.extend(m.group(1).decode("cp1252")
                    for m in re.finditer(rb"\((.*?)\) Tj", stream))
        # The bars themselves are vector operators, not text.
        assert b" re f" in stream or b" l S" in stream
    joined = "\n".join(text)
    assert "Revenue by day" in joined
    assert "Mon" in joined and "Tue" in joined
    assert "1200 EUR" in joined