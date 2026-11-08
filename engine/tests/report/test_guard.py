"""Copy guard: the banned-phrase table, sentence redaction and the rewrite/redact flow."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from hyvo.llm.protocol import find_protocol
from hyvo.llm.types import BudgetExceeded, LLMRequestError, LLMResponseError
from hyvo.report.guard import (
    BANNED_RULES,
    REMOVED_TEXT,
    facts,
    find_violations,
    guard_report,
    redact,
)
from hyvo.report.prompt import extract_data
from hyvo.runfile import DISCLAIMER, Report

from .samples import FakeClient

VECTORS = json.loads((Path(__file__).resolve().parents[3] / "packages/schema/test-vectors/guard-cases.json").read_text(encoding="utf-8"))
GUARD_CASES: list[tuple[str, list[str]]] = [tuple(case) for case in VECTORS["exact"]]


@pytest.mark.parametrize(("text", "expected"), GUARD_CASES, ids=[c[0][:40] for c in GUARD_CASES])
def test_banned_phrase_table(text: str, expected: list[str]) -> None:
    assert find_violations(text) == expected


@pytest.mark.parametrize("text, rule", [tuple(case) for case in VECTORS["contains"]])
def test_forecasts_a_real_model_wrote_are_caught(text: str, rule: str) -> None:
    assert rule in find_violations(text)


@pytest.mark.parametrize(
    "text",
    [
        "Is this the next leg up?",
        "Still waiting for the price to rise before I jump in.",
        "I'm out! Made a quick profit and don't want to risk losing it all.",
        "Still up 10% after that minor correction",
        "I was hoping for a pump, but now it's time to cut my losses",
        "Looks like a pump and dump to me.",
        "This is getting out of hand. We need to calm down and think about what we're doing.",
        "The rally ran out of steam after round 4 and the price fell 5%.",
        "I'm going to take a little profit here.",
        "I'll hold on to my GLINT for now.",
        "Time to take profit, I'm selling 0.15 ETH worth of GLINT.",
        "The snipers were the most active, and this was no winner-takes-all market.",
        "We'll see how this creator tax thing plays out before we make any big moves.",
        "I'll dump my bag if the team stays quiet.",
        "We just need to be patient and give the project time to develop.",
    ],
)
def test_what_a_real_model_wrote_that_is_fine_stays(text: str) -> None:
    assert find_violations(text) == []


def test_table_has_every_rule_and_enough_cases() -> None:
    assert len(GUARD_CASES) >= 25
    covered = {rule for _, rules in GUARD_CASES for rule in rules}
    assert covered == set(BANNED_RULES)
    assert sum(1 for _, rules in GUARD_CASES if not rules) >= 10


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Prices rose. Buy now! Sentiment fell.", "Prices rose. Sentiment fell."),
        ("Volume rose. Sell pressure followed.", "Volume rose."),
        ("Line one.\n- sell early\nLine three.", "Line one. Line three."),
        ("You should sell.", ""),
        ("It will moon. Guaranteed.", ""),
        ("Nothing to remove here.", "Nothing to remove here."),
        ("Price 0.000001 held. Time to buy?", "Price 0.000001 held."),
    ],
)
def test_redact_drops_only_offending_sentences(text: str, expected: str) -> None:
    assert redact(text) == expected
    assert find_violations(redact(text)) == []


def test_facts_normalize_numbers_and_collect_post_ids() -> None:
    assert facts("Round 3 fell 30.5600% (p4, c12), 100 ETH.") == {"3", "30.56", "4", "p4", "12", "c12", "100"}
    assert facts("007 and 0.50 and 0.0") == {"7", "0.5", "0"}
    wei = "123456789012345678901234567890123"
    assert facts(wei) == {wei} and facts(wei[:-1] + "4") != {wei}, "no rounding of long numbers"
    assert facts("No numbers.") == set()


def _report(**overrides: Any) -> dict[str, Any]:
    report: dict[str, Any] = {
        "summary": "The crowd added ETH early.",
        "turningPoint": {"round": 3, "why": "The rumor preceded exits (p4)."},
        "sentimentByRound": [0.1, 0.2, -0.3],
        "objections": ["The tax drew doubts (c2).", "A second doubt."],
        "priceDrivers": ["Round 3 exits moved the price."],
        "disclaimer": DISCLAIMER,
        "flags": [],
    }
    report.update(overrides)
    return report


def test_a_clean_report_needs_no_call() -> None:
    report = _report()
    client = FakeClient([])
    guarded = guard_report(report, client)
    assert guarded == report and guarded is not report and client.calls == []


def test_only_offending_fields_are_sent_for_rewriting() -> None:
    report = _report(summary="Prices rose. You should buy now.",
                     objections=["The tax drew doubts (c2).", "It is a bad token."])
    client = FakeClient([LLMRequestError("down")])
    guard_report(report, client)
    [call] = client.calls
    assert find_protocol(call["messages"]) == "report_rewrite/v1"
    assert call["purpose"] == "report" and call["json_mode"] is True and call["temperature"] == 0.0
    data = extract_data(call["messages"])
    assert data["fields"] == {"summary": "Prices rose. You should buy now.", "objections.1": "It is a bad token."}
    assert data["brokenRules"] == {"summary": ["advice_modal", "advice_noun"], "objections.1": ["bad_token"]}
    assert set(data["ruleDescriptions"]) == {"advice_modal", "advice_noun", "bad_token"}


def test_an_accepted_rewrite_is_flagged_rewritten() -> None:
    report = _report(priceDrivers=["Holders should sell after round 3."])
    rewrite = {"fields": {"priceDrivers.0": "Holder agents sold after round 3."}}
    guarded = guard_report(report, FakeClient([rewrite]))
    assert guarded["priceDrivers"] == ["Holder agents sold after round 3."]
    assert guarded["flags"] == ["rewritten:advice_modal"]
    Report.model_validate(guarded)


def test_a_rewrite_that_still_breaks_a_rule_is_dropped_and_the_original_redacted() -> None:
    report = _report(summary="Prices rose. You should buy now.")
    rewrite = {"fields": {"summary": "Prices rose. Buy now."}}
    guarded = guard_report(report, FakeClient([rewrite]))
    assert guarded["summary"] == "Prices rose."
    assert guarded["flags"] == ["redacted:advice_modal", "redacted:advice_noun"]


def test_redaction_keeps_clean_sentences_that_only_the_original_had() -> None:
    # The reviewer's case: the rewrite lost the clean first sentence and still broke rules.
    original = "The synthetic crowd traded the pool. You should buy now: the price will rise."
    report = _report(summary=original)
    rewrite = {"fields": {"summary": "Holders should buy more; it is a good token."}}
    guarded = guard_report(report, FakeClient([rewrite]))
    assert guarded["summary"] == "The synthetic crowd traded the pool."
    assert guarded["flags"] and all(flag.startswith("redacted:") for flag in guarded["flags"])


def test_a_rewrite_that_adds_facts_is_discarded() -> None:
    report = _report(objections=["Holders must sell now."])
    rewrite = {"fields": {"objections.0": "Holder agents sold 40% in round 7 (p9)."}}
    guarded = guard_report(report, FakeClient([rewrite]))
    assert guarded["objections"] == []
    assert guarded["flags"] == ["redacted:advice_modal", "redacted:advice_noun"]


@pytest.mark.parametrize(
    "reply",
    [
        LLMRequestError("down"),
        LLMResponseError("truncated", finish_reason="length"),
        BudgetExceeded("max_llm_calls", "report"),
        "not json",
        {"fields": "not an object"},
        {"fields": {"summary": 5}},
        {"fields": {"summary": "   "}},
        {"fields": {"summary": "x" * 1501}},
        {"fields": {"objections.7": "An unknown field."}},
        {"other": {}},
    ],
    ids=["request error", "response error", "budget", "not json", "fields not object", "not text",
         "blank", "too long", "unknown key", "no fields"],
)
def test_a_failed_rewrite_falls_back_to_redaction(reply: Any) -> None:
    report = _report(summary="The crowd added ETH. Time to buy.")
    guarded = guard_report(report, FakeClient([reply]))
    assert guarded["summary"] == "The crowd added ETH."
    assert guarded["flags"] == ["redacted:time_to"]


def test_fully_redacted_fields() -> None:
    report = _report(
        summary="You should buy.",
        turningPoint={"round": 2, "why": "It will moon."},
        objections=["Sell now!", "The tax drew doubts (c2)."],
        priceDrivers=["Guaranteed upside."],
    )
    guarded = guard_report(report, FakeClient([LLMRequestError("down")]))
    assert guarded["summary"] == REMOVED_TEXT
    assert guarded["turningPoint"] == {"round": 2, "why": REMOVED_TEXT}
    assert guarded["objections"] == ["The tax drew doubts (c2)."]
    assert guarded["priceDrivers"] == []
    assert guarded["flags"] == ["redacted:advice_modal", "redacted:will_pump", "redacted:advice_imperative",
                                "redacted:advice_noun", "redacted:guaranteed"]
    Report.model_validate(guarded)


def test_guard_keeps_existing_flags_and_does_not_mutate_its_input() -> None:
    report = _report(summary="Buy now.", flags=["rewritten:advice_noun"])
    original = copy.deepcopy(report)
    guarded = guard_report(report, FakeClient([LLMRequestError("down")]))
    assert report == original
    assert guarded["flags"] == ["rewritten:advice_noun", "redacted:advice_imperative", "redacted:advice_noun"]
    assert guarded["summary"] == REMOVED_TEXT
