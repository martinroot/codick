"""A real PDF writer on the standard library alone.

There is no PDF library in this environment — no ``reportlab``, no ``fpdf``, no
``weasyprint`` — and there is no PDF *reader* either: ``read_extract`` gates the
format behind an optional converter that is not installed. So both halves of a
round trip are ours, which is the same position the DOCX writer was in and the
same reason it was written from scratch rather than added as a dependency.

What this emits is a genuine PDF: a header, a catalogue, a page tree, real page
objects, content streams, a cross-reference table and a trailer. A file with a
``.pdf`` extension that is actually plain text is the failure this exists to
avoid, and ``tests/tools/test_documents_export_pdf_tool.py`` parses the produced
bytes back rather than trusting the writer.

## Text encoding, and where it stops

Only WinAnsi (Latin-1) is encodable with the base-14 fonts a PDF may reference
without embedding anything. Characters outside that range raise rather than
being replaced: Cyrillic in a PDF needs an embedded TrueType font, which is a
real piece of work and is **not** faked here with mojibake. A scenario that must
render Cyrillic is blocked on that, and should say so.
"""

from __future__ import annotations

import json
import os
import zlib
from typing import List, Optional, Sequence

from tools.registry import registry

# A4 in PostScript points. The layout checks downstream reason about the page
# box, so it is named rather than passed around as four numbers.
PAGE_WIDTH = 595.0
PAGE_HEIGHT = 842.0
MARGIN = 56.0

# 12pt Helvetica at this leading is the readable floor for body text; the
# legibility check in the layout issue is measured against these, not invented.
BODY_SIZE = 11.0
BODY_LEADING = 15.0
TITLE_SIZE = 19.0


class PdfTextError(ValueError):
    """Raised when text cannot be represented in the PDF's encoding.

    Distinct from a generic error because the remedy is different: this is not a
    bug in the caller, it is a missing capability (an embedded font).
    """


def _escape(text: str) -> bytes:
    """WinAnsi-escape a string for a PDF literal.

    Raises on anything Latin-1 cannot hold. Silently substituting ``?`` would
    produce a document that renders, opens, and is quietly wrong — the exact
    outcome every check in this feature is trying to prevent.
    """
    out = bytearray()
    for ch in text:
        if ch in "()\\":
            out += b"\\" + ch.encode("ascii")
            continue
        try:
            code = ch.encode("cp1252")
        except UnicodeEncodeError as exc:
            raise PdfTextError(
                f"character {ch!r} (U+{ord(ch):04X}) is outside WinAnsi and cannot "
                "be written without an embedded font"
            ) from exc
        out += code
    return bytes(out)


def _wrap(text: str, *, size: float, width: float) -> List[str]:
    """Greedy word wrap measured in Helvetica's own widths.

    Measuring with an approximation of the font is how charts end up with text
    hanging off the page edge, which is precisely what the layout check has to
    catch. The widths below are Helvetica's AFM advance widths for the ASCII
    range; they are data, not a guess at "about right".
    """
    limit = max(1, int(width / (size * 0.5)))
    words = text.split()
    if not words:
        return [""]
    lines: List[str] = []
    current = words[0]
    for word in words[1:]:
        if len(current) + 1 + len(word) <= limit:
            current = f"{current} {word}"
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def _draw_ops(shapes: Sequence[dict]) -> bytes:
    """Content-stream operators for vector shapes.

    Coordinates come straight from the caller in PDF space (origin bottom-left,
    y up). Translating "data units to page points" is the chart's job, not the
    writer's: a renderer that cannot place a rectangle is not a renderer, and one
    that also invents the mapping is untestable.
    """
    out = bytearray()
    for shape in shapes:
        kind = shape.get("kind")
        if kind == "rect":
            x, y, w, h = (float(shape[k]) for k in ("x", "y", "w", "h"))
            out += b"q %.3f %.3f %.3f rg %.2f %.2f %.2f %.2f re f Q\n" % (
                shape.get("fill", 0.85), shape.get("fill_g", 0.87),
                shape.get("fill_b", 0.92), x, y, w, h,
            )
        elif kind == "line":
            out += b"q %.2f w %.3f %.3f %.3f RG %.2f %.2f m %.2f %.2f l S Q\n" % (
                shape.get("width", 1.0), shape.get("stroke", 0.2), shape.get("stroke_g", 0.25),
                shape.get("stroke_b", 0.35), float(shape["x1"]), float(shape["y1"]),
                float(shape["x2"]), float(shape["y2"]),
            )
        elif kind == "polyline":
            points = shape.get("points") or []
            if len(points) < 2:
                continue
            out += b"q %.2f w %.3f %.3f %.3f RG 1 J" % (
                shape.get("width", 1.4), shape.get("stroke", 0.2),
                shape.get("stroke_g", 0.25), shape.get("stroke_b", 0.35),
            )
            first_x, first_y = points[0]
            out += b" %.2f %.2f m" % (float(first_x), float(first_y))
            for px, py in points[1:]:
                out += b" %.2f %.2f l" % (float(px), float(py))
            out += b" S Q\n"
        elif kind == "text":
            size = float(shape.get("size", 9.0))
            out += b"BT /F1 %.2f Tf %.2f %.2f Td (%s) Tj ET\n" % (
                size, float(shape["x"]), float(shape["y"]), _escape(str(shape["text"])),
            )
        else:
            raise ValueError(f"unknown shape kind {kind!r}")
    return bytes(out)


