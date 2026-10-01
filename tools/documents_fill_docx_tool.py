"""Fill the blanks in a real .docx and write a new one (#71).

`documents.export_docx` builds a document from text. This one takes a document
that already exists -- a lease, a claim, a contract someone downloaded -- and
puts the answers into it. Everything else about the file survives: styles,
headers, footers, numbering, section properties. Only the runs that carried a
blank change.

## Why this is not a string replace

Word does not store a sentence as a sentence. It stores a sequence of *runs*,
each with its own formatting, and it splits them wherever formatting changed or
the text was last edited. A blank written as ``20__`` in the visible document is
three runs: ``20``, ``_``, ``_ г.`` -- so a replace over a single run finds
nothing, and a replace over the raw XML corrupts the markup.

So the unit of work is the **paragraph**: concatenate its runs, find the blank in
that text, and put the answer back into the first run the blank touched while
removing the touched characters from the rest. The answer inherits the
formatting of the first run it lands in, which is the formatting the blank
already had -- so a blank that was bold stays bold and an underlined blank stays
underlined.

## Ordered filling

This document's blanks have no names. They are ``_____`` and the only thing that
distinguishes them is the order they appear in. So `values` is positional, and
the tool reports how many blanks it found: a caller that passes 19 answers to a
20-blank contract is told, rather than quietly producing a half-filled document
with the last blank still empty and nothing saying so.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import zipfile
from typing import Any, Dict, List, Optional, Sequence, Tuple

from tools.registry import registry

#: The parts whose text runs are candidates for filling. Headers and footers
#: hold blanks in real contracts too -- a date or a number in a header is still
#: a blank the reader sees.
TEXT_PARTS = ("word/document.xml", "word/header1.xml", "word/header2.xml",
              "word/header3.xml", "word/footer1.xml", "word/footer2.xml",
              "word/footer3.xml", "word/footnotes.xml", "word/endnotes.xml")

#: A run of at least two underscores. Two, not three: a contract writes the year
#: as ``20__`` and the last two digits are exactly the part the reader supplies,
#: so a threshold that skips it leaves every date half-finished while the
#: document looks complete.
BLANK_RE = re.compile(r"_{2,}")

_PARAGRAPH_RE = re.compile(r"<w:p[ >].*?</w:p>", re.S)
_RUN_RE = re.compile(r"<w:r[ >].*?</w:r>", re.S)
# `<w:t\s[^>]*>` rather than `<w:t[^>]*>`: the looser form also matches
# `<w:tab/>`, `<w:tc/>`, `<w:tbl/>` -- `[^>]*` happily eats `ab/`. The contract
# this was written for is full of tabs, and a "text" that begins with a markup
# tag is a document rewritten into nonsense.
_TEXT_RE = re.compile(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>", re.S)


class DocxFillError(ValueError):
    """The document cannot be filled as asked."""


def _unescape(text: str) -> str:
    return (text.replace("&lt;", "<").replace("&gt;", ">")
            .replace("&quot;", '"').replace("&apos;", "'").replace("&amp;", "&"))


def _escape(text: str) -> str:
    return (text.replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;"))


def _run_text(run_xml: str) -> str:
    return "".join(_unescape(m) for m in _TEXT_RE.findall(run_xml))


def _set_run_text(run_xml: str, new_text: str) -> str:
    """Put ``new_text`` into a run, leaving its formatting untouched.

    A run may hold several ``<w:t>`` elements. The first takes the new text and
    the rest are emptied rather than removed: deleting elements changes the
    run's internal structure for no gain, and Word treats an empty ``<w:t/>`` as
    exactly what it is -- nothing.
    """
    matches = list(_TEXT_RE.finditer(run_xml))
    if not matches:
        return run_xml
    out = []
    cursor = 0
    for i, m in enumerate(matches):
        out.append(run_xml[cursor:m.start()])
        out.append(f'<w:t xml:space="preserve">{_escape(new_text if i == 0 else "")}</w:t>')
        cursor = m.end()
    out.append(run_xml[cursor:])
    return "".join(out)


def _blank_spans(text: str) -> List[Tuple[int, int]]:
    """Where the blanks are, left to right.

    Adjacent underscore runs separated by a short dash-dot run are one blank --
    Word likes to split ``____-____`` into pieces -- but a genuinely separate
    field keeps its own.
    """
    spans: List[Tuple[int, int]] = []
    for m in BLANK_RE.finditer(text):
        spans.append((m.start(), m.end()))
    merged: List[Tuple[int, int]] = []
    for start, end in spans:
        if merged:
            prev_start, prev_end = merged[-1]
            between = text[prev_end:start]
            if between == "" or re.fullmatch(r"[-–— .]{1,3}", between):
                merged[-1] = (prev_start, end)
                continue
        merged.append((start, end))
    return merged


def _fill_paragraph(paragraph_xml: str, values: Sequence[str],
                    counter: List[int]) -> Tuple[str, int]:
    """Substitute into one paragraph. Returns the XML and blanks consumed."""
    runs = list(_RUN_RE.finditer(paragraph_xml))
    if not runs:
        return paragraph_xml, 0
    texts = [_run_text(m.group(0)) for m in runs]
    full = "".join(texts)
    spans = _blank_spans(full)
    if not spans:
        return paragraph_xml, 0

    # run boundaries in the concatenated string
    starts, pos = [], 0
    for t in texts:
        starts.append(pos)
        pos += len(t)

    def run_of(offset: int) -> int:
        for i in range(len(starts) - 1, -1, -1):
            if offset >= starts[i]:
                return i
        return 0

    # Values are assigned left to right, then applied right to left. Assigning
    # inside the reversed loop hands value[0] to the *rightmost* blank, which
    # produces a document that reads perfectly and says the wrong thing: the day
    # and the month of a lease simply swap, and nothing anywhere reports it.
    assigned = [(start, end, values[counter[0] + i] if counter[0] + i < len(values) else "")
                for i, (start, end) in enumerate(spans)]
    consumed = len(assigned)
    counter[0] += consumed
    # Applied right to left, so the offsets of the blanks still to come stay valid
    # as the runs ahead of them shorten.
    for start, end, value in reversed(assigned):
        first = run_of(start)
        last = run_of(max(start, end - 1))
        for i in range(first, last + 1):
            run_start = starts[i]
            run_end = run_start + len(texts[i])
            cut_start = max(start, run_start) - run_start
            cut_end = min(end, run_end) - run_start
            texts[i] = texts[i][:cut_start] + (value if i == first else "") + texts[i][cut_end:]

    # Write the runs back, last-to-first by offset so earlier spans are stable.
    out = paragraph_xml
    for i in reversed(range(len(runs))):
        m = runs[i]
        updated = _set_run_text(m.group(0), texts[i])
        out = out[:m.start()] + updated + out[m.end():]
    return out, consumed


def count_blanks(docx_path: str) -> int:
    """How many blanks this document has, across its text parts."""
    total = 0
    with zipfile.ZipFile(docx_path) as zf:
        names = set(zf.namelist())
        for part in TEXT_PARTS:
            if part not in names:
                continue
            xml = zf.read(part).decode("utf-8")
            for p in _PARAGRAPH_RE.finditer(xml):
                full = "".join(_run_text(m.group(0))
                               for m in _RUN_RE.finditer(p.group(0)))
                total += len(_blank_spans(full))
    return total


def fill_docx(source: str, destination: str, values: Sequence[str]) -> Dict[str, Any]:
    """Write ``destination`` with the blanks of ``source`` filled from ``values``.

    Refuses when the counts disagree. A contract filled 19 of 20 ways is a
    document that looks finished, carries an empty line where a number belongs,
    and says nothing about the gap -- which is the failure this tool exists to
    be able to refuse.
    """
    if not values:
        raise DocxFillError("no values supplied for a document that has blanks")
    with zipfile.ZipFile(source) as zf:
        names = zf.namelist()
        parts = {name: zf.read(name) for name in names}

    expected = count_blanks(source)
    if len(values) < expected:
        raise DocxFillError(
            f"document has {expected} blanks but only {len(values)} values were given; "
            "refusing to write a partly filled contract that looks complete")
    if len(values) > expected:
        # Extra answers are almost always a caller whose schema drifted. Saying so
        # beats silently discarding the ones that do not fit.
        raise DocxFillError(
            f"document has {expected} blanks but {len(values)} values were given; "
            "the extra answers have nowhere to go and would be lost silently")

    counter = [0]
    filled = 0
    for part in TEXT_PARTS:
        if part not in parts:
            continue
        xml = parts[part].decode("utf-8")

        def replace(match: "re.Match[str]", counter=counter) -> str:
            return _fill_paragraph(match.group(0), values, counter)[0]

        new_xml = _PARAGRAPH_RE.sub(replace, xml)
        filled = counter[0]
        if new_xml != xml:
            parts[part] = new_xml.encode("utf-8")

    tmp = destination + ".tmp"
    with zipfile.ZipFile(source) as zf_in, \
            zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf_out:
        for item in zf_in.infolist():
            zf_out.writestr(item, parts[item.filename])
    shutil.move(tmp, destination)
    return {
        "path": destination,
        "blanks": expected,
        "filled": filled,
        "bytes": os.path.getsize(destination),
        # A local file rewrite calls no provider: known free, and said so (#58).
        "cost_micros": 0,
    }


FILL_DOCX_SCHEMA = {
    "name": "documents.fill_docx",
    "description": (
        "Fill the blank underscores in an existing .docx and write a new file, "
        "keeping the original's styles, headers and footers. `values` is "
        "positional: the blanks are filled left to right, top to bottom."),
    "parameters": {
        "type": "object",
        "properties": {
            "source": {"type": "string", "description": "Path to the .docx to fill"},
            "destination": {"type": "string", "description": "Path for the filled copy"},
            "values": {
                "type": "array",
                "items": {"type": "string"},
                "description": "One value per blank, in the order the blanks appear.",
            },
        },
        "required": ["source", "destination", "values"],
    },
}


def run(source: str, destination: str, values: Sequence[str]) -> Dict[str, Any]:
    return fill_docx(source, destination, list(values))


def _available() -> bool:
    """Always available: the implementation is stdlib-only by construction."""
    return True


registry.register(
    name="documents.fill_docx",
    toolset="documents",
    schema=FILL_DOCX_SCHEMA,
    # A registry handler must return a string; a bare dict is rejected as an
    # unsupported result type and reaches the run as an error payload. The live
    # lease run produced exactly that.
    handler=lambda args, **kw: json.dumps(run(
        source=args.get("source", ""),
        destination=args.get("destination", ""),
        values=args.get("values") or [],
    ), ensure_ascii=False),
    check_fn=_available,
    emoji="🖋",
    read_only=False,
)
