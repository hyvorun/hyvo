"""build_report: one validated model call, one retry, template and stats-only fallbacks, guard."""

from __future__ import annotations

import json
from typing import Any

import pytest

from hyvo.llm.protocol import find_protocol
from hyvo.llm.types import (
    BudgetExceeded,
    ChatMessage,
    LLMRequestError,
    LLMResponseError,
)
from hyvo.report import build_report
from hyvo.report.builder import validate_output
from hyvo.report.prompt import build_report_prompt
from hyvo.report.stats import compute_stats
from hyvo.report.template import NO_ROUNDS_SUMMARY
from hyvo.report.types import ReportInput, RoundTrace
from hyvo.runfile import DISCLAIMER, Report, model_errors

from .samples import FakeClient, make_input, run_with_report, valid_output

SENTIMENT = [0.15, 0.25, -0.35, -0.225]


def _assert_valid(inp: ReportInput, report: dict[str, Any]) -> None:
    Report.model_validate(report)
    assert model_errors(run_with_report(inp, report)) == []


def _errors(output: Any, inp: ReportInput | None = None) -> list[str]:
    inp = inp or make_input()
    text = output if isinstance(output, str) else json.dumps(output)
    content, errors = validate_output(text, build_report_prompt(inp, compute_stats(inp)))
    assert (content is None) == bool(errors)
    return errors


def test_happy_path() -> None:
    inp = make_input()
    client = FakeClient([valid_output()])
    result = build_report(inp, client)
    assert result.llm_used and result.notes == []
    report = result.report
    assert report == {
        "summary": valid_output()["summary"].replace("panic_seller", "panic seller"),  # words, not ids
        "turningPoint": {"round": 3, "why": "The injected rumor preceded two exits (p4, c5)."},
        "sentimentByRound": SENTIMENT,
        "objections": ["The 5% creator tax drew doubts (c2)."],
        "priceDrivers": ["Round 3 exits by a03 and a01 moved the price down."],
        "disclaimer": DISCLAIMER,
        "flags": [],
    }
    [call] = client.calls
    assert call["purpose"] == "report" and call["json_mode"] is True
    assert call["temperature"] == 0.3 and call["max_tokens"] == 2000
    assert find_protocol(call["messages"]) == "report/v1"
    _assert_valid(inp, report)


def test_model_cannot_set_the_disclaimer_sentiment_or_flags() -> None:
    output = valid_output(disclaimer="Not financial advice.", sentimentByRound=[1, 1, 1, 1], flags=["x"])
    report = build_report(make_input(), FakeClient([output])).report
    assert report["disclaimer"] == DISCLAIMER
    assert report["sentimentByRound"] == SENTIMENT and report["flags"] == []


def test_think_blocks_and_code_fences_are_accepted() -> None:
    text = "<think>scratch work</think>\n```json\n" + json.dumps(valid_output()) + "\n```"
    assert build_report(make_input(), FakeClient([text])).llm_used


def test_citations_are_not_repeated_and_go_before_the_period() -> None:
    output = valid_output(
        turningPoint={"round": 3, "why": "The rumor came first, see p4.", "evidencePostIds": ["p4", "c5"]},
        objections=[{"text": "Doubts about the tax", "evidencePostIds": ["c2"]},
                    {"text": "No evidence listed."}],
    )
    report = build_report(make_input(), FakeClient([output])).report
    assert report["turningPoint"]["why"] == "The rumor came first, see p4 (c5)."
    assert report["objections"] == ["Doubts about the tax (c2)", "No evidence listed."]


def test_invalid_json_gets_one_retry_with_feedback() -> None:
    client = FakeClient(["not json at all", valid_output()])
    result = build_report(make_input(), client)
    assert result.llm_used and len(client.calls) == 2
    first, retry = client.calls[0]["messages"], client.calls[1]["messages"]
    assert retry[:2] == first
    assert retry[2] == ChatMessage(role="assistant", content="not json at all")
    assert retry[3].role == "user" and "not accepted" in retry[3].content
    assert "LLM returned invalid JSON" in retry[3].content
    assert [n.split(":")[0] for n in result.notes] == ["attempt 1 rejected"]


