"""The day's seed pack: real shapes in, a playable scenario out, and nothing unread goes through."""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import date, timedelta
from pathlib import Path

import pytest

from hyvo.narrative.graph import NarrativeGraph
from hyvo.narrative.seedpack import (
    NarrativeSettings,
    SeedPack,
    build_seed_pack,
    candidates,
    eth_price,
    market_for,
    not_a_story,
    passes_for_hyvo,
)
from hyvo.narrative.signals import Signal
from hyvo.report.guard import find_violations
from hyvo.scenarios import ScenarioError, load_scenario_file, parse_scenario_markdown

from .samples import NOW, ReadingClient, news_signal, pool_signal

DAY = date(2026, 11, 6)


@pytest.fixture
def settings(tmp_path: Path) -> NarrativeSettings:
    return NarrativeSettings(folder=tmp_path / "narrative", feeds=())


def day_signals() -> list[Signal]:
    return [
        pool_signal("FIZZ", volume=50_000),
        pool_signal("SOLE", dex="uniswap-v4-robinhood", volume=60_000),
        pool_signal("NVDA", age_hours=24 * 90, volume=5_000_000, change=-9.1, fdv=900_000_000, quote="USDG"),
        news_signal("Robinhood volume doubled on tokenized stocks", "Robinhood", "Tokenized stocks"),
        news_signal("Bitcoin slid as AI stocks fell", "Bitcoin", "AI"),
        news_signal("Lawmakers take up a stablecoin bill", "Stablecoins", "Regulation"),
    ]


def build(settings: NarrativeSettings, signals: Sequence[Signal] | None = None, client: ReadingClient | None = None, day: date = DAY, swap: float | None = 1234.0) -> SeedPack | None:
    return build_seed_pack(
        settings,
        day,
        client=client,
        log=lambda _: None,
        now=lambda: NOW,
        fetch_signals=lambda graph, moment: day_signals() if signals is None else signals,
        swap_of=lambda pool: swap,
    )


def test_a_pack_becomes_a_scenario_the_engine_can_play(settings: NarrativeSettings) -> None:
    pack = build(settings)
    assert pack is not None and pack.symbol == "FIZZ", "a Pons launch counts double"
    scenario = load_scenario_file(pack.path)
    assert scenario.title.startswith("How a synthetic crowd reacts to FIZZ")
    assert "This is a simulation" in scenario.seed_text and "Nothing here touches the real pool" in scenario.seed_text
    assert "about $60 thousand" in scenario.seed_text and "+40.0%" in scenario.seed_text
    assert scenario.market is not None and scenario.market.token_symbol == "FIZZ"
    assert [event.round for event in scenario.injected_events] == [3, 5, 8]
    assert "$1,234" in scenario.injected_events[0].text


def test_the_scenario_breaks_no_copy_rule_and_says_where_it_came_from(settings: NarrativeSettings) -> None:
    pack = build(settings)
    assert pack is not None
    scenario = load_scenario_file(pack.path)
    for text in (scenario.title, scenario.seed_text, *(event.text for event in scenario.injected_events)):
        assert find_violations(text) == []
    kinds = [source.kind for source in scenario.seed_sources]
    assert kinds[0] == "url" and "onchain" in kinds
    assert any(source.ref.startswith("robinhood:0x") for source in scenario.seed_sources)
    assert any("news.example" in source.ref for source in scenario.seed_sources)


def test_a_days_pack_is_written_once_and_a_restart_reuses_it(settings: NarrativeSettings) -> None:
    first = build(settings)
    assert first is not None
    text = first.path.read_text(encoding="utf-8")
    calls = {"n": 0}

    def must_not_fetch(graph: NarrativeGraph, moment: object) -> list[Signal]:
        calls["n"] += 1
        return []

    again = build_seed_pack(settings, DAY, client=None, log=lambda _: None, now=lambda: NOW, fetch_signals=must_not_fetch, swap_of=lambda p: None)
    assert again is not None and again.symbol == "FIZZ" and again.path.read_text(encoding="utf-8") == text
    assert calls["n"] == 0
    assert json.loads((first.path.parent / "pack.json").read_text(encoding="utf-8"))["symbol"] == "FIZZ"


def test_the_next_day_moves_on_to_another_token(settings: NarrativeSettings) -> None:
    assert build(settings).symbol == "FIZZ"  # type: ignore[union-attr]
    next_day = build(settings, day=DAY + timedelta(days=1))
    assert next_day is not None and next_day.symbol == "SOLE"


def test_a_thin_day_gives_nothing(settings: NarrativeSettings) -> None:
    assert build(settings, signals=[news_signal("Only news", "Bitcoin")]) is None
    assert not (settings.folder / "packs" / DAY.isoformat()).exists()


