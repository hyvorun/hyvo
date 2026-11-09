"""The day's seed pack (SPEC §10): the top narratives, notable launches and moves, which become a scenario.

The scenario is built from a template, not written by a model. Every number in it comes from public data, so there is nothing to
hallucinate, and it costs no allowance. The report model only reads it, line by line, before anything is played: a line that
names a real person, or that it objects to for any other reason, does not go in. A token it objects to is passed over.

A pack is written once per day, so a restart plays the same scenario. A thin day, with nothing that qualifies, gives ``None``,
and the daily run falls back to an example scenario.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import httpx

from hyvo.llm.types import LLMClient
from hyvo.report.guard import find_violations
from hyvo.report.review import review_posts
from hyvo.scenarios import ScenarioError, parse_scenario_markdown

from . import farcaster, pools, rss
from .graph import NarrativeGraph
from .signals import (
    TIMEOUT_S,
    USER_AGENT,
    Collected,
    Fetcher,
    Signal,
    SourceError,
    by_kind,
    collect,
)

ROUND_EVENTS = (3, 5, 8)
MIN_RESERVE_USD = 10_000.0
MIN_VOLUME_USD = 1_000.0
MAX_FDV_USD = 50_000_000.0
MAX_POOL_AGE_DAYS = 14
LOOKBACK_HOURS = 36
WINDOW_DAYS = 14
MIN_LIQUIDITY_ETH = Decimal(2)
MAX_LIQUIDITY_ETH = Decimal(25)
DEFAULT_LIQUIDITY_ETH = Decimal(5)
DEFAULT_FEE_BPS = 100  # Pons charges 1% (docs/OPEN_ITEMS.md item 5)
MAX_CONTEXT_MOVES = 4
MAX_HEADLINES = 4
MAX_SOURCES = 8
MAX_SOURCE_CHARS = 200
PURPOSE = "seedpack"

# The sim's token symbol is the real one or nothing: uppercase letters and digits, as the world requires.
SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9]{1,10}$")
# Quote assets and majors are the water, not the story. HYVO is Hyvo's own token: an unattended public run about it would
# read as Hyvo talking about its own token, so neither it nor anything that could pass for it is ever a run's subject.
NOT_A_STORY = frozenset({"WETH", "ETH", "USDG", "USDC", "USDT", "DAI", "WBTC", "BTC", "PONS", "HYVO"})
OWN_TOKEN = "HYVO"
# A zero for the O, and doubled letters, are the usual ways to make a symbol look like another one.
_ZERO_AS_O = str.maketrans("0", "O")
_DOUBLED = re.compile(r"(.)\1+")


def passes_for_hyvo(text: str) -> bool:
    """Whether a symbol, a topic or a headline names Hyvo's token or something that could pass for it: HYVO, HYV0, HYYVO,
    WHYVO, HYVOAI, $HYVO, "Hyvo"."""
    return OWN_TOKEN in _DOUBLED.sub(r"\1", text.upper().translate(_ZERO_AS_O))


def not_a_story(symbol: str) -> bool:
    """A quote asset, a major, or Hyvo's own token or a lookalike: never the subject of a run, nor one of its context lines."""
    return symbol in NOT_A_STORY or passes_for_hyvo(symbol)
# A headline built on what someone said or did is about a person, and a run's text goes on-chain for good. The report model
# reads every line as well; this does not depend on it.
_ABOUT_SOMEONE = re.compile(r"\b(?:says?|said|warns?|warned|claims?|claimed|accus\w+|sues?|sued|charged|arrested|convicted|alleg\w+|lawsuit)\b", re.IGNORECASE)
VULGAR_RE = re.compile(r"FUCK|SHIT|BONER|COCK|DICK|PUSSY|PORN|RAPE|NAZI|HITLER|CUM\b|TITS", re.IGNORECASE)


@dataclass(frozen=True)
class SeedPack:
    day: str
    symbol: str
    path: Path  # the scenario file
    data: Mapping[str, object]