def test_invalid_output_twice_falls_back_to_the_template() -> None:
    inp = make_input()
    wrong_round = valid_output(turningPoint={"round": 4, "why": "Quiet.", "evidencePostIds": []})
    client = FakeClient(["nope", wrong_round])
    result = build_report(inp, client)
    assert not result.llm_used and len(client.calls) == 2
    assert "attempt 2 rejected: turningPoint.round must be a candidate round (1, 2, 3)" in result.notes
    assert result.notes[-1] == "model output unusable after one retry: template report"
    report = result.report
    assert report["summary"].startswith("A synthetic crowd of 4 agents reacted over 4 rounds.")
    assert report["turningPoint"]["round"] == 3
    assert report["turningPoint"]["why"].endswith("Most-liked posts that round: p4, c5.")
    assert report["objections"] == [
        'Panic seller a03 in round 3: "Dev wallet dumped, I am out." (p4)',
        'Skeptic a04 in round 3: "Told you, the tax was a red flag." (c5)',
    ]
    assert report["sentimentByRound"] == SENTIMENT and report["disclaimer"] == DISCLAIMER
    _assert_valid(inp, report)


def test_request_error_resends_the_same_request() -> None:
    client = FakeClient([LLMRequestError("HTTP 503 from the provider", status_code=503), valid_output()])
    result = build_report(make_input(), client)
    assert result.llm_used
    assert client.calls[1]["messages"] == client.calls[0]["messages"]
    assert result.notes == ["attempt 1 failed: LLMRequestError: HTTP 503 from the provider"]


def test_response_error_retries_with_feedback_only() -> None:
    error = LLMResponseError("output was truncated", finish_reason="length")
    client = FakeClient([error, valid_output()])
    assert build_report(make_input(), client).llm_used
    retry = client.calls[1]["messages"]
    assert [m.role for m in retry] == ["system", "user", "user"]
    assert "output was truncated" in retry[2].content


def test_two_failed_requests_fall_back_to_the_template() -> None:
    client = FakeClient([LLMRequestError("down"), LLMRequestError("down")])
    result = build_report(make_input(), client)
    assert not result.llm_used and result.report["objections"]
    assert result.notes[-1] == "model output unusable after one retry: template report"


@pytest.mark.parametrize("reason", ["max_cost_usd", "max_llm_calls"])
def test_budget_exceeded_gives_a_stats_only_report(reason: str) -> None:
    inp = make_input()
    client = FakeClient([BudgetExceeded(reason, "report")])  # type: ignore[arg-type]
    result = build_report(inp, client)
    assert not result.llm_used and len(client.calls) == 1
    assert result.notes == [f"budget exhausted ({reason}): stats-only report"]
    report = result.report
    assert report["summary"].endswith("This report was generated from run statistics only.")
    assert report["objections"] == []
    assert report["turningPoint"] == {
        "round": 3,
        "why": "Round 3 showed the largest combined change: the price moved -30.56%, mean sentiment "
        'changed by -0.60, net flow changed direction, an event was injected ("Rumor: the dev wallet '
        'sold 20%").',
    }
    assert report["priceDrivers"][0].startswith("Round 1: a01 (sniper) spent 0.1 ETH on 90.7K tokens")
    assert report["sentimentByRound"] == SENTIMENT
    _assert_valid(inp, report)


def test_budget_exceeded_on_the_retry_gives_a_stats_only_report() -> None:
    client = FakeClient(["nope", BudgetExceeded("max_llm_calls", "report")])
    result = build_report(make_input(), client)
    assert not result.llm_used and result.report["objections"] == []
    assert result.notes[-1] == "budget exhausted (max_llm_calls): stats-only report"