@pytest.mark.parametrize(
    "bad",
    [
        pool_signal("Anthropic"),  # a mixed-case name: the world could not carry it anyway
        pool_signal("WETH"),
        pool_signal("USDG"),
        pool_signal("BONERCOIN"),
        pool_signal("X"),
        pool_signal("TINY", reserve=500),
        pool_signal("QUIET", volume=10),
        pool_signal("HUGE", fdv=900_000_000),
        pool_signal("AGED", age_hours=24 * 30),
    ],
    ids=lambda signal: signal.refs["symbol"],
)
def test_what_cannot_carry_the_day(bad: Signal) -> None:
    assert candidates([bad], set(), NOW) == []


@pytest.mark.parametrize("symbol", ["HYVO", "HYV0", "HYYVO", "HYVOO", "WHYVO", "HYVOAI", "BABYHYVO", "HYVO2"])
def test_hyvos_own_token_and_its_lookalikes_never_carry_the_day(symbol: str) -> None:
    # The busiest Pons launch of the day, and still not a subject: a public run of Hyvo's about it would be Hyvo's word on it.
    assert candidates([pool_signal(symbol, volume=5_000_000)], set(), NOW) == []
    assert not_a_story(symbol)


@pytest.mark.parametrize("symbol", ["FIZZ", "HIVE", "HYPE", "VOLT", "SHY", "OVHY"])
def test_a_symbol_that_only_shares_letters_with_hyvo_is_fine(symbol: str) -> None:
    assert not not_a_story(symbol)
    assert [signal.refs["symbol"] for signal in candidates([pool_signal(symbol)], set(), NOW)] == [symbol]


def test_hyvo_is_not_in_the_pack_even_as_a_move_elsewhere_a_topic_or_a_headline(settings: NarrativeSettings) -> None:
    signals = [
        *day_signals(),
        pool_signal("HYVO", volume=9_000_000, change=300.0),
        pool_signal("HYV0", volume=8_000_000, change=-80.0),
        news_signal("$HYVO lists on Robinhood Chain", "Robinhood", "HYVO", at=NOW - timedelta(minutes=5)),
        news_signal("Hyvo token draws a crowd on Robinhood", "Robinhood", at=NOW - timedelta(minutes=4)),
    ]
    pack = build(settings, signals=signals)
    assert pack is not None and pack.symbol == "FIZZ"
    text = pack.path.read_text(encoding="utf-8")
    assert not passes_for_hyvo(text), text
    assert "Robinhood volume doubled" in text, "the other headlines still go in"


def test_a_recently_used_token_is_passed_over() -> None:
    assert candidates([pool_signal("FIZZ")], {"FIZZ"}, NOW) == []


def test_the_newest_sighting_of_a_token_decides() -> None:
    old_and_quiet = pool_signal("FIZZ", at=NOW - timedelta(hours=8), volume=2_000_000)
    now_and_small = pool_signal("FIZZ", at=NOW, volume=2_000)
    other = pool_signal("SOLE", dex="uniswap-v4-robinhood", volume=50_000)
    [first, second] = candidates([old_and_quiet, now_and_small, other], set(), NOW)
    assert first.refs["symbol"] == "SOLE" and second.numbers["volumeH24"] == 2_000


def test_the_report_model_reads_each_line_and_what_it_flags_stays_out(settings: NarrativeSettings) -> None:
    client = ReadingClient("doubled")
    pack = build(settings, client=client)
    assert pack is not None and client.calls == 1
    text = pack.path.read_text(encoding="utf-8")
    assert "doubled" not in text
    assert "Bitcoin slid" in text
    # Its source goes too: a flagged headline leaves no trace in the run.
    scenario = load_scenario_file(pack.path)
    assert len([source for source in scenario.seed_sources if source.kind == "url"]) == 1 + len(json.loads((pack.path.parent / "pack.json").read_text(encoding="utf-8"))["headlines"])


def test_a_token_the_model_objects_to_is_passed_over_for_the_next(settings: NarrativeSettings) -> None:
    pack = build(settings, client=ReadingClient("FIZZ on Robinhood Chain"))
    assert pack is not None and pack.symbol == "SOLE"


def test_when_every_token_is_refused_there_is_no_pack(settings: NarrativeSettings) -> None:
    assert build(settings, client=ReadingClient("Robinhood Chain")) is None


def test_a_model_that_cannot_read_stops_the_pack_rather_than_letting_it_through_unread(settings: NarrativeSettings) -> None:
    with pytest.raises(ScenarioError, match="could not read"):
        build(settings, client=ReadingClient(fail=True))
    assert not (settings.folder / "packs" / DAY.isoformat() / "scenario.md").exists()


