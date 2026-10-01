"""#64 — the prose must agree with the chart it sits next to.

The failure this defends against is specific: a chart drawn correctly from real
data, and a sentence beside it claiming something the data does not support. The
chart is then perfect and useless, because readers take the sentence as the
finding.
"""

import pytest

from tools import documents_claims as claims


DATA = [1200.0, 1850.0, 2300.0]


# --- the obvious case ---------------------------------------------------------


def test_a_sentence_whose_numbers_are_all_in_the_data_passes():
    report = claims.verify_claims("Revenue was 1200 on Monday and 1850 on Tuesday.", DATA)
    assert report.consistent
    assert report.checked == 2


def test_a_number_the_data_does_not_contain_is_a_finding():
    report = claims.verify_claims("Revenue was 9900 on Monday.", DATA)
    assert not report.consistent
    assert report.explained[0].value == 9900.0


def test_the_finding_carries_the_surrounding_text():
    """A bare number is not actionable; the author needs to see the sentence."""
    report = claims.verify_claims("Revenue was 9900 on Monday.", DATA)
    assert "9900" in report.explained[0].context
    assert "Monday" in report.explained[0].context


def test_raising_names_the_first_offender_and_how_to_declare_it():
    report = claims.verify_claims("Revenue was 9900 and 1200.", DATA)
    with pytest.raises(ValueError) as excinfo:
        report.raise_if_inconsistent()
    message = str(excinfo.value)
    assert "9900.0" in message
    assert "allowed" in message, "the message must say how to make it legitimate"


def test_raising_a_consistent_report_returns_it():
    report = claims.verify_claims("Revenue was 1200.", DATA)
    assert report.raise_if_inconsistent() is report


# --- thousands separators -----------------------------------------------------


def test_thousands_separators_are_read_as_one_number():
    report = claims.verify_claims("Total revenue reached 1,850 today.", DATA)
    assert report.consistent
    assert [v for v, _ in claims.numeric_claims("Total reached 1,850 today.")] == [1850.0]


def test_a_decimal_is_read_as_a_decimal():
    assert [v for v, _ in claims.numeric_claims("The rate was 3.5 percent.")] == [3.5]


# --- legitimate numbers the data does not contain -----------------------------


def test_a_derived_total_can_be_declared():
    report = claims.verify_claims("Together the two days made 3050.", DATA,
                                  allowed=[3050.0])
    assert report.consistent
    assert report.allowed == [3050.0]


def test_allowance_is_explicit_not_default():
    """Nothing is waved through by default -- a default-exception rule is where
    every real exception ends up."""
    report = claims.verify_claims("The year 2026 saw growth.", DATA)
    assert not report.consistent
    assert claims.verify_claims("The year 2026 saw growth.", DATA,
                                allowed=[2026.0]).consistent


def test_a_years_digits_are_not_read_as_measurements():
    """`2026` in prose is a year, not a quantity. Reading it as a claim would
    bury the real findings under noise, so it must be declared, not guessed."""
    assert [v for v, _ in claims.numeric_claims("Report 2026")] == [2026.0]


def test_a_version_string_is_not_a_claim():
    assert claims.numeric_claims("Running version 1.2.3 in production") == []


# --- empty and degenerate input -----------------------------------------------


def test_no_claims_is_consistent():
    report = claims.verify_claims("Revenue rose across the period.", DATA)
    assert report.consistent and report.checked == 0


def test_empty_text_is_consistent():
    assert claims.verify_claims("", DATA).consistent


def test_a_report_with_no_data_flags_every_number():
    """An empty dataset does not silently excuse the text: it means the chart
    failed, and the prose still asserts things."""
    report = claims.verify_claims("Revenue was 1200.", [])
    assert not report.consistent


def test_none_text_is_tolerated():
    assert claims.verify_claims(None, DATA).consistent


# --- tolerance ----------------------------------------------------------------


def test_tolerance_defaults_to_exact():
    report = claims.verify_claims("Revenue was 1200.5.", DATA)
    assert not report.consistent


def test_tolerance_admits_floating_point_drift():
    report = claims.verify_claims("Revenue was 1200.0000001.", DATA, tolerance=1e-6)
    assert report.consistent


def test_tolerance_does_not_admit_a_different_number():
    report = claims.verify_claims("Revenue was 1201.", DATA, tolerance=0.5)
    assert not report.consistent


# --- the report shape ---------------------------------------------------------


def test_the_report_is_serialisable():
    report = claims.verify_claims("Revenue was 9900.", DATA)
    payload = report.as_dict()
    assert payload["checked"] == 1
    assert payload["consistent"] is False
    assert payload["unexplained"][0]["value"] == 9900.0


def test_an_empty_report_serialises():
    assert claims.verify_claims("Nothing numeric.", DATA).as_dict() == {
        "checked": 0, "consistent": True, "unexplained": [],
    }


# --- the property that matters ------------------------------------------------


def test_a_chart_and_its_caption_agree():
    """The end-to-end shape: values that were plotted, and the sentence built
    from them. Disagreement in the one direction a reader cannot detect."""
    plotted = [1200.0, 1850.0]
    good = "Monday 1200, Tuesday 1850."
    assert claims.verify_claims(good, plotted).consistent
    # The chart is untouched; only the sentence drifts.
    assert not claims.verify_claims("Monday 1200, Tuesday 1900.", plotted).consistent