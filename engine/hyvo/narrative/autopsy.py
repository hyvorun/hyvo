"""Autopsy (SPEC §10): when a tracked token moves past a threshold, a scenario from the events before the move.

It replays what was known before, with a synthetic crowd on a private test market, to show what that crowd reacts to. It does not
say why the real price moved, and the seed text says that too. A token is tracked once the graph has seen it before the day of
the move: without earlier events there is nothing to replay.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from hyvo.llm.types import LLMClient
from hyvo.report.guard import find_violations
from hyvo.scenarios import parse_scenario_markdown

from .graph import NarrativeGraph
from .seedpack import (
    MIN_RESERVE_USD,
    NOT_A_STORY,
    SYMBOL_RE,
    VULGAR_RE,
    NarrativeSettings,
    eth_price,
    market_for,
    pct,
    reader,
    refresh,
    render,
    usd,
)
from .signals import Signal

DEFAULT_THRESHOLD_PCT = 50.0
PURPOSE = "autopsy"
TRACKED_AFTER_HOURS = 12
REPEAT_AFTER_DAYS = 7
LOOK_BACK_HOURS = 72
MIN_ROUND = 2


def find_move(graph: NarrativeGraph, threshold_pct: float, now: datetime) -> Signal | None:
    """Today's largest move past the threshold of a token the graph already knew."""
    today = graph.signals(since=now - timedelta(hours=24), kinds=("move",))
    used = graph.used_since(PURPOSE, now - timedelta(days=REPEAT_AFTER_DAYS))
    best: Signal | None = None
    for signal in today:
        symbol = signal.refs.get("symbol", "")
        change = signal.numbers.get("changeH24")
        if change is None or abs(change) < threshold_pct or signal.numbers.get("reserveUsd", 0.0) < MIN_RESERVE_USD:
            continue
        if not SYMBOL_RE.match(symbol) or symbol in NOT_A_STORY or symbol in used or VULGAR_RE.search(symbol):
            continue
        first = graph.first_seen(symbol)
        if first is None or now - first < timedelta(hours=TRACKED_AFTER_HOURS):
            continue
        if best is None or abs(change) > abs(best.numbers["changeH24"]):
            best = signal
    return best


def _timeline_line(signal: Signal) -> str | None:
    if signal.kind == "launch":
        return f"{signal.refs.get('symbol')} opened a pool on {signal.at:%Y-%m-%d}."
    if signal.kind == "news":
        return f"A headline on {signal.at:%Y-%m-%d}: {signal.title}"
    if signal.kind == "move" and "changeH24" in signal.numbers and "volumeH24" in signal.numbers:
        return f"On {signal.at:%Y-%m-%d} public data showed a 24-hour price change of {pct(signal.numbers['changeH24'])} on about {usd(signal.numbers['volumeH24'])} of volume."
    return None


def _before_the_move(graph: NarrativeGraph, move: Signal, now: datetime) -> list[Signal]:
    symbol = move.refs["symbol"]
    earlier = graph.about(symbol, since=now - timedelta(hours=LOOK_BACK_HOURS), until=now)
    return [signal for signal in earlier if signal.key != move.key]


def build_autopsy(
    settings: NarrativeSettings,
    day: date,
    *,
    client: LLMClient | None,
    threshold_pct: float = DEFAULT_THRESHOLD_PCT,
    rounds: int = 8,
    log: Callable[[str], None] = print,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
    fetch_signals: Callable[[NarrativeGraph, datetime], Sequence[Signal]] | None = None,
) -> Path | None:
    """The scenario file, or ``None`` when no tracked token moved that far today."""
    folder = settings.folder / "autopsies" / day.isoformat()
    scenario = folder / "scenario.md"
    if scenario.is_file():
        return scenario
    moment = now()
    with NarrativeGraph(settings.graph_path) as graph:
        if fetch_signals is not None:
            graph.add(fetch_signals(graph, moment), moment)
        else:
            refresh(graph, settings, moment, log)
        move = find_move(graph, threshold_pct, moment)
        if move is None:
            log(f"autopsy: no tracked token moved {threshold_pct:g}% today")
            return None
        earlier = _before_the_move(graph, move, moment)
        symbol = move.refs["symbol"]
        lines = [line for signal in earlier if (line := _timeline_line(signal)) and not find_violations(line)]
        if not lines:
            log(f"autopsy: nothing is known about {symbol} from before its move")
            return None
        change = move.numbers["changeH24"]
        title = f"What a synthetic crowd reacts to before {symbol} moved {pct(change)} on Robinhood Chain"
        keep = reader(client)
        kept = keep([("title", title), *((f"line{i}", line) for i, line in enumerate(lines))])
        if "title" not in kept:
            log(f"autopsy: {symbol} did not pass the read")
            return None
        lines = [line for i, line in enumerate(lines) if f"line{i}" in kept]
        if not lines:
            log(f"autopsy: nothing about {symbol} passed the read")
            return None
        intro = (
            f"This is a simulation. On {moment:%Y-%m-%d}, public pool data showed {symbol} on Robinhood Chain with a 24-hour price change of "
            f"{pct(change)}. The synthetic crowd here does not know that. It starts before the move, on a private test market, and "
            "learns only what was public before it. This shows what such a crowd reacts to. It does not say why the real price moved."
        )
        step = max(1, (rounds - MIN_ROUND) // max(1, len(lines)))
        events = [(min(rounds, MIN_ROUND + index * step), line) for index, line in enumerate(lines[: rounds - MIN_ROUND + 1])]
        # The test market opens at the price before the move.
        start = dict(move.numbers)
        if "priceUsd" in start and change > -100:
            start["priceUsd"] = start["priceUsd"] / (1 + change / 100)
        market = market_for(replace(move, numbers=start), eth_price(graph.signals(since=moment - timedelta(hours=24))))
        text = render(title, market, [intro], events, [("onchain", f"robinhood:{move.refs['pool']}")])
        parse_scenario_markdown(text, ref=f"autopsy-{day}.md")
        folder.mkdir(parents=True, exist_ok=True)
        scenario.write_text(text, encoding="utf-8", newline="\n")
        graph.mark_used(symbol, PURPOSE, moment)
        log(f"autopsy: {symbol} moved {pct(change)}: {scenario}")
        return scenario