@dataclass(frozen=True)
class NarrativeSettings:
    folder: Path  # <runs dir>/narrative
    feeds: tuple[str, ...] = rss.DEFAULT_FEEDS
    neynar_key: str | None = None
    rounds: int = 10

    @property
    def graph_path(self) -> Path:
        return self.folder / "graph.sqlite"


def default_fetchers(settings: NarrativeSettings) -> dict[str, Fetcher]:
    fetchers: dict[str, Fetcher] = {
        "new pools": pools.new_pools,
        "trending pools": pools.trending_pools,
        "top pools": pools.top_pools,
    }
    for url in settings.feeds:
        fetchers[url] = lambda http, feed=url: rss.fetch_feed(http, feed)
    if settings.neynar_key:
        key = settings.neynar_key
        fetchers["farcaster"] = lambda http: farcaster.search_casts(http, key)
    return fetchers


def refresh(graph: NarrativeGraph, settings: NarrativeSettings, now: datetime, log: Callable[[str], None]) -> Collected:
    """Read the sources into the graph and let the old go."""
    collected = collect(default_fetchers(settings), log=log)
    added = graph.add(collected.signals, now)
    pruned = graph.prune(now - timedelta(days=WINDOW_DAYS))
    log(f"narrative: {added} new signals, {pruned} pruned, {len(collected.failed)} sources failed")
    return collected


def candidates(signals: Sequence[Signal], used: set[str], now: datetime) -> list[Signal]:
    """Tokens that could carry the day, best first. Launches through Pons count double."""
    newest: dict[str, Signal] = {}
    for signal in sorted(by_kind(signals, "launch", "move"), key=lambda item: item.at):
        symbol = signal.refs.get("symbol", "")
        # A launch's snapshot is from its first minutes: a later sighting of the same pool says more.
        if symbol not in newest or signal.at >= newest[symbol].at:
            newest[symbol] = signal
    return sorted((signal for signal in newest.values() if _qualifies(signal, used, now)), key=_score, reverse=True)


def _qualifies(signal: Signal, used: set[str], now: datetime) -> bool:
    symbol = signal.refs.get("symbol", "")
    numbers = signal.numbers
    created = numbers.get("createdAt")
    return (
        bool(SYMBOL_RE.match(symbol))
        and not not_a_story(symbol)
        and symbol not in used
        and not VULGAR_RE.search(symbol)
        and numbers.get("reserveUsd", 0.0) >= MIN_RESERVE_USD
        and numbers.get("volumeH24", 0.0) >= MIN_VOLUME_USD
        and numbers.get("fdvUsd", 0.0) <= MAX_FDV_USD
        and created is not None
        and now.timestamp() - created <= MAX_POOL_AGE_DAYS * 86_400
    )


def _score(signal: Signal) -> float:
    pons = signal.refs.get("dex", "").startswith("pons")
    return signal.numbers.get("volumeH24", 0.0) * (2.0 if pons else 1.0)


def eth_price(signals: Sequence[Signal]) -> float | None:
    """ETH in USD, from a deep pool quoted in WETH."""
    prices = [
        (signal.numbers.get("reserveUsd", 0.0), signal.numbers["quoteUsd"])
        for signal in by_kind(signals, "launch", "move")
        if signal.refs.get("quote") == "WETH" and signal.numbers.get("quoteUsd")
    ]
    return max(prices)[1] if prices else None


