"""#61 — a real PDF writer, proven by parsing its own output back.

The verification here is deliberately **not** "call the writer, then call a
reader that happens to exist". There is no PDF reader in this environment:
`read_extract` gates the format behind an optional `anydoc` converter that is
not installed, and no `pypdf`/`pdfminer` is present. So a test that leaned on
the repo reader would have been asserting nothing — the same mistake as trusting
the writer.

Instead these tests parse the produced bytes independently: header, catalogue,
page tree, xref offsets, trailer, and the decompressed content streams. If the
xref pointed at the wrong byte, the structure test fails. That is the property
that matters, and it is checkable without a library.
"""

import re
import zlib

import pytest

from tools import documents_export_pdf_tool as pdf


def parse(data: bytes):
    """A small independent parser: enough to prove the file is a real PDF.

    Written from the format description, not by calling into the writer, so a
    bug in the writer cannot hide behind a shared assumption.
    """
    assert data.startswith(b"%PDF-1."), "missing PDF header"
    assert data.rstrip().endswith(b"%%EOF"), "missing EOF marker"

    start = data.rfind(b"startxref")
    assert start != -1, "no startxref"
    xref_at = int(data[start + len(b"startxref"):].split()[0])
    assert data[xref_at:xref_at + 4] == b"xref", (
        f"startxref points at {data[xref_at:xref_at+12]!r}, not an xref table"
    )

    # Every in-use xref entry must point at EXACTLY the object it claims.
    # An earlier version allowed a loose " 0 obj appears nearby" match, which
    # passed a writer whose offsets were off by one byte - the very corruption
    # this is here to catch. Offsets are compared byte-for-byte.
    entries = re.findall(rb"(\d{10}) (\d{5}) ([nf])", data[xref_at:])
    objects = {}
    for position_in_table, (offset, _gen, kind) in enumerate(entries):
        if kind == b"f":
            continue
        obj_number = position_in_table  # entry 0 is the free head of the chain
        start = int(offset)
        expected = b"%d 0 obj" % obj_number
        actual = data[start:start + len(expected)]
        assert actual == expected, (
            f"xref entry {obj_number} points at byte {start}, where {actual!r} "
            f"sits instead of {expected!r}"
        )

    for match in re.finditer(rb"(\d+) 0 obj\n(.*?)\nendobj", data, re.S):
        objects[int(match.group(1))] = match.group(2)
    return objects


def extract_text(data: bytes) -> str:
    """Pull the shown strings out of the decompressed content streams."""
    out = []
    for match in re.finditer(
        rb"<< /Length \d+ /Filter /FlateDecode >>\nstream\n(.*?)\nendstream", data, re.S
    ):
        stream = zlib.decompress(match.group(1))
        for m in re.finditer(rb"\((.*?)\) Tj", stream):
            raw = m.group(1).decode("cp1252")
            # The writer escapes parentheses and backslashes; a reader that does
            # not unescape them is a broken reader, not a broken document.
            out.append(re.sub(r"\\([()\\])", r"\1", raw))
    return "\n".join(out)


# --- structure ----------------------------------------------------------------


def test_the_output_is_a_real_pdf(tmp_path):
    out = tmp_path / "doc.pdf"
    pdf.export_pdf("Hello world.", str(out), title="Test")
    data = out.read_bytes()
    assert data.startswith(b"%PDF-1.")
    assert b"/Type /Catalog" in data
    assert b"/Type /Pages" in data
    assert b"/Type /Page " in data
    parse(data)  # raises if the xref or the structure is wrong


def test_a_pdf_is_not_a_renamed_text_file(tmp_path):
    """The failure this whole feature guards against."""
    out = tmp_path / "doc.pdf"
    pdf.export_pdf("Hello world.", str(out))
    data = out.read_bytes()
    assert not data.lstrip().startswith(b"Hello"), "the file is plain text"
    assert data[:5] == b"%PDF-"


def test_the_catalogue_points_at_the_page_tree(tmp_path):
    out = tmp_path / "doc.pdf"
    pdf.export_pdf("Hello.", str(out))
    objects = parse(out.read_bytes())
    catalog = next(b for b in objects.values() if b"/Type /Catalog" in b)
    pages_ref = int(re.search(rb"/Pages (\d+) 0 R", catalog).group(1))
    assert b"/Type /Pages" in objects[pages_ref]


