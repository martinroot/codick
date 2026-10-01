"""Write a real .docx with the standard library (``documents.export_docx``).

## Why this exists rather than a dependency

Spec §8 names ``documents.export_docx`` as the tool a Word scenario needs, and
#34 established it did not exist. The obvious fix is ``pip install python-docx``
— and that is exactly what was rejected, because a tool a *product* sells cannot
require a package that may not be present on the install running it. This
install has neither ``python-docx``, nor ``pandoc``, nor ``libreoffice``, and a
DOCX is a ZIP of XML parts, so the honest dependency-free implementation is
about forty lines of ``zipfile``.

The output is a genuine Office Open XML package: the parts Word requires, the
content types declared, the relationship wired. Not a zip with a .docx
extension — that opens nowhere, and #34's rule against reporting a fictional
success applies here too.

## The dotted name is deliberate

Registered as ``documents.export_docx``, not ``export_docx``. Spec §8 and every
Word template name that tool by that id, and pipeline readiness compares a
template's ``tool`` against the registry's real names — a plain name would leave
every Word template honestly ``unavailable`` for ever, pointing at an id that
does not exist. The pipeline is this tool's consumer; the model-facing surface
is not the reason it is named the way it is.

## What it does not do

No images, tables, headers, footers, numbering or styles. Direct run formatting
only. A document that needs those needs a real library, and pretending this is
one would be the same fiction this file was written to avoid.
"""

from __future__ import annotations

import json
import os
import zipfile
from typing import Any, Dict, List, Optional
from xml.sax.saxutils import escape

from tools.registry import registry

__all__ = ["export_docx", "write_docx", "build_document_xml"]


# --- OOXML parts ------------------------------------------------------------------

_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>"""

_ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"""

_APP_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
 xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>Hermes</Application>
</Properties>"""

#: Page geometry in twentieths of a point — A4, 2cm margins. Written out rather
#: than left to Word's defaults so the document looks the same everywhere.
_SECT_PR = (
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>'
)


def _core_xml(title: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
        ' xmlns:dc="http://purl.org/dc/elements/1.1/">'
        f"<dc:title>{escape(title)}</dc:title>"
        "<dc:creator>Hermes</dc:creator>"
        "</cp:coreProperties>"
    )


def _runs(text: str) -> str:
    """One run, with ``xml:space`` so leading and trailing spaces survive.

    Without it Word trims the ends of a run, and a document that renders
    differently from the text it was given is worse than one that renders
    simply.
    """
    return f'<w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def build_document_xml(paragraphs: List[str], *, title: str = "") -> str:
    """Assemble ``word/document.xml`` from a list of paragraphs.

    A blank line becomes an empty paragraph rather than disappearing, so the
    paragraph count a caller asked for is the paragraph count in the file.
    """
    body: List[str] = []
    if title:
        # A heading paragraph, directly formatted rather than styled: this
        # package ships no styles.xml, and a reference to a style that does not
        # exist is a document Word offers to repair.
        body.append(
            '<w:p><w:pPr><w:spacing w:after="240"/></w:pPr>'
            '<w:r><w:rPr><w:b/><w:sz w:val="40"/></w:rPr>'
            f'<w:t xml:space="preserve">{escape(title)}</w:t></w:r></w:p>'
        )
    for para in paragraphs:
        body.append(
            "<w:p>" + ("" if para == "" else _runs(para)) + "</w:p>"
        )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{''.join(body)}{_SECT_PR}</w:body></w:document>"
    )


def write_docx(
    path: str, body: str, *, title: str = "",
    paragraphs: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Write ``body`` to ``path`` as a .docx and return what was written.

    ``paragraphs`` wins over ``body`` when given; ``body`` is split on blank
    lines so a caller can pass prose and still get a structured document.
    """
    if paragraphs is None:
        paragraphs = [block for block in str(body).replace("\r\n", "\n").split("\n\n")]
    directory = os.path.dirname(os.path.abspath(path))
    if directory:
        os.makedirs(directory, exist_ok=True)
    document = build_document_xml(paragraphs, title=title)
    # `deflate` is what every real DOCX uses; ZIP_STORED files of this size are
    # needlessly large and some readers are picky about them.
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", _CONTENT_TYPES)
        zf.writestr("_rels/.rels", _ROOT_RELS)
        zf.writestr("docProps/core.xml", _core_xml(title or os.path.basename(path)))
        zf.writestr("docProps/app.xml", _APP_XML)
        zf.writestr("word/document.xml", document)
    return {
        "path": path,
        "title": title,
        "paragraphs": len(paragraphs),
        "bytes": os.path.getsize(path),
    }


# --- the tool ---------------------------------------------------------------------

EXPORT_DOCX_SCHEMA = {
    "name": "documents.export_docx",
    "description": (
        "Write text to a Word .docx file and return its path. Produces a real "
        "Office Open XML package that Word and LibreOffice open. Use this when "
        "a deliverable has to be a document rather than a text file."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "body": {
                "type": "string",
                "description": "The document text. Blank lines separate paragraphs.",
            },
            "path": {
                "type": "string",
                "description": "Where to write the .docx. Relative paths resolve under the working directory.",
            },
            "title": {
                "type": "string",
                "description": "Optional heading rendered as the document's first paragraph.",
            },
        },
        "required": ["body", "path"],
    },
}


def export_docx(body: str, path: str, title: str = "") -> str:
    """Tool handler. Returns a JSON string, the shape every handler returns."""
    written = write_docx(path, body or "", title=title or "")
    return json.dumps({"success": True, **written}, ensure_ascii=False)


def _docx_available() -> bool:
    """Always available: the implementation is stdlib-only by construction."""
    return True


registry.register(
    name="documents.export_docx",
    toolset="documents",
    schema=EXPORT_DOCX_SCHEMA,
    handler=lambda args, **kw: export_docx(
        body=args.get("body", ""),
        path=args.get("path", ""),
        title=args.get("title", ""),
    ),
    check_fn=_docx_available,
    emoji="📄",
    read_only=False,
    idempotent=True,
)