def market_for(focus: Signal, eth_usd: float | None) -> dict[str, str]:
    """The test market: the token's real symbol and price, in a thinner pool than the real one, because a crowd of this size
    could not move a deep one. The seed text says so."""
    numbers = focus.numbers
    market = {"token_symbol": focus.refs["symbol"], "fee_bps": str(_fee_bps(focus))}
    reserve = numbers.get("reserveUsd")
    price = numbers.get("priceUsd")
    if not reserve or not price or not eth_usd:
        market["liquidity_eth"] = str(DEFAULT_LIQUIDITY_ETH)
        return market
    half_in_eth = Decimal(str(reserve)) / 2 / Decimal(str(eth_usd))
    liquidity = min(MAX_LIQUIDITY_ETH, max(MIN_LIQUIDITY_ETH, half_in_eth)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    tokens = (liquidity * Decimal(str(eth_usd)) / Decimal(str(price))).quantize(Decimal(1), rounding=ROUND_HALF_UP)
    market["liquidity_eth"] = str(liquidity)
    if Decimal(1000) <= tokens <= Decimal(10**15):
        market["liquidity_tokens"] = str(tokens)
    return market


def _fee_bps(focus: Signal) -> int:
    fee = focus.numbers.get("feePct")
    if fee is not None and 0 <= fee <= 10:
        return round(fee * 100)
    return DEFAULT_FEE_BPS


def usd(amount: float) -> str:
    if amount >= 1_000_000:
        return f"${amount / 1_000_000:.1f} million"
    if amount >= 10_000:
        return f"${amount / 1_000:.0f} thousand"
    return f"${amount:,.0f}"


def pct(change: float) -> str:
    return f"{change:+.1f}%"


def _dex_name(dex: str) -> str:
    if dex.startswith("pons"):
        return "Pons"
    return dex.removesuffix("-robinhood").replace("-", " ")


def focus_paragraph(focus: Signal, day: str, now: datetime) -> str:
    symbol = focus.refs["symbol"]
    numbers = focus.numbers
    parts = [f"On {day}, public pool data for {symbol}, a token on Robinhood Chain traded on {_dex_name(focus.refs.get('dex', ''))}, showed"]
    facts = []
    if "reserveUsd" in numbers:
        facts.append(f"liquidity of about {usd(numbers['reserveUsd'])}")
    if "volumeH24" in numbers:
        facts.append(f"about {usd(numbers['volumeH24'])} traded in 24 hours")
    if "changeH24" in numbers:
        facts.append(f"a price change of {pct(numbers['changeH24'])} over that time")
    if "buysH24" in numbers and "sellsH24" in numbers:
        facts.append(f"{numbers['buysH24']:.0f} swaps in and {numbers['sellsH24']:.0f} swaps out")
    created = numbers.get("createdAt")
    text = f"{parts[0]} {', '.join(facts)}."
    if created is not None:
        hours = max(0.0, (now.timestamp() - created) / 3600)
        age = f"{hours:.0f} hours" if hours < 48 else f"{hours / 24:.0f} days"
        text += f" The pool was about {age} old."
    return text


def context_moves(signals: Sequence[Signal], focus: Signal) -> list[Signal]:
    """The biggest moves among the busiest pools, one line per token."""
    seen = {focus.refs["symbol"], *NOT_A_STORY}
    moves: list[Signal] = []
    latest: dict[str, Signal] = {}
    for signal in sorted(by_kind(signals, "move"), key=lambda item: item.at):
        latest[signal.refs.get("pool", signal.key)] = signal
    busy = sorted(latest.values(), key=lambda s: s.numbers.get("volumeH24", 0.0), reverse=True)[:40]
    for signal in sorted(busy, key=lambda s: abs(s.numbers.get("changeH24", 0.0)), reverse=True):
        symbol = signal.refs.get("symbol", "")
        if symbol in seen or not_a_story(symbol) or not SYMBOL_RE.match(symbol) or VULGAR_RE.search(symbol) or "changeH24" not in signal.numbers or "volumeH24" not in signal.numbers:
            continue
        seen.add(symbol)
        moves.append(signal)
        if len(moves) == MAX_CONTEXT_MOVES:
            break
    return moves


def pick_headlines(graph: NarrativeGraph, narratives: Sequence[tuple[str, int]], since: datetime) -> list[Signal]:
    """A headline for each of the day's narratives, most relevant to this chain first."""
    picked: dict[str, Signal] = {}
    names = ["Robinhood", "Pons", "Tokenized stocks", "Memecoins", *[name for name, _ in narratives]]
    for name in dict.fromkeys(names):
        for signal in reversed(graph.about(name, since=since)):
            if signal.kind == "news" and signal.key not in picked and not _ABOUT_SOMEONE.search(signal.title) and not passes_for_hyvo(signal.title):
                picked[signal.key] = signal
                break
        if len(picked) == MAX_HEADLINES:
            break
    return list(picked.values())


def render(title: str, market: Mapping[str, str], paragraphs: Sequence[str], events: Sequence[tuple[int, str]], sources: Sequence[tuple[str, str]]) -> str:
    front = [f"title: {title}", *(f"{key}: {value}" for key, value in market.items())]
    if sources:
        front.append("sources: " + " | ".join(f"{kind} {ref}" for kind, ref in sources))
    body = "\n\n".join(paragraphs)
    lines = ["---", *front, "---", "", body, ""]
    if events:
        lines += ["## Events", "", *(f"- round {n}: {text}" for n, text in events), ""]
    return "\n".join(lines)


def build_scenario(
    graph: NarrativeGraph,
    focus: Signal,
    signals: Sequence[Signal],
    settings: NarrativeSettings,
    day: str,
    now: datetime,
    largest_swap: float | None,
    keep: Callable[[Sequence[tuple[str, str]]], set[str]],
) -> tuple[str, dict[str, object]] | None:
    """The scenario file's text and the pack's data, or ``None`` when the token itself did not pass the read."""
    symbol = focus.refs["symbol"]
    since = now - timedelta(hours=LOOKBACK_HOURS)
    narratives = [(name, count) for name, count in graph.top_entities(since=since) if not passes_for_hyvo(name)]
    headlines = pick_headlines(graph, narratives, since)
    moves = context_moves(signals, focus)
    title = f"How a synthetic crowd reacts to {symbol} on Robinhood Chain, {day}"
    intro = (
        f"This is a simulation. The crowd is synthetic and the market is a private test market that starts at {symbol}'s price in a "
        "much thinner pool than the real one. Nothing here touches the real pool."
    )
    focus_line = focus_paragraph(focus, day, now)
    if find_violations(title) or find_violations(focus_line):
        return None

    move_lines = [f"Elsewhere on the chain, {m.refs['symbol']} moved {pct(m.numbers['changeH24'])} in 24 hours on about {usd(m.numbers['volumeH24'])} of volume." for m in moves]
    topic_line = f"The crypto news that day was mostly about: {', '.join(name for name, _ in narratives[:5])}." if narratives else None
    headline_lines = [f"A headline that day: {item.title}" for item in headlines]
    swap_line = f"Public data: the largest recent swap in the real {symbol} pool was about {usd(largest_swap)}." if largest_swap else None

    to_read = [
        ("title", title),
        ("focus", focus_line),
        *((f"move{i}", line) for i, line in enumerate(move_lines)),
        *([("topics", topic_line)] if topic_line else []),
        *((f"news{i}", line) for i, line in enumerate(headline_lines)),
        *([("swap", swap_line)] if swap_line else []),
    ]
    kept = keep(to_read)
    if "title" not in kept or "focus" not in kept:
        return None
    passed = {line_id: line for line_id, line in to_read if line_id in kept and not find_violations(line)}

    paragraphs = [intro, focus_line, *(passed[f"move{i}"] for i in range(len(move_lines)) if f"move{i}" in passed)]
    if "topics" in passed:
        paragraphs.append(passed["topics"])
    # What the crowd learns during the run: the swap, then the headlines. What does not fit a round is read at the start.
    during = [*([passed["swap"]] if "swap" in passed else []), *(passed[f"news{i}"] for i in range(len(headline_lines)) if f"news{i}" in passed)]
    rounds = [n for n in ROUND_EVENTS if n <= settings.rounds]
    events = list(zip(rounds, during, strict=False))
    paragraphs += during[len(events) :]

    sources = [("url", pools.POOLS_PAGE), ("onchain", f"robinhood:{focus.refs['pool']}")]
    sources += [("url", item.url) for i, item in enumerate(headlines) if f"news{i}" in passed and len(item.url) <= MAX_SOURCE_CHARS]
    market = market_for(focus, eth_price(signals))
    text = render(title, market, paragraphs, events, sources[:MAX_SOURCES])
    parse_scenario_markdown(text, ref=f"seedpack-{day}.md")  # refuses what the engine could not play
    data: dict[str, object] = {
        "day": day,
        "symbol": symbol,
        "focus": {"pool": focus.refs["pool"], "dex": focus.refs.get("dex", ""), "numbers": dict(focus.numbers)},
        "narratives": [{"topic": name, "mentions": count} for name, count in narratives],
        "launches": list(dict.fromkeys(signal.refs["symbol"] for signal in by_kind(signals, "launch")))[:20],
        "moves": move_lines,
        "headlines": [{"title": item.title, "url": item.url} for i, item in enumerate(headlines) if f"news{i}" in passed],
        "market": dict(market),
    }
    return text, data


def reader(client: LLMClient | None) -> Callable[[Sequence[tuple[str, str]]], set[str]]:
    """What the report model lets through. Without a model, nothing can be read, so only an offline run can use the text."""

    def keep(lines: Sequence[tuple[str, str]]) -> set[str]:
        ids = {line_id for line_id, _ in lines}
        if client is None:
            return ids
        review = review_posts(lines, client)
        if not review.complete:
            raise ScenarioError("the report model could not read the seed pack")
        return ids - review.flagged

    return keep


def build_seed_pack(
    settings: NarrativeSettings,
    day: date,
    *,
    client: LLMClient | None,
    log: Callable[[str], None] = print,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
    fetch_signals: Callable[[NarrativeGraph, datetime], Sequence[Signal]] | None = None,
    swap_of: Callable[[str], float | None] | None = None,
) -> SeedPack | None:
    """The day's pack, written once. ``None`` on a thin day."""
    folder = settings.folder / "packs" / day.isoformat()
    scenario = folder / "scenario.md"
    pack_file = folder / "pack.json"
    if scenario.is_file() and pack_file.is_file():
        data = json.loads(pack_file.read_text(encoding="utf-8"))
        return SeedPack(day.isoformat(), data["symbol"], scenario, data)

    moment = now()
    with NarrativeGraph(settings.graph_path) as graph:
        if fetch_signals is not None:
            graph.add(fetch_signals(graph, moment), moment)
        else:
            refresh(graph, settings, moment, log)
        since = moment - timedelta(hours=LOOKBACK_HOURS)
        signals = graph.signals(since=since)
        used = graph.used_since(PURPOSE, moment - timedelta(days=WINDOW_DAYS))
        keep = reader(client)
        for focus in candidates(signals, used, moment)[:3]:
            symbol = focus.refs["symbol"]
            largest = _largest_swap(focus, swap_of, log)
            built = build_scenario(graph, focus, signals, settings, day.isoformat(), moment, largest, keep)
            if built is None:
                log(f"narrative: {symbol} did not pass the read; trying the next token")
                continue
            text, data = built
            folder.mkdir(parents=True, exist_ok=True)
            scenario.write_text(text, encoding="utf-8", newline="\n")
            pack_file.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8", newline="\n")
            graph.mark_used(symbol, PURPOSE, moment)
            log(f"narrative: the seed pack for {day} is about {symbol}: {scenario}")
            return SeedPack(day.isoformat(), symbol, scenario, data)
    log(f"narrative: nothing qualified for {day}")
    return None


def _largest_swap(focus: Signal, swap_of: Callable[[str], float | None] | None, log: Callable[[str], None]) -> float | None:
    if swap_of is not None:
        return swap_of(focus.refs["pool"])
    try:
        with httpx.Client(timeout=TIMEOUT_S, trust_env=False, follow_redirects=True, headers={"User-Agent": USER_AGENT}) as http:
            return pools.largest_swap_usd(http, focus.refs["pool"])
    except (httpx.HTTPError, SourceError, ValueError) as error:
        log(f"narrative: could not read the largest swap: {type(error).__name__}")
        return None
