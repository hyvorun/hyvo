"""Offline responders: deterministic, network-free report and rewrite answers."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from hyvo.llm.budget import BudgetMeter
from hyvo.llm.log import LLMLog
from hyvo.llm.metered import MeteredClient
from hyvo.llm.offline import OfflineClient
from hyvo.report import build_report, guard_report
from hyvo.report.prompt import build_report_prompt
from hyvo.report.stats import compute_stats
from hyvo.report.template import deterministic_content
from hyvo.report.types import RoundTrace
from hyvo.runfile import DISCLAIMER, Report, model_errors, validate_json_schema

from .samples import make_input, run_with_report

SCHEMA_FILE = Path(__file__).resolve().parents[3] / "packages" / "schema" / "run.schema.json"


def test_offline_report_answer_is_the_template() -> None:
    inp = make_input()
    prompt = build_report_prompt(inp, compute_stats(inp))
    result = OfflineClient(seed=1).complete(
        prompt.messages, temperature=0.3, max_tokens=2000, json_mode=True, purpose="report"
    )
    assert json.loads(result.text) == deterministic_content(prompt.data, include_posts=True)
    assert result.cost_usd == 0.0 and result.model == "offline/rules-v1"


def test_offline_report_is_deterministic_and_valid() -> None:
    inp = make_input()
    first = build_report(inp, OfflineClient(seed=1))
    second = build_report(inp, OfflineClient(seed=99))
    assert first == second
    assert first.llm_used and first.notes == []
    report = first.report
    assert report["disclaimer"] == DISCLAIMER and report["flags"] == []
    assert report["turningPoint"]["round"] == 3 and len(report["objections"]) == 2
    Report.model_validate(report)
    assert model_errors(run_with_report(inp, report)) == []


def test_offline_answers_stay_within_the_output_contract() -> None:
    """Long event and post texts must not push the template past the limits validation enforces."""
    inp = make_input()
    trace = inp.rounds[2]
    events = [f"Rumor {i} says round 20 matters. " + "word " * 95 for i in range(3)]
    posts = [post | {"text": "p99 said round 30. " + "long " * 200} for post in trace.posts]
    traces = [*inp.rounds[:2], RoundTrace(**{**trace.__dict__, "injected_events": events, "posts": posts}),
              inp.rounds[3]]
    result = build_report(make_input(rounds=traces), OfflineClient(seed=1))
    assert result.llm_used and result.notes == []
    assert len(result.report["turningPoint"]["why"]) <= 800
    assert all(len(text) <= 400 for text in result.report["objections"])


def test_offline_run_passes_the_json_schema(monkeypatch: pytest.MonkeyPatch) -> None:
    if not SCHEMA_FILE.is_file():
        pytest.skip(f"{SCHEMA_FILE} is missing; it is produced by packages/schema")
    monkeypatch.delenv("HYVO_RUN_SCHEMA", raising=False)
    inp = make_input()
    run = run_with_report(inp, build_report(inp, OfflineClient(seed=1)).report)
    assert validate_json_schema(run) == []


def test_offline_rewrite_drops_banned_sentences() -> None:
    report = {
        "summary": "The crowd added ETH early. You should buy now.",
        "turningPoint": {"round": 1, "why": "It will moon."},
        "sentimentByRound": [0.1],
        "objections": ["The tax drew doubts (c2)."],
        "priceDrivers": [],
        "disclaimer": DISCLAIMER,
        "flags": [],
    }
    guarded = guard_report(report, OfflineClient(seed=5))
    assert guarded["summary"] == "The crowd added ETH early."
    assert guarded["turningPoint"]["why"] == "[Removed by the copy guard.]"
    assert guarded["flags"] == ["rewritten:advice_modal", "rewritten:advice_noun", "redacted:will_pump"]
    assert guard_report(report, OfflineClient(seed=6)) == guarded


def test_offline_report_through_the_metered_client(tmp_path: Path) -> None:
    inp = make_input()
    meter = BudgetMeter(max_cost_usd=0.5, max_llm_calls=10)
    client = MeteredClient(OfflineClient(seed=1), meter, LLMLog(tmp_path / "llm-log.jsonl"))
    result = build_report(inp, client)
    assert result.llm_used
    assert meter.usage()["llmCalls"] == 1 and meter.usage()["costUsd"] == 0.0
    [line] = (tmp_path / "llm-log.jsonl").read_text(encoding="utf-8").splitlines()
    assert json.loads(line)["purpose"] == "report"


def test_an_exhausted_budget_gives_a_stats_only_report(tmp_path: Path) -> None:
    inp = make_input()
    meter = BudgetMeter(max_cost_usd=0.0, max_llm_calls=0, report_reserve_calls=0)
    client = MeteredClient(OfflineClient(seed=1), meter, LLMLog(tmp_path / "llm-log.jsonl"))
    result = build_report(inp, client)
    assert not result.llm_used
    assert result.notes == ["budget exhausted (max_llm_calls): stats-only report"]
    assert result.report["objections"] == []
    assert model_errors(run_with_report(inp, result.report)) == []
