"""Where does this delivery go? (#55)

Storage already carries the destinations -- ``profile``, ``project``, ``channel``
-- so what was missing was the *decision*: a deterministic, inspectable rule for
choosing between them.

## The rules, and why they are in this order

1. **An exact project match wins.** Someone set up a lane for that project
   precisely so deliveries stop needing a decision. A channel default must not
   quietly overrule it.
2. **An explicit override on the delivery wins over everything except a
   project.** Someone who typed a profile meant it.
3. **A channel default applies** when nobody was more specific.
4. **Otherwise the task is unrouted**, and says so.

## Unrouted is a state, not a shrug

A delivery that matches no rule does not get a guess and does not get dropped.
It becomes ``unrouted`` with the reason attached, and ``ExternalTask.state`` is
set to it, so it is visible on the board and countable. A default profile
invented at the last moment is how work gets executed by the wrong worker
without anybody noticing until the output is wrong.

That is the same rule as the rest of this work -- unknown is never zero, an
unexplained number is never free -- applied to ownership: **unassigned is not
assigned to whoever happened to be default.**
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, List, Mapping, Optional, Sequence

UNROUTED = "unrouted"
ROUTED = "routed"

# Precedence, lowest priority first. Exposed so the order is a stated contract
# rather than an accident of how the branches happen to be written.
PRECEDENCE = ("default", "channel", "override", "project")


@dataclass(frozen=True)
class Rule:
    """One routing rule. Every field left unset simply does not match."""

    profile: Optional[str] = None
    project: Optional[str] = None
    channel: Optional[str] = None
    #: Substring match against the title. Deliberately not a regex: a routing
    #: table that executes user-supplied patterns is a routing table that can
    #: hang, and a hung router drops deliveries silently.
    title_contains: Optional[str] = None
    name: str = ""

    def matches(self, task: Mapping[str, Any]) -> bool:
        if self.project is not None and task.get("project") != self.project:
            return False
        if self.channel is not None and task.get("channel") != self.channel:
            return False
        if self.title_contains is not None:
            title = (task.get("title") or "").lower()
            if self.title_contains.lower() not in title:
                return False
        # A rule that constrains nothing matches everything, which is a default
        # wearing a rule's clothes. It is allowed, but it is named so.
        return not (
            self.project is None and self.channel is None and self.title_contains is None
        )


@dataclass
class RouteDecision:
    profile: Optional[str] = None
    project: Optional[str] = None
    channel: Optional[str] = None
    reason: str = ""
    source: str = ""
    kind: str = ROUTED
    considered: List[str] = field(default_factory=list)

    @property
    def routed(self) -> bool:
        return self.kind == ROUTED and bool(self.profile)

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "routed": self.routed,
            "profile": self.profile,
            "project": self.project,
            "channel": self.channel,
            "reason": self.reason,
            "source": self.source,
            "considered": self.considered,
        }

    def apply_to(self, task: Any) -> Any:
        """Write the decision onto an ``ExternalTask``, leaving unrouted ones be.

        An unrouted task keeps whatever it had. Writing a null profile over one
        would be a decision dressed as an absence.
        """
        if not self.routed:
            return task
        task.profile = self.profile
        if self.project is not None:
            task.project = self.project
        if self.channel is not None:
            task.channel = self.channel
        return task


def route(
    task: Mapping[str, Any],
    rules: Sequence[Rule] = (),
    *,
    default_profile: Optional[str] = None,
) -> RouteDecision:
    """Decide where *task* goes, and say why.

    The whole decision is returned, not just the answer: an operator asking
    "why did this run under that profile" gets a named rule and a reason rather
    than a guess.
    """
    considered: List[str] = []

    # 1. An exact project match beats everything a channel default could say.
    for rule in rules:
        if rule.project is not None and task.get("project") == rule.project:
            considered.append(rule.name or f"project:{rule.project}")
            return RouteDecision(
                profile=rule.profile or task.get("profile"),
                project=rule.project,
                channel=task.get("channel"),
                reason=f"project {rule.project!r} has its own route",
                source=rule.name or f"project:{rule.project}",
                considered=considered,
            )

    # 2. A profile named on the delivery itself.
    if task.get("profile"):
        considered.append("task.profile")
        return RouteDecision(
            profile=task["profile"],
            project=task.get("project"),
            channel=task.get("channel"),
            reason="the delivery named a profile",
            source="task.profile",
            considered=considered,
        )

    # 3. A channel default, then any remaining rule.
    for rule in rules:
        if rule.channel is not None and task.get("channel") == rule.channel:
            considered.append(rule.name or f"channel:{rule.channel}")
            return RouteDecision(
                profile=rule.profile,
                project=task.get("project"),
                channel=rule.channel,
                reason=f"channel {rule.channel!r} routes to {rule.profile!r}",
                source=rule.name or f"channel:{rule.channel}",
                considered=considered,
            )

    for rule in rules:
        if rule.matches(task):
            considered.append(rule.name or "rule")
            return RouteDecision(
                profile=rule.profile,
                project=task.get("project"),
                channel=task.get("channel"),
                reason=f"matched rule {rule.name or '(unnamed)'}",
                source=rule.name or "(unnamed)",
                considered=considered,
            )

    if default_profile:
        considered.append("default")
        return RouteDecision(
            profile=default_profile,
            project=task.get("project"),
            channel=task.get("channel"),
            reason="no rule matched; the install default was used",
            source="default",
            considered=considered,
        )

    return RouteDecision(
        kind=UNROUTED,
        reason=(
            "no rule matched this delivery and the install has no default "
            "profile; it is left unrouted rather than guessed at"
        ),
        source="none",
        considered=considered,
    )