def test_partial_run() -> None:
    inp = make_input(status="partial", stop_reason="max_llm_calls")
    client = FakeClient([BudgetExceeded("max_llm_calls", "report")])
    report = build_report(inp, client).report
    assert "Run status: partial (stopped early: max_llm_calls)" in client.calls[0]["messages"][1].content
    assert "The run stopped early (max_llm_calls)." in report["summary"]
    _assert_valid(inp, report)


def test_run_without_rounds_needs_no_model() -> None:
    inp = make_input(rounds=[])
    client = FakeClient([])
    result = build_report(inp, client)
    assert client.calls == [] and not result.llm_used
    assert result.report["summary"] == NO_ROUNDS_SUMMARY
    assert result.report["turningPoint"] is None and result.report["sentimentByRound"] == []
    _assert_valid(inp, result.report)


def test_single_round_run() -> None:
    inp = make_input(rounds=make_input().rounds[:1])
    report = build_report(inp, FakeClient([BudgetExceeded("max_cost_usd", "report")])).report
    assert "reacted over 1 round." in report["summary"]
    assert "Mean sentiment was +0.15 in round 1." in report["summary"]
    _assert_valid(inp, report)


def test_guard_runs_on_the_model_output() -> None:
    output = valid_output(priceDrivers=["Holders should sell before round 3."])
    rewrite = {"fields": {"priceDrivers.0": "Holder agents described exits before round 3."}}
    client = FakeClient([output, rewrite])
    result = build_report(make_input(), client)
    assert result.llm_used
    assert result.report["priceDrivers"] == ["Holder agents described exits before round 3."]
    assert result.report["flags"] == ["rewritten:advice_modal"]
    rewrite_call = client.calls[1]
    assert find_protocol(rewrite_call["messages"]) == "report_rewrite/v1"
    assert rewrite_call["purpose"] == "report"


def test_guard_runs_on_the_template_fallback() -> None:
    inp = make_input()
    trace = inp.rounds[2]
    posts = [post | {"text": "This is a bad token, sell now."} if post["id"] == "c5" else post
             for post in trace.posts]
    inp = make_input(rounds=[*inp.rounds[:2], RoundTrace(**{**trace.__dict__, "posts": posts}), inp.rounds[3]])
    client = FakeClient(["nope", "nope", LLMRequestError("down")])
    result = build_report(inp, client)
    assert len(client.calls) == 3 and find_protocol(client.calls[2]["messages"]) == "report_rewrite/v1"
    assert result.report["objections"] == [
        'Panic seller a03 in round 3: "Dev wallet dumped, I am out." (p4)'
    ]
    assert result.report["flags"] == ["redacted:bad_token", "redacted:advice_noun"]
    _assert_valid(inp, result.report)


