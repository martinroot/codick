"""``documents.export_docx`` — the tool #34 found missing (spec §8, #35).

The verification that matters is the round trip. Writing bytes and then
inspecting the bytes you just wrote proves nothing, so every test that can read
the file back does it through :mod:`tools.read_extract`, the reader this
repository already ships. A DOCX that opens nowhere is exactly the fictional
success #34 was written to prevent.
"""

from __future__ import annotations

import os
import sys
import zipfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from tools.documents_export_docx_tool import build_document_xml, export_docx, write_docx  # noqa: E402
from tools.read_extract import extract_document_text, is_extractable_document  # noqa: E402
from tools.registry import registry  # noqa: E402

TOOL_ID = "documents.export_docx"

#: The parts Word requires to treat the package as a document rather than
#: offering to repair it. Named as a constant because "it opened" is a claim
#: about structure, and structure is what breaks silently.
REQUIRED_PARTS = {
    "[Content_Types].xml",
    "_rels/.rels",
    "word/document.xml",
}


def test_the_tool_is_registered_under_the_id_the_spec_names():
    """Spec §8, and every Word template, name this tool `documents.export_docx`.

    A plain name would leave every Word template honestly `unavailable` for ever,
    pointing at an id that does not exist.
    """
    assert TOOL_ID in registry.get_all_tool_names()


def test_a_registered_tool_must_be_reachable_through_a_toolset():
    """Discovery registers the schema; a toolset is what exposes it.

    A tool in no toolset is registered, invisible, and looks finished.
    """
    assert registry.get_toolset_for_tool(TOOL_ID) is not None


def test_the_schema_declares_the_parameters_the_handler_needs():
    schema = registry.get_schema(TOOL_ID)
    assert schema is not None
    assert set(schema["parameters"]["required"]) == {"body", "path"}


def test_dispatch_writes_a_real_file_and_returns_json(tmp_path):
    """Through the registry, not the bare function — dispatch is the contract."""
    out = tmp_path / "report.docx"
    result = registry.dispatch(TOOL_ID, {"body": "Hello there.", "path": str(out)})
    assert out.exists()
    # All handlers return a JSON string; a handler returning prose would be
    # parsed by a caller as a string, not as the result.
    import json

    parsed = json.loads(result)
    assert parsed["success"] is True
    assert parsed["path"] == str(out)


def test_the_package_has_the_parts_word_needs(tmp_path):
    out = tmp_path / "parts.docx"
    write_docx(str(out), "Body text.")
    with zipfile.ZipFile(out) as zf:
        names = set(zf.namelist())
        assert REQUIRED_PARTS <= names
        assert zf.testzip() is None, "the archive itself is corrupt"


def test_the_repository_reader_opens_it(tmp_path):
    out = tmp_path / "readable.docx"
    write_docx(str(out), "First paragraph.\n\nSecond paragraph.", title="A Title")
    assert is_extractable_document(str(out))
    text = extract_document_text(str(out))
    assert "A Title" in text
    assert "First paragraph." in text
    assert "Second paragraph." in text


def test_markup_characters_survive_the_round_trip(tmp_path):
    """The failure mode of hand-written XML: an unescaped `&` makes an invalid
    document, and Word's answer to that is to refuse the file."""
    out = tmp_path / "escapes.docx"
    tricky = "Tom & Jerry <b>bold</b> \"quotes\" — and a dash"
    write_docx(str(out), tricky)
    assert tricky in extract_document_text(str(out))


def test_leading_and_trailing_spaces_are_preserved(tmp_path):
    """Without `xml:space=\"preserve\"` Word trims the ends of every run."""
    out = tmp_path / "spaces.docx"
    write_docx(str(out), "  indented text  ")
    assert "  indented text  " in extract_document_text(str(out))


def test_paragraphs_are_kept_as_paragraphs(tmp_path):
    out = tmp_path / "paras.docx"
    written = write_docx(str(out), "One.\n\nTwo.\n\nThree.")
    assert written["paragraphs"] == 3
    with zipfile.ZipFile(out) as zf:
        document = zf.read("word/document.xml").decode("utf-8")
    assert document.count("<w:p>") == 3


def test_explicit_paragraphs_win_over_the_body(tmp_path):
    out = tmp_path / "explicit.docx"
    write_docx(str(out), "ignored", paragraphs=["only this"])
    assert "only this" in extract_document_text(str(out))
    assert "ignored" not in extract_document_text(str(out))


def test_an_empty_document_is_still_a_valid_document(tmp_path):
    """Zero bytes of text must not produce a file Word calls corrupt."""
    out = tmp_path / "empty.docx"
    write_docx(str(out), "")
    assert out.exists()
    assert is_extractable_document(str(out))


def test_missing_parent_directories_are_created(tmp_path):
    out = tmp_path / "nested" / "deeper" / "report.docx"
    write_docx(str(out), "Nested.")
    assert out.exists()


def test_the_document_xml_is_well_formed_on_its_own():
    """Parsing it separately catches a malformed part before it reaches a zip."""
    import xml.etree.ElementTree as ET

    ET.fromstring(build_document_xml(["a", "b"], title="t"))


def test_a_title_is_a_heading_not_body_text():
    """Distinctive strings: "body" also names the <w:body> element, so searching
    for it finds the wrapper long before it finds the paragraph."""
    document = build_document_xml(["the paragraph text"], title="The Heading")
    assert "<w:b/>" in document, "the title is emphasised, so it reads as a heading"
    assert document.index("The Heading") < document.index("the paragraph text")


def test_writing_a_document_pulls_in_no_third_party_package(tmp_path):
    """The reason this exists at all: this install has no python-docx, no
    pandoc and no libreoffice, so a tool a product sells cannot need one.

    Checked by what the import did to `sys.modules` rather than by reading the
    source — the observable fact is that nothing optional got pulled in.
    """
    import subprocess

    code = (
        "import sys; sys.path.insert(0, %r);"
        "import tools.documents_export_docx_tool as m;"
        "m.write_docx('/tmp/dep-probe.docx', 'text');"
        "print('docx' in sys.modules, 'lxml' in sys.modules)"
        % os.path.join(os.path.dirname(__file__), "..", "..")
    )
    out = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "False False", (
        f"writing a DOCX pulled in an optional package: {out.stdout!r}"
    )