@pytest.mark.parametrize(
    "headline",
    [
        "Robinhood chief says tokenized stocks are the future",
        "Robinhood sued over memecoin listings",
        "Founder accused of draining a Robinhood pool",
        "Robinhood volume drops, analyst warns",
    ],
)
def test_a_headline_about_what_someone_said_or_did_stays_out_without_any_model(settings: NarrativeSettings, headline: str) -> None:
    pack = build(settings, signals=[*day_signals(), news_signal(headline, "Robinhood", at=NOW - timedelta(minutes=5))])
    assert pack is not None
    assert headline not in pack.path.read_text(encoding="utf-8")


def test_a_headline_that_breaks_the_copy_rules_never_gets_in(settings: NarrativeSettings) -> None:
    signals = [*day_signals(), news_signal("Robinhood token will moon, analysts say", "Robinhood", at=NOW - timedelta(minutes=5))]
    pack = build(settings, signals=signals)
    assert pack is not None
    assert "moon" not in pack.path.read_text(encoding="utf-8")


def test_the_test_market_keeps_the_tokens_price_in_a_thinner_pool() -> None:
    signal = pool_signal("FIZZ", reserve=600_000)
    market = market_for(signal, eth_usd=3000.0)
    assert market["token_symbol"] == "FIZZ" and market["fee_bps"] == "100"
    assert market["liquidity_eth"] == "25.00", "a crowd this size could not move the real depth"
    price = float(market["liquidity_eth"]) * 3000.0 / float(market["liquidity_tokens"])
    assert price == pytest.approx(0.000012, rel=1e-3)
    thin = market_for(pool_signal("FIZZ", reserve=3_000), eth_usd=3000.0)
    assert thin["liquidity_eth"] == "2.00"


def test_the_market_works_without_a_price() -> None:
    assert market_for(pool_signal("FIZZ"), eth_usd=None)["liquidity_eth"] == "5"


def test_the_pools_fee_is_used_when_it_is_named() -> None:
    assert market_for(pool_signal("FIZZ", feePct=0.3), eth_usd=3000.0)["fee_bps"] == "30"


def test_eth_is_priced_from_the_deepest_weth_pool() -> None:
    shallow = pool_signal("A", reserve=1_000, quoteUsd=1.0)
    deep = pool_signal("B", reserve=9_000_000, quoteUsd=3000.0)
    usdg = pool_signal("C", reserve=90_000_000, quote="USDG", quoteUsd=1.0)
    assert eth_price([shallow, deep, usdg]) == 3000.0
    assert eth_price([usdg]) is None


def test_a_scenario_file_can_name_its_sources() -> None:
    text = "---\ntitle: T\nsources: url https://a.example/x | onchain robinhood:0xabc\n---\n\nSeed.\n"
    scenario = parse_scenario_markdown(text, ref="f.md")
    assert [(source.kind, source.ref) for source in scenario.seed_sources] == [("url", "https://a.example/x"), ("onchain", "robinhood:0xabc")]
    assert parse_scenario_markdown("---\ntitle: T\n---\n\nSeed.\n", ref="f.md").seed_sources[0].ref == "f.md"


@pytest.mark.parametrize("line", ["sources: ftp://x", "sources: url ftp://x", "sources: user me", f"sources: url https://{'x' * 300}"])
def test_a_bad_source_is_refused(line: str) -> None:
    with pytest.raises(ScenarioError):
        parse_scenario_markdown(f"---\ntitle: T\n{line}\n---\n\nSeed.\n")


@pytest.mark.anvil
@pytest.mark.slow
def test_a_seed_pack_plays_for_real_and_the_run_records_its_sources(settings: NarrativeSettings, tmp_path: Path) -> None:
    from typer.testing import CliRunner

    from hyvo.cli import app
    from hyvo.runfile import load_run

    pack = build(settings)
    assert pack is not None
    out = tmp_path / "runs"
    result = CliRunner().invoke(app, ["run", "--scenario", str(pack.path), "--agents", "10", "--rounds", "9", "--offline", "--no-fork", "--seed", "4", "--out", str(out), "--quiet"])
    assert result.exit_code == 0, result.output
    [path] = out.glob("*/run.json")
    run = load_run(path)
    assert run["world"]["token"]["symbol"] == "FIZZ"
    assert any(source["kind"] == "onchain" for source in run["scenario"]["seedSources"])


def test_the_largest_swap_is_read_from_the_pool_and_its_failure_is_only_logged(monkeypatch: pytest.MonkeyPatch) -> None:
    from hyvo.narrative import seedpack

    monkeypatch.setattr(seedpack.pools, "largest_swap_usd", lambda http, pool: 777.0)
    assert seedpack._largest_swap(pool_signal("FIZZ"), None, lambda _: None) == 777.0

    def refused(http: object, pool: str) -> float:
        raise seedpack.SourceError("429")

    monkeypatch.setattr(seedpack.pools, "largest_swap_usd", refused)
    lines: list[str] = []
    assert seedpack._largest_swap(pool_signal("FIZZ"), None, lines.append) is None
    assert any("largest swap" in line for line in lines)
