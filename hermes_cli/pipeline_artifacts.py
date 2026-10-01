"""Turn a run's declared deliverable into a downloadable artifact (spec §7, §12).

A template declares what the run *produces*:

    "result": {"document": {"ref": "steps.export.output.artifact_ref"}}

Two things were missing between that declaration and a file the user can
download. `template["result"]` was validated for ref shape and then never read
again, and nothing in production ever called `register_artifact` — the download
route, the query-token exception and the `ArtifactList` UI were all reachable
only from a test that inserted rows by hand. A run could finish successfully
with nothing to download, which is the one outcome the spec's own example
promises is not possible.

So this is the missing link, and it is deliberately narrow:

- only refs the template *declared* are published, so a run's result stops
  being a dump of every step's raw output (which leaked tool paths through the
  API);
- a declared value is published only when it is a string naming an existing
  file, so a `condition` returning `"no"` is not mistaken for a file;
- the copy lands under `artifacts_root()/runs/<run_id>/` and is registered by
  its relative ref, because `register_artifact` refuses absolute paths and
  traversal — the run's working directory is not the artifact store, and
  pointing one at the other is the bug that would expose arbitrary files.

A template that declares no `result` keeps its previous behaviour: the full
output map. This module only owns the declared case.
"""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

from hermes_cli import pipelines_db as db

#: Extensions we are willing to serve. A declared ref is data from a step, and
#: serving an arbitrary file type from it is not something a template author
#: should get to do by accident.
_MIME_BY_SUFFIX = {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".csv": "text/csv",
}


def _safe_name(name: str) -> str:
    """A filename that cannot escape its directory or confuse a client."""
    cleaned = "".join(ch for ch in Path(name).name if ch.isalnum() or ch in "._- ")
    cleaned = cleaned.strip() or "artifact"
    return cleaned[:120]


def publish_file(
    conn, run_id: str, source: Path, *, owner: Optional[str] = None,
    filename: Optional[str] = None,
) -> str:
    """Copy ``source`` into the run's artifact directory and register it.

    Returns the artifact id. Raises ``ValueError`` for a source that is not a
    readable file, so a step that only claimed to produce a file fails loudly
    at completion instead of registering an artifact that 404s on download.
    """
    if not source.is_file():
        raise ValueError(f"declared result is not a readable file: {source.name}")
    name = _safe_name(filename or source.name)
    target_dir = db.artifacts_root() / "runs" / run_id
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / name
    if target.resolve() != source.resolve():
        shutil.copyfile(source, target)
    payload = target.read_bytes()
    return db.register_artifact(
        conn, run_id,
        filename=name,
        storage_ref=str(Path("runs") / run_id / name),
        size=len(payload),
        mime_type=_MIME_BY_SUFFIX.get(target.suffix.lower()),
        checksum=hashlib.sha256(payload).hexdigest(),
        owner=owner,
    )


def _download_path(artifact_id: str) -> str:
    return f"/api/pipelines/artifacts/{artifact_id}/download"


def _publish_if_file(conn, run_id: str, value: Any, *, owner: Optional[str]) -> Any:
    """Publish a declared value if it names a file; otherwise pass it through.

    The suffix check is what keeps a `condition`'s ``"no"`` or an agent's
    ``"see the attached draft"`` from being copied into the artifact store under
    a run directory.
    """
    if not isinstance(value, str) or not value.strip():
        return value
    suffix = Path(value).suffix.lower()
    if suffix not in _MIME_BY_SUFFIX:
        return value
    candidate = Path(value)
    if not candidate.is_absolute():
        # A tool step that wrote a relative path means "relative to the process
        # that ran it"; the executor's own directory is that place.
        candidate = Path.cwd() / candidate
    if not candidate.is_file():
        return value
    artifact_id = publish_file(conn, run_id, candidate, owner=owner)
    return {
        "artifact_id": artifact_id,
        "filename": _safe_name(candidate.name),
        "path": _download_path(artifact_id),
    }


def resolve_declared_result(
    conn, run_id: str, template: Mapping[str, Any], inputs: Mapping[str, Any],
    outputs: Mapping[str, Any], *, owner: Optional[str] = None,
    resolve_refs=None,
) -> Optional[Dict[str, Any]]:
    """Resolve a template's declared ``result`` into the run's public result.

    Returns ``None`` when the template declares no result, which is the caller's
    signal to keep the legacy full-output map. A declared value that cannot be
    published is passed through unchanged rather than dropped, so a template
    whose result is a plain string still reports that string.
    """
    declared = template.get("result")
    if not isinstance(declared, Mapping) or not declared:
        return None
    if resolve_refs is None:
        from hermes_cli.pipeline_executor import resolve_refs as _resolve
        resolve_refs = _resolve

    # `resolve_refs` already walks the whole structure, so the declared result
    # is resolved first and only then swept for files. A second hand-rolled
    # walker here would be a second implementation of ref substitution, and it
    # would silently skip `optional`/`default` on a ref node.
    def publish_pass(node: Any) -> Any:
        if isinstance(node, Mapping):
            return {key: publish_pass(value) for key, value in node.items()}
        if isinstance(node, list):
            return [publish_pass(item) for item in node]
        return _publish_if_file(conn, run_id, node, owner=owner)

    return publish_pass(resolve_refs(declared, inputs=inputs, outputs=outputs))