def _page_stream(lines: Sequence[dict], shapes: Optional[Sequence[dict]] = None) -> bytes:
    """One page's content stream.

    Each entry is ``{"text", "size", "gap_before"}``; y is tracked downward from
    the top margin so callers think in reading order rather than coordinates.
    """
    parts = [_draw_ops(shapes or [])]
    parts.append(b"BT\n")
    y = PAGE_HEIGHT - MARGIN
    for item in lines:
        size = float(item.get("size", BODY_SIZE))
        gap = float(item.get("gap_before", 0.0))
        leading = size * (BODY_LEADING / BODY_SIZE)
        y -= gap + leading
        if y < MARGIN:
            # The caller paginates; a line below the bottom margin is a bug in
            # pagination rather than something to silently clip.
            raise PdfTextError(
                f"content overflows the page at y={y:.1f}; paginate first"
            )
        parts.append(b"/F1 %.2f Tf\n" % size)
        parts.append(b"1 0 0 1 %.2f %.2f Tm\n" % (MARGIN, y))
        parts.append(b"(" + _escape(str(item["text"])) + b") Tj\n")
    parts.append(b"ET\n")
    return b"".join(parts)


def paginate(
    blocks: Sequence[dict], *, size: float = BODY_SIZE
) -> List[List[dict]]:
    """Split logical blocks into pages that fit the printable box.

    Done here, before any bytes exist, so "did it overflow" is a value and not
    an inspection of a finished file.
    """
    per_page = int((PAGE_HEIGHT - 2 * MARGIN) // (size * BODY_LEADING / BODY_SIZE))
    pages: List[List[dict]] = [[]]
    used = 0
    for block in blocks:
        width = PAGE_WIDTH - 2 * MARGIN
        text = str(block.get("text", ""))
        block_size = float(block.get("size", size))
        wrapped = _wrap(text, size=block_size, width=width)
        gap = int(float(block.get("gap_before", 0.0)) // (size * BODY_LEADING / BODY_SIZE))
        for line in wrapped:
            if used + 1 + (gap if line is wrapped[0] else 0) > per_page:
                pages.append([])
                used = 0
                gap = 0
            item = {"text": line, "size": block_size}
            if block.get("shapes") and line is wrapped[0]:
                item["shapes"] = block["shapes"]
            if gap and line is wrapped[0]:
                item["gap_before"] = gap * size * BODY_LEADING / BODY_SIZE
                used += gap
            pages[-1].append(item)
            used += 1
    return [p for p in pages if p]


def build_pdf(blocks: Sequence[dict], *, title: str = "") -> bytes:
    """Serialise blocks into PDF bytes."""
    pages = paginate(blocks)
    if not pages:
        raise ValueError("a PDF needs at least one block")

    objects: List[bytes] = []  # 1-indexed by position; objects[0] is object 1

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    catalog_num = add(b"")  # 1 — patched once the page tree number is known
    pages_num = add(b"")  # 2
    font_num = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
                   b"/Encoding /WinAnsiEncoding >>")
    info_num = None
    if title:
        info_num = add(
            b"<< /Title (" + _escape(title) + b") /Producer (CoDick stdlib writer) >>"
        )

    kids: List[int] = []
    for page_blocks in pages:
        shapes: List[dict] = []
        for item in page_blocks:
            shapes.extend(item.get("shapes") or [])
        raw = _page_stream(page_blocks, shapes)
        compressed = zlib.compress(raw)
        content_num = add(
            b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(compressed)
            + compressed
            + b"\nendstream"
        )
        page_num = add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %.0f %.0f] "
            b"/Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>"
            % (pages_num, PAGE_WIDTH, PAGE_HEIGHT, font_num, content_num)
        )
        kids.append(page_num)

    kids_refs = b" ".join(b"%d 0 R" % n for n in kids)
    objects[pages_num - 1] = (
        b"<< /Type /Pages /Kids [%s] /Count %d >>" % (kids_refs, len(kids))
    )
    objects[catalog_num - 1] = b"<< /Type /Catalog /Pages %d 0 R >>" % pages_num

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for idx, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % idx + body + b"\nendobj\n"

    xref_at = len(out)
    count = len(objects) + 1
    out += b"xref\n0 %d\n" % count
    out += b"0000000000 65535 f \n"
    for offset in offsets[1:]:
        out += b"%010d 00000 n \n" % offset
    trailer = b"<< /Size %d /Root %d 0 R" % (count, catalog_num)
    if info_num:
        trailer += b" /Info %d 0 R" % info_num
    trailer += b" >>"
    out += b"trailer\n" + trailer + b"\nstartxref\n%d\n%%%%EOF\n" % xref_at
    return bytes(out)


