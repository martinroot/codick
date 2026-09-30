"""Structured-output schema helpers for delegate_task (and the pipeline executor).

Optional per-task ``output_schema`` (a JSON Schema object): the child gets an
OUTPUT CONTRACT block appended to its context, the parent validates the final
answer with jsonschema, and on failure sends exactly ONE bounded retry turn
carrying the validation errors verbatim (more retries make frontier models
drop fields that were right the first time; the schema is never re-pasted).

The contract is prompt-level, not provider-enforced: the schema is injected
as text and the answer is re-validated after the fact. The pipeline's
correctness rests on this validation, so ``jsonschema`` is imported at module
level — a broken install fails loudly (ImportError) instead of silently
skipping validation, which used to make the contract mean "no validation".

Dialect policy (spec §5 — one documented version): every schema is validated
against JSON Schema Draft 2020-12, regardless of what its ``$schema`` key
declares. Draft-7-only keywords (tuple-form ``items``, ``dependencies``) are
not enforced; template authors must write Draft 2020-12.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional, Tuple

# Hard dependency (pyproject): no fallback path — see module docstring.
from jsonschema.validators import Draft202012Validator

logger = logging.getLogger(__name__)

#: The one supported JSON Schema dialect (spec §5), pinned over the library's
#: ``$schema``-based preference.
SUPPORTED_DIALECT = "https://json-schema.org/draft/2020-12/schema"


def coerce_output_schema(raw: Any) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """``(schema, None)`` when usable, ``(None, error)`` when not; ``None`` input
    passes through as ``(None, None)`` (no schema requested)."""
    if raw is None:
        return None, None
    if isinstance(raw, str):
        # Models sometimes double-encode the schema as a JSON string.
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            return None, "output_schema must be a JSON Schema object, got a non-JSON string."
        if not isinstance(raw, dict):
            return None, "output_schema must be a JSON Schema object."
    if not isinstance(raw, dict):
        return None, f"output_schema must be a JSON Schema object, got {type(raw).__name__}."
    try:
        Draft202012Validator.check_schema(raw)
    except Exception as exc:
        return None, f"output_schema is not a valid JSON Schema (Draft 2020-12): {exc}"
    return raw, None


def append_output_contract(context: Optional[str], schema: Dict[str, Any]) -> str:
    """Append the explicit output contract block to a child's context."""
    try:
        schema_text = json.dumps(schema, indent=2, ensure_ascii=False)
    except (TypeError, ValueError):
        schema_text = str(schema)
    block = ("OUTPUT CONTRACT (machine-validated):\n"
             "Your FINAL response must be ONLY the JSON value that validates against this JSON "
             "Schema — no prose before or after it, no code fence, no explanation. Anything else "
             "costs a correction turn and, if it fails again, is handed to the caller unvalidated.\n"
             f"{schema_text}")
    base = (context or "").rstrip()
    return f"{base}\n\n{block}" if base else block


def extract_json_candidate(text: str) -> str:
    """Strip markdown fences and prose around the outermost ``{...}``/``[...]``."""
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1]
        if raw.rstrip().endswith("```"):
            raw = raw.rstrip()[: -3]
        raw = raw.strip()
        if raw.lower().startswith("json\n"):
            raw = raw.split("\n", 1)[1]
    # Try each bracket kind's outermost span, earliest opener first, and keep the first that parses:
    # checking "{" before "[" unconditionally sliced a fenced array down to its first..last object and
    # rejected every valid array answer.
    spans = []
    for opener, closer in (("{", "}"), ("[", "]")):
        start, end = raw.find(opener), raw.rfind(closer)
        if start >= 0 and end > start:
            spans.append((start, raw[start : end + 1]))
    for _start, candidate in sorted(spans):
        try:
            json.loads(candidate)
            return candidate
        except ValueError:
            continue
    return spans[0][1] if spans else raw


def validate_output(text: str, schema: Dict[str, Any]) -> Tuple[bool, List[str]]:
    """``(True, [])`` or ``(False, errors)`` with strings suitable for the retry turn."""
    candidate = extract_json_candidate(text or "")
    if not candidate.strip():
        return False, ["Response was empty — expected a JSON object matching the schema."]
    try:
        parsed = json.loads(candidate)
    except (ValueError, TypeError) as exc:
        return False, [f"Response is not valid JSON: {exc}"]
    # Pinned dialect: Draft202012Validator, never validator_for(schema) — the library would
    # otherwise honor whatever ``$schema`` the payload declares.
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(parsed), key=lambda e: list(e.absolute_path))
    rendered = [  # bound error volume for the retry prompt
        "$" + "".join(f"[{p}]" if isinstance(p, int) else f".{p}" for p in err.absolute_path) + f": {err.message}"
        for err in errors[:10]]
    return not rendered, rendered


def build_retry_message(errors: List[str]) -> str:
    """Single bounded retry turn: errors verbatim, schema deliberately NOT re-pasted."""
    error_block = "\n".join(f"- {e}" for e in errors)
    return ("Your previous final response was rejected by the output contract "
            "validator. Validation errors:\n" f"{error_block}\n\n"
            "Reply with ONLY the corrected JSON object matching the OUTPUT "
            "CONTRACT schema from your task context. No prose, no explanations.")