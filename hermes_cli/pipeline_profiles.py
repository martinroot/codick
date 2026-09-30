"""Pipeline profile ids (spec ``docs/pipelines/spec.md`` §5, §6; issue #48).

A template step names a profile by a *logical id* (the spec's ``word-editor``,
``word-reviewer``, ``input-assistant``). Logical ids are bound to real profile
names through the ``pipelines.profiles`` config section — a mapping, not an
installation: profiles are full homes, so duplicating three profiles that
differ only in a prompt is the wrong shape, and the audit behind #48 found
this backend has **no named profiles at all** (``list_profile_names()`` →
``["default"]``).

Resolution has no fallback. An unmapped logical id is used as the profile name
itself; a silent default would turn a missing profile into a run on an
unspecialised home. Existence is a hard readiness gate (spec §6): a resolved
name that is not a live profile makes the template ``unavailable``, with the
same message text the dashboard's profile validation already shows an
operator (``profile '<name>' does not exist``).
"""

from __future__ import annotations

from typing import Any, List, Mapping, Optional

from hermes_constants import PROFILE_ID_RE

CONFIG_SECTION = "pipelines"
CONFIG_KEY = "profiles"

PROFILE_DOES_NOT_EXIST = "profile '{name}' does not exist"


class ProfileUnavailableError(ValueError):
    """A resolved profile is not a live profile on this backend.

    Message text deliberately matches the dashboard's existing profile
    validation so a pipeline readiness error reads like the error an operator
    has already seen for the same condition.
    """

    def __init__(self, name: str) -> None:
        super().__init__(PROFILE_DOES_NOT_EXIST.format(name=name))
        self.profile = name


def binding_from_config(config: Optional[Mapping[str, Any]]) -> dict:
    """The ``pipelines.profiles`` binding map: logical id -> real profile name.

    Non-string or blank entries are dropped rather than raising: a half-edited
    config must not take down template import; the affected id simply stays
    unmapped and reports as unavailable.
    """
    if not isinstance(config, Mapping):
        return {}
    section = config.get(CONFIG_SECTION)
    raw = section.get(CONFIG_KEY) if isinstance(section, Mapping) else None
    if not isinstance(raw, Mapping):
        return {}
    binding: dict = {}
    for logical, real in raw.items():
        lid, rid = str(logical).strip(), str(real).strip()
        if lid and rid:
            binding[lid] = rid
    return binding


def resolve_profile_id(logical: str, binding: Optional[Mapping[str, str]] = None) -> str:
    """Map a template's logical profile id onto a real profile name.

    No fallback: an unmapped id *is* the profile name it asks for (§5 keeps
    the ids nameable on purpose — see :data:`PROFILE_ID_RE`). An empty id is
    returned empty; the caller's own required-field validation reports it.
    """
    resolved = (logical or "").strip()
    if resolved and binding and resolved in binding:
        return binding[resolved].strip()
    return resolved


def profile_is_available(name: str, profiles_mod: Optional[Any] = None) -> bool:
    """True when *name* names a live profile (``default`` included).

    Fails closed: if the existence lookup itself errors, the profile reads as
    unavailable. This is a readiness gate, not a write path — the spec says a
    missing profile makes the template unavailable, and an unreadable roster
    is exactly the condition the gate exists to catch. (The dashboard's
    ``_validated_profile_name`` fails open for the opposite reason: a write
    path must not brick on a transient lookup error; here a run would start
    on the wrong home, which is the harm.)
    """
    if not name:
        return False
    if not PROFILE_ID_RE.match(name):
        # Fail closed on convention too: a name the profile filesystem can
        # never hold (dot, slash, uppercase) is not a nameable profile.
        return False
    if profiles_mod is None:
        from hermes_cli import profiles as profiles_mod
    try:
        return bool(profiles_mod.profile_exists(name))
    except Exception:
        return False


def unavailable_profile_ids(
    template: Mapping[str, Any],
    binding: Optional[Mapping[str, str]] = None,
) -> List[str]:
    """Logical profile ids of a template whose resolved profile is not live.

    Reads both places a profile id can appear (spec §5): ``steps[].profile``
    on agent steps and ``steps[].chat.profile`` on user_input steps with chat.
    Returned sorted and deduplicated, keyed by the template's own logical id,
    so an import error can point at ``steps[2].profile: word-editor`` (§6).
    """
    ids: List[str] = []
    steps = template.get("steps") if isinstance(template, Mapping) else None
    if not isinstance(steps, list):
        return ids
    for step in steps:
        if not isinstance(step, Mapping):
            continue
        candidates = [step.get("profile")]
        chat = step.get("chat")
        if isinstance(chat, Mapping):
            candidates.append(chat.get("profile"))
        for raw in candidates:
            if not isinstance(raw, str) or not raw.strip():
                continue
            logical = raw.strip()
            if logical in ids:
                continue
            resolved = resolve_profile_id(logical, binding)
            if not profile_is_available(resolved, profiles_mod=None):
                ids.append(logical)
    return ids