INVALID_OUTPUTS: list[tuple[str, Any, str]] = [
    ("not a candidate round", valid_output(turningPoint={"round": 4, "why": "x"}),
     "turningPoint.round must be a candidate round (1, 2, 3)"),
    ("round as string", valid_output(turningPoint={"round": "3", "why": "x"}), "must be a candidate"),
    ("round as bool", valid_output(turningPoint={"round": True, "why": "x"}), "must be a candidate"),
    ("missing turning point", {k: v for k, v in valid_output().items() if k != "turningPoint"},
     "turningPoint is required"),
    ("turning point as text", valid_output(turningPoint="round 3"), "must be an object or null"),
    ("empty why", valid_output(turningPoint={"round": 3, "why": " "}), "turningPoint.why must be"),
    ("unknown evidence id", valid_output(objections=[{"text": "x", "evidencePostIds": ["p99"]}]),
     "cites posts that were not listed: p99"),
    ("too many evidence ids",
     valid_output(turningPoint={"round": 3, "why": "x", "evidencePostIds": ["p1", "c2", "p3", "p4", "c5", "p6"]}),
     "has more than 5 ids"),
    ("evidence ids not strings", valid_output(objections=[{"text": "x", "evidencePostIds": [4]}]),
     "must be a list of post ids"),
    ("empty summary", valid_output(summary=""), "summary must be a non-empty string"),
    ("summary not a string", valid_output(summary=["a"]), "summary must be a non-empty string"),
    ("summary too long", valid_output(summary="word " * 400), "summary is longer than 1500"),
    ("why too long", valid_output(turningPoint={"round": 3, "why": "x" * 801}), "longer than 800"),
    ("too many objections", valid_output(objections=[{"text": "x"}] * 6), "more than 5 items"),
    ("objection as text", valid_output(objections=["x"]), "must be an object with text"),
    ("objections missing", {k: v for k, v in valid_output().items() if k != "objections"},
     "objections must be a list"),
    ("too many price drivers", valid_output(priceDrivers=["x"] * 6), "more than 5 items"),
    ("price drivers as text", valid_output(priceDrivers="x"), "priceDrivers must be a list"),
    ("price driver too long", valid_output(priceDrivers=["x" * 401]), "priceDrivers[0] is longer than 400"),
    ("mentions a missing round", valid_output(summary="Exits peaked in round 9."),
     "mentions rounds that do not exist: 9"),
    ("mentions an unlisted post", valid_output(priceDrivers=["As p77 said, exits."]),
     "mentions posts that were not listed: p77"),
    ("top-level array", "[1, 2]", "top-level JSON object"),
    ("two objects", json.dumps(valid_output()) + ' {"a": 1}', "multiple JSON values"),
    ("non-finite number", '{"summary": NaN}', "non-finite"),
    ("empty answer", "", "empty"),
]


@pytest.mark.parametrize(
    ("output", "expected"), [c[1:] for c in INVALID_OUTPUTS], ids=[c[0] for c in INVALID_OUTPUTS]
)
def test_invalid_outputs_are_rejected(output: Any, expected: str) -> None:
    errors = _errors(output)
    assert any(expected in error for error in errors), errors


VALID_OUTPUTS: list[tuple[str, Any]] = [
    ("as given", valid_output()),
    ("null turning point", valid_output(turningPoint=None)),
    ("no evidence ids", valid_output(turningPoint={"round": 2, "why": "Holders added ETH."})),
    ("no objections or drivers", valid_output(objections=[], priceDrivers=[])),
    ("duplicate evidence ids", valid_output(objections=[{"text": "x", "evidencePostIds": ["c2", "c2"]}])),
    ("trailing prose", json.dumps(valid_output()) + "\nThat is the report."),
]


@pytest.mark.parametrize("output", [c[1] for c in VALID_OUTPUTS], ids=[c[0] for c in VALID_OUTPUTS])
def test_valid_outputs_are_accepted(output: Any) -> None:
    assert _errors(output) == []


def test_mentions_inside_quoted_data_are_accepted() -> None:
    inp = make_input()
    trace = inp.rounds[0]
    posts = [trace.posts[0] | {"text": "By round 20 this is over, ask p77."}, *trace.posts[1:]]
    inp = make_input(rounds=[RoundTrace(**{**trace.__dict__, "posts": posts}), *inp.rounds[1:]])
    quoted = valid_output(summary='One agent wrote "By round 20 this is over, ask p77." (p1)')
    assert _errors(quoted, inp) == []
    assert _errors(valid_output(summary="Exits came in round 21."), inp) != []


def test_turning_point_must_be_null_without_candidates() -> None:
    flat = make_input(rounds=[RoundTrace(n=1, market_after=make_input().initial_market)])
    assert any("none (use null)" in e for e in _errors(valid_output(), flat))
    assert _errors(valid_output(turningPoint=None, objections=[], priceDrivers=[],
                                summary="The crowd stayed flat in round 1."), flat) == []
