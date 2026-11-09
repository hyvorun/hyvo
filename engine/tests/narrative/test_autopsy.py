"""Autopsy: a move past the threshold becomes a scenario from what was known before it."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, timedelta
from pathlib import Path

import pytest

from hyvo.narrative.autopsy import build_autopsy, find_move
from hyvo.narrative.graph import NarrativeGraph
from hyvo.narrative.seedpack import NarrativeSettings
from hyvo.narrative.signals import Signal
from hyvo.report.guard import find_violations
from hyvo.scenarios import load_scenario_file

from .samples import NOW, ReadingClient, news_signal, pool_signal

DAY = date(2026, 11, 6)


@pytest.fixture
def settings(tmp_path: Path) -> NarrativeSettings:
    return NarrativeSettings(folder=tmp_path / "narrative", feeds=())


def history() -> list[Signal]:
    return [
        pool_signal("FIZZ", kind="launch", at=NOW - timedelta(hours=40)),
        pool_signal("FIZZ", at=NOW - timedelta(hours=20), change=5.0, volume=9_000),
        news_signal("FIZZ talk grows", "FIZZ", at=NOW - timedelta(hours=18)),
        pool_signal("FIZZ", at=NOW, change=180.0, volume=500_000),
    ]


def build(settings: NarrativeSettings, signals: Sequence[Signal] | None = None, client: ReadingClient | None = None) -> Path | None:
    return build_autopsy(settings, DAY, client=client, log=lambda _: None, now=lambda: NOW, fetch_signals=lambda graph, moment: history() if signals is None else signals)


def test_a_tracked_token_past_the_threshold_gets_a_scenario_from_before_its_move(settings: NarrativeSettings) -> None:
    path = build(settings)
    assert path is not None
    scenario = load_scenario_file(path)
    assert "FIZZ moved +180.0%" in scenario.title
    events = [event.text for event in scenario.injected_events]
    assert any("opened a pool" in text for text in events)
    assert any("+5.0%" in text for text in events)
    assert any("FIZZ talk grows" in text for text in events)
    assert not any("+180.0%" in text for text in events), "the crowd does not learn the move itself"


def test_it_says_what_it_does_not_know(settings: NarrativeSettings) -> None:
    scenario = load_scenario_file(build(settings))  # type: ignore[arg-type]
    assert "It does not say why the real price moved" in scenario.seed_text
    assert "This is a simulation" in scenario.seed_text
    for text in (scenario.title, scenario.seed_text, *(event.text for event in scenario.injected_events)):
        assert find_violations(text) == []


def test_the_test_market_opens_at_the_price_before_the_move(settings: NarrativeSettings) -> None:
    scenario = load_scenario_file(build(settings))  # type: ignore[arg-type]
    market = scenario.market
    assert market is not None and market.liquidity_tokens is not None and market.liquidity_eth is not None
    price_usd = float(market.liquidity_eth) * 3000.0 / float(market.liquidity_tokens)
    assert price_usd == pytest.approx(0.000012 / 2.8, rel=1e-3)


def test_a_small_move_is_not_news(settings: NarrativeSettings) -> None:
    signals = [pool_signal("FIZZ", kind="launch", at=NOW - timedelta(hours=40)), pool_signal("FIZZ", at=NOW, change=30.0)]
    assert build(settings, signals) is None


def test_a_token_first_seen_today_is_not_tracked(settings: NarrativeSettings) -> None:
    assert build(settings, [pool_signal("NEW", at=NOW, change=500.0)]) is None


def test_the_threshold_works_downward_too(settings: NarrativeSettings) -> None:
    signals = [pool_signal("FIZZ", kind="launch", at=NOW - timedelta(hours=40)), pool_signal("FIZZ", at=NOW, change=-70.0)]
    path = build(settings, signals)
    assert path is not None and "-70.0%" in load_scenario_file(path).title


def test_the_largest_move_wins(tmp_path: Path) -> None:
    with NarrativeGraph(tmp_path / "g.sqlite") as graph:
        graph.add(
            [
                pool_signal("AAA", at=NOW - timedelta(hours=20), change=1.0),
                pool_signal("BBB", at=NOW - timedelta(hours=20), change=1.0),
                pool_signal("AAA", at=NOW, change=60.0),
                pool_signal("BBB", at=NOW, change=-90.0),
                pool_signal("WETH", at=NOW - timedelta(hours=20), change=1.0),
                pool_signal("WETH", at=NOW, change=-99.0),
                pool_signal("BONER", at=NOW - timedelta(hours=20), change=1.0),
                pool_signal("BONER", at=NOW, change=-99.0),
                pool_signal("TINY", at=NOW - timedelta(hours=20), change=1.0),
                pool_signal("TINY", at=NOW, change=-99.0, reserve=10),
            ],
            NOW,
        )
        move = find_move(graph, 50.0, NOW)
        assert move is not None and move.refs["symbol"] == "BBB"


@pytest.mark.parametrize("symbol", ["HYVO", "HYV0", "WHYVO", "HYVOAI"])
def test_hyvos_own_token_and_its_lookalikes_are_never_autopsied(settings: NarrativeSettings, symbol: str) -> None:
    signals = [
        pool_signal(symbol, kind="launch", at=NOW - timedelta(hours=40)),
        pool_signal(symbol, at=NOW - timedelta(hours=20), change=5.0, volume=9_000),
        pool_signal(symbol, at=NOW, change=400.0, volume=900_000),
    ]
    assert build(settings, signals) is None


def test_a_headline_naming_hyvo_stays_out_of_another_tokens_autopsy(settings: NarrativeSettings) -> None:
    path = build(settings, [*history(), news_signal("FIZZ and HYVO both rally", "FIZZ", at=NOW - timedelta(hours=10))])
    assert path is not None
    text = path.read_text(encoding="utf-8")
    assert "HYVO" not in text and "FIZZ talk grows" in text


def test_a_token_is_not_autopsied_again_within_a_week(settings: NarrativeSettings) -> None:
    assert build(settings) is not None
    with NarrativeGraph(settings.graph_path) as graph:
        assert find_move(graph, 50.0, NOW) is None
        assert find_move(graph, 50.0, NOW + timedelta(days=8)) is None, "the move itself is over a day old by then"


def test_a_restart_reuses_the_days_scenario(settings: NarrativeSettings) -> None:
    first = build(settings)
    assert first is not None
    text = first.read_text(encoding="utf-8")
    assert build(settings, signals=[]) == first
    assert first.read_text(encoding="utf-8") == text


def test_the_report_model_reads_it_too(settings: NarrativeSettings) -> None:
    client = ReadingClient("talk grows")
    path = build(settings, client=client)
    assert path is not None and client.calls == 1
    assert "talk grows" not in path.read_text(encoding="utf-8")


def test_nothing_goes_out_when_the_token_is_refused(settings: NarrativeSettings) -> None:
    assert build(settings, client=ReadingClient("FIZZ moved")) is None
