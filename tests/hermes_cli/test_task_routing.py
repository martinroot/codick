"""#55 — routing decides, and says why.

The properties under test are the precedence order and the refusal. A router
that picks *something* is easy; a router that picks the right thing and can
explain itself is the part that matters when a delivery ran under the wrong
profile and produced the wrong output.
"""

from types import SimpleNamespace

import pytest

from hermes_cli import task_routing as routing
from hermes_cli.task_routing import ROUTED, UNROUTED, Rule


def task(**overrides):
    base = dict(platform="todo", external_id="e1", correlation_id="c1",
                profile=None, project=None, channel=None, title="do a thing")
    base.update(overrides)
    return base


# --- precedence ---------------------------------------------------------------


def test_an_exact_project_match_beats_a_channel_default():
    """Someone set up a lane for this project so deliveries stop needing a
    decision. A channel default must not overrule it."""
    decision = routing.route(
        task(project="billing", channel="ops"),
        [Rule(name="channel:ops", channel="ops", profile="ops-agent"),
         Rule(name="project:billing", project="billing", profile="billing-agent")],
    )
    assert decision.profile == "billing-agent"
    assert decision.source == "project:billing"


def test_project_precedence_holds_whatever_order_the_rules_are_written_in():
    rules = [
        Rule(name="project:billing", project="billing", profile="billing-agent"),
        Rule(name="channel:ops", channel="ops", profile="ops-agent"),
    ]
    assert routing.route(task(project="billing", channel="ops"), rules).profile \
        == "billing-agent"
    assert routing.route(task(project="billing", channel="ops"), rules[::-1]).profile \
        == "billing-agent"


def test_a_profile_named_on_the_delivery_beats_a_channel_default():
    decision = routing.route(
        task(profile="named-agent", channel="ops"),
        [Rule(name="channel:ops", channel="ops", profile="ops-agent")],
    )
    assert decision.profile == "named-agent"
    assert decision.source == "task.profile"


def test_a_channel_default_applies_when_nothing_is_more_specific():
    decision = routing.route(
        task(channel="ops"),
        [Rule(name="channel:ops", channel="ops", profile="ops-agent")],
    )
    assert decision.profile == "ops-agent"
    assert decision.source == "channel:ops"


def test_a_title_rule_applies_last():
    decision = routing.route(
        task(title="urgent invoice issue"),
        [Rule(name="title:invoice", title_contains="invoice", profile="billing-agent")],
    )
    assert decision.profile == "billing-agent"


def test_the_default_is_used_only_when_nothing_else_matched():
    decision = routing.route(
        task(channel="unheard-of"),
        [Rule(name="channel:ops", channel="ops", profile="ops-agent")],
        default_profile="house-agent",
    )
    assert decision.profile == "house-agent"
    assert decision.source == "default"
    assert "default" in decision.considered


# --- the refusal --------------------------------------------------------------


def test_an_unmatched_delivery_is_left_unrouted():
    decision = routing.route(task(channel="nowhere"), [])
    assert decision.kind == UNROUTED
    assert decision.routed is False
    assert decision.profile is None


def test_the_refusal_explains_itself():
    """'No profile' leaves an operator with nothing to act on."""
    decision = routing.route(task(channel="nowhere"), [])
    assert "no rule matched" in decision.reason
    assert "rather than guessed" in decision.reason


def test_no_default_means_unrouted_rather_than_a_guess():
    decision = routing.route(task(), [], default_profile=None)
    assert decision.kind == UNROUTED
    assert decision.profile is None


def test_a_routed_decision_without_a_profile_is_not_routed():
    """A rule that matched but named no profile has not assigned anything. It
    must not read as `routed` on the strength of matching alone."""
    decision = routing.route(task(title="x"), [Rule(name="empty", title_contains="x")])
    assert decision.kind == ROUTED
    assert decision.routed is False, "matched a rule but assigned no profile"


# --- applying the decision ----------------------------------------------------


def test_applying_a_routed_decision_writes_the_profile():
    target = SimpleNamespace(profile=None, project=None, channel="ops")
    routing.route(task(channel="ops"),
                  [Rule(name="c", channel="ops", profile="ops-agent")]).apply_to(target)
    assert target.profile == "ops-agent"


def test_applying_an_unrouted_decision_changes_nothing():
    """Writing a null over a real profile would be a decision dressed as an
    absence -- the task would look unassigned rather than unrouted."""
    target = SimpleNamespace(profile="already-set", project="p", channel="ops")
    before = (target.profile, target.project, target.channel)
    routing.route(task(channel="nowhere"), []).apply_to(target)
    assert (target.profile, target.project, target.channel) == before


def test_a_project_rule_sets_the_project_too():
    target = SimpleNamespace(profile=None, project=None, channel="ops")
    routing.route(task(project="billing", channel="ops"),
                  [Rule(name="p", project="billing", profile="billing-agent")]).apply_to(target)
    assert target.project == "billing"


# --- the decision is inspectable ---------------------------------------------


def test_the_decision_serialises_with_everything_an_operator_needs():
    payload = routing.route(
        task(project="billing"), [Rule(name="p", project="billing", profile="a")],
    ).as_dict()
    assert payload["routed"] is True
    assert payload["source"] == "p"
    assert payload["reason"]
    assert payload["considered"] == ["p"]


def test_an_unrouted_decision_serialises_too():
    payload = routing.route(task(), []).as_dict()
    assert payload == {"kind": UNROUTED, "routed": False, "profile": None,
                       "project": None, "channel": None, "reason": payload["reason"],
                       "source": "none", "considered": []}


def test_precedence_is_a_stated_order():
    """The order is exported so it can be asserted on, not inferred from the
    order the branches happen to be written in."""
    assert routing.PRECEDENCE == ("default", "channel", "override", "project")


# --- rule shape ---------------------------------------------------------------


def test_a_rule_that_constrains_nothing_does_not_match_everything():
    """A rule with no conditions is a default wearing a rule's clothes."""
    assert Rule(name="empty", profile="agent").matches(task()) is False


def test_a_channel_rule_does_not_fire_for_another_channel():
    assert Rule(name="c", channel="ops", profile="a").matches(task(channel="hr")) is False


def test_a_project_rule_does_not_fire_for_another_project():
    assert Rule(name="p", project="billing", profile="a").matches(task(project="other")) is False


def test_title_matching_is_case_insensitive():
    rule = Rule(name="t", title_contains="Invoice", profile="billing-agent")
    assert rule.matches(task(title="URGENT invoice")) is True


def test_a_project_rule_fires_for_a_task_with_no_project_at_all():
    """`None != 'billing'`, so a project rule must not swallow unlabelled work."""
    decision = routing.route(task(), [Rule(name="p", project="billing", profile="a")])
    assert decision.kind == UNROUTED
