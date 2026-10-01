"""#67 — the illustrated scenario has to be reachable through the tool.

Until this, ``documents.export_pdf`` took ``body``, ``path`` and ``title``. The
chart work existed and was unreachable: a model asked to illustrate a report
could emit prose and nothing else, which is exactly the document that looks
finished and is not.

The contract these tests hold is that the three refusals survive the trip through
the tool boundary, not merely inside the helpers.
"""

import json
import re
import zlib

import pytest

from tools import documents_export_pdf_tool as pdf


def streams(data: bytes):
    """The decompressed content streams. They are Flate-compressed, so drawing
    operators are not visible in the raw bytes at all."""
    for match in re.finditer(
        rb"<< /Length \d+ /Filter /FlateDecode >>\nstream\n(.*?)\nendstream", data, re.S
    ):
        yield zlib.decompress(match.group(1))


def read_text(data: bytes):
    out = []
    for stream in streams(data):
        out.extend(m.group(1).decode("cp1252") for m in re.finditer(rb"\((.*?)\) Tj", stream))
    return "\n".join(out)


def spec(points, kind="bar", **extra):
    return {"type": kind, "series_label": "Revenue", "unit": "EUR", "points": points, **extra}


def point(label, value, source="revenue.csv!B2"):
    return {"label": label, "value": value, "source": source}


# --- the path that was missing ------------------------------------------------


def test_a_chart_survives_the_tool_call(tmp_path):
    out = tmp_path / "report.pdf"
    payload = json.loads(pdf.export_pdf(
        "Revenue grew across the period.",
        str(out),
        title="Revenue",
        charts=[spec([point("Mon", 1200), point("Tue", 1850, "revenue.csv!C2")])],
    ))
    assert payload["success"] is True
    assert payload["charts"] == 1
    data = out.read_bytes()
    assert data.startswith(b"%PDF-")
    assert any(b" re f" in s for s in streams(data)), "the bars should be drawn"


def test_the_labels_and_the_units_survive(tmp_path):
    out = tmp_path / "report.pdf"
    pdf.export_pdf("Revenue report.", str(out), title="Revenue",
                   charts=[spec([point("Mon", 1200), point("Tue", 1850, "revenue.csv!C2")])])
    text = read_text(out.read_bytes())
    assert "Mon" in text and "Tue" in text
    assert "1200 EUR" in text and "1850 EUR" in text


def test_a_line_chart_with_an_explicit_domain_is_accepted(tmp_path):
    out = tmp_path / "report.pdf"
    payload = json.loads(pdf.export_pdf(
        "Trend.", str(out), charts=[spec([point("a", 90), point("b", 92, "t!C2")],
                                        kind="line", domain=[88, 94])],
    ))
    assert payload["success"] is True


# --- refusal 1: a value nobody can trace --------------------------------------


def test_a_value_with_no_source_is_refused_at_the_tool_boundary():
    """The schema says `source` is required. A model cannot put a number on a
    chart without naming the cell it came from, because there is nowhere to put
    one."""
    with pytest.raises(Exception) as excinfo:
        pdf.export_pdf("Body.", "/tmp/never.pdf",
                       charts=[spec([{"label": "Mon", "value": 1200, "source": ""}])])
    assert "source" in str(excinfo.value).lower()


def test_the_schema_makes_source_required():
    point_schema = pdf.EXPORT_PDF_SCHEMA["parameters"]["properties"]["charts"]["items"][
        "properties"]["points"]["items"]
    assert "source" in point_schema["required"]
    assert "value" in point_schema["required"]


# --- refusal 2: the prose must not contradict the chart -----------------------


def test_prose_that_contradicts_the_chart_is_refused(tmp_path):
    out = tmp_path / "report.pdf"
    with pytest.raises(Exception) as excinfo:
        pdf.export_pdf("Monday was 1200 and Tuesday was 1900.", str(out),
                       charts=[spec([point("Mon", 1200),
                                     point("Tue", 1850, "revenue.csv!C2")])])
    assert "1900" in str(excinfo.value)


def test_a_derived_number_can_be_declared(tmp_path):
    out = tmp_path / "report.pdf"
    payload = json.loads(pdf.export_pdf(
        "Monday 1200 and Tuesday 1850, together 3050.", str(out),
        charts=[spec([point("Mon", 1200), point("Tue", 1850, "revenue.csv!C2")])],
        allowed_numbers=[3050.0],
    ))
    assert payload["success"] is True


def test_agreeing_prose_passes(tmp_path):
    out = tmp_path / "report.pdf"
    payload = json.loads(pdf.export_pdf(
        "Monday was 1200 and Tuesday was 1850.", str(out),
        charts=[spec([point("Mon", 1200), point("Tue", 1850, "revenue.csv!C2")])],
    ))
    assert payload["success"] is True


# --- refusal 3: the page has to fit -------------------------------------------


def test_a_chart_outside_the_page_is_refused_rather_than_clipped():
    """Two full-height charts cannot both fit a page. The failure a reader would
    see is a silently clipped chart; the failure we report is a name."""
    # Each chart is 200pt plus a 16pt gap in a 730pt column, so two of them fit
    # comfortably; the guard is about what does not.
    chart_height = 216.0
    count = int(pdf.content_box().h // chart_height) + 1
    tall = [{"label": f"d{i}", "value": i + 1, "source": f"t!{i}"} for i in range(6)]
    assert count > 2, "the fixture must actually overflow"
    with pytest.raises(Exception) as excinfo:
        pdf.export_pdf("Body.", "/tmp/never.pdf", charts=[spec(tall) for _ in range(count)])
    assert "fit" in str(excinfo.value).lower()


# --- plain text still works ---------------------------------------------------


def test_text_only_export_is_unchanged(tmp_path):
    out = tmp_path / "plain.pdf"
    payload = json.loads(pdf.export_pdf("Just words.", str(out)))
    assert payload["success"] is True
    assert payload["charts"] == 0
    assert "Just words." in read_text(out.read_bytes())


def test_an_unknown_chart_type_is_refused():
    with pytest.raises(Exception) as excinfo:
        pdf.export_pdf("Body.", "/tmp/never.pdf",
                       charts=[{"type": "pie", "points": [point("a", 1)]}])
    assert "pie" in str(excinfo.value)


def test_a_value_outside_an_explicit_domain_is_refused():
    with pytest.raises(Exception) as excinfo:
        pdf.export_pdf("Body.", "/tmp/never.pdf", charts=[
            {"type": "line", "domain": [0, 10],
             "points": [point("a", 1), point("b", 500, "t!C2")]}])
    assert "outside" in str(excinfo.value).lower()