def test_page_count_matches_the_content(tmp_path):
    # Sized from the module's own capacity rather than a guessed number: 40
    # short paragraphs genuinely fit one page, and an earlier version of this
    # test asserted otherwise and failed for the right reason on the wrong
    # assumption.
    per_page = int(
        (pdf.PAGE_HEIGHT - 2 * pdf.MARGIN) // (pdf.BODY_SIZE * pdf.BODY_LEADING / pdf.BODY_SIZE)
    )
    body = "\n\n".join(f"Paragraph {i} with a little more text." for i in range(per_page * 3))
    out = tmp_path / "long.pdf"
    pdf.export_pdf(body, str(out))
    data = out.read_bytes()
    objects = parse(data)
    pages_obj = next(b for b in objects.values() if b"/Type /Pages" in b)
    count = int(re.search(rb"/Count (\d+)", pages_obj).group(1))
    kids = re.search(rb"/Kids \[(.*?)\]", pages_obj).group(1)
    assert count > 1, "a long document must paginate"
    assert count == len(re.findall(rb"\d+ 0 R", kids)), "Count disagrees with Kids"
    assert data.count(b"/Type /Page ") == count


# --- the text survives the round trip ----------------------------------------


def test_text_round_trips_through_the_bytes(tmp_path):
    body = "Revenue grew by 12 percent. Costs fell."
    out = tmp_path / "doc.pdf"
    pdf.export_pdf(body, str(out), title="Quarterly")
    text = extract_text(out.read_bytes())
    assert "Quarterly" in text
    assert "Revenue grew by 12 percent." in text


def test_parentheses_in_the_text_do_not_corrupt_the_stream(tmp_path):
    """Unescaped parentheses would terminate the literal early and desync the
    parser — the classic hand-rolled PDF bug."""
    out = tmp_path / "paren.pdf"
    pdf.export_pdf("A (nested (paren)) and a backslash \\ here.", str(out))
    text = extract_text(out.read_bytes())
    assert "A (nested (paren)) and a backslash \\ here." in text


# --- the honest limit ----------------------------------------------------------


def test_text_outside_winansi_is_refused_not_mangled(tmp_path):
    """Silently substituting '?' would produce a document that opens, renders,
    and is quietly wrong. A refusal is the only safe answer here."""
    out = tmp_path / "cyrillic.pdf"
    with pytest.raises(pdf.PdfTextError) as excinfo:
        pdf.export_pdf("Отчёт по доске", str(out))
    assert "embedded font" in str(excinfo.value)
    assert not out.exists() or out.stat().st_size == 0


def test_latin_text_with_accents_is_fine(tmp_path):
    out = tmp_path / "accents.pdf"
    pdf.export_pdf("Café — naïve façade, 50 %", str(out))
    assert "Café — naïve façade, 50 %" in extract_text(out.read_bytes())


# --- pagination and the tool surface ------------------------------------------


def test_pagination_never_overshoots_the_printable_box():
    blocks = [{"text": "line " * 12} for _ in range(30)]
    for page in pdf.paginate(blocks):
        total = sum(
            item.get("size", pdf.BODY_SIZE) * (pdf.BODY_LEADING / pdf.BODY_SIZE)
            + item.get("gap_before", 0.0)
            for item in page
        )
        assert total <= pdf.PAGE_HEIGHT - 2 * pdf.MARGIN + 1e-6


def test_the_handler_returns_a_json_string(tmp_path):
    out = tmp_path / "handler.pdf"
    import json

    payload = json.loads(pdf.export_pdf("Body text.", str(out)))
    assert payload["success"] is True
    assert payload["path"].endswith(".pdf")


def test_no_partial_file_is_left_behind(tmp_path):
    out = tmp_path / "deep" / "nested" / "doc.pdf"
    pdf.export_pdf("x", str(out))
    assert out.exists()
    assert not (tmp_path / "deep" / "nested" / "doc.pdf.part").exists()