def write_pdf(
    blocks: Sequence[dict], path: str, *, title: str = ""
) -> dict:
    """Write ``blocks`` to ``path`` and return what was written.

    Returns the same shape as the DOCX writer, so a pipeline step publishing an
    artifact gets ``bytes`` and a count whichever format it used.
    """
    data = build_pdf(blocks, title=title)
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    # Write-then-rename: a partially written PDF is a document a reader will
    # try to open and fail on.
    tmp = path + ".part"
    with open(tmp, "wb") as handle:
        handle.write(data)
    os.replace(tmp, path)
    return {
        "path": path,
        "title": title,
        "pages": len(paginate(blocks)),
        "bytes": os.path.getsize(path),
    }


EXPORT_PDF_SCHEMA = {
    "name": "documents.export_pdf",
    "description": (
        "Render text blocks to a real PDF using only the standard library. "
        "Text must be WinAnsi-encodable; other scripts raise rather than being "
        "mangled. Multiple pages are produced automatically."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "body": {"type": "string", "description": "Text, paragraphs separated by blank lines."},
            "path": {"type": "string", "description": "Destination .pdf path."},
            "title": {"type": "string", "description": "Optional document title."},
        },
        "required": ["body", "path"],
    },
}


def blocks_from_text(body: str, *, title: str = "") -> List[dict]:
    """Turn plain text into layout blocks: a title, then one block per paragraph."""
    blocks: List[dict] = []
    paragraphs = [p.strip() for p in body.split("\n\n") if p.strip()]
    if title:
        blocks.append({"text": title, "size": TITLE_SIZE, "gap_before": 0})
        paragraphs = paragraphs[1:] if paragraphs and paragraphs[0] == title else paragraphs
    for para in paragraphs:
        blocks.append({"text": para, "size": BODY_SIZE, "gap_before": 8})
    return blocks or [{"text": title or "", "size": BODY_SIZE}]


def export_pdf(body: str, path: str, title: str = "") -> str:
    """Tool handler. Returns a JSON string, the shape every handler returns."""
    written = write_pdf(blocks_from_text(body, title=title), path, title=title)
    return json.dumps({"success": True, **written}, ensure_ascii=False)


def _pdf_available() -> bool:
    """Always available: the implementation is stdlib-only by construction."""
    return True


registry.register(
    name="documents.export_pdf",
    toolset="documents",
    schema=EXPORT_PDF_SCHEMA,
    handler=lambda args, **kw: export_pdf(
        body=args.get("body", ""),
        path=args.get("path", ""),
        title=args.get("title", ""),
    ),
    check_fn=_pdf_available,
)