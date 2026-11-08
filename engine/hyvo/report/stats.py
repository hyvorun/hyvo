"""Deterministic report statistics. Every number in a report comes from here, never from the LLM.

Turning-point score of round n (each component in [0, 1]):

    score = 0.40 * |priceChangePct(n)| / max over rounds of |priceChangePct|
          + 0.30 * |sentiment(n) - sentiment(n-1)| / max over rounds of that change
          + 0.20 * [net flow changed sign versus the last round with a non-zero net flow]
          + 0.10 * [an event was injected at round n]

Round 1's price change is measured against the initial market; its sentiment change is 0 (there is
no baseline). A component whose maximum is 0 contributes 0. The candidates are the three rounds
with the highest positive score, ties going to the earlier round.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation, localcontext
from itertools import pairwise
from typing import Any

from hyvo.report.types import ReportInput

W_PRICE, W_SENTIMENT, W_FLOW_FLIP, W_EVENT = 0.4, 0.3, 0.2, 0.1
MAX_CANDIDATES = 3
MAX_DRIVERS = 5
SWAP_BUY, SWAP_SELL = "swap_buy", "swap_sell"
_FOUR_PLACES = Decimal("0.0001")


@dataclass(frozen=True)
class RoundStats:
    """One row of the round table. ``net_flow_eth`` = ETH paid in by buys - ETH paid out to sells."""

    n: int
    price: str
    price_change_pct: float | None
    reserve0: str
    reserve1: str
    holders: int
    net_flow_eth: Decimal
    buys: int
    sells: int
    posts: int
    likes: int
    sentiment: float
    events: tuple[str, ...]
    invalid: int
    reverted: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "round": self.n,
            "price": self.price,
            "priceChangePct": self.price_change_pct,
            "reserve0": self.reserve0,
            "reserve1": self.reserve1,
            "holders": self.holders,
            "netFlowEth": format_decimal(self.net_flow_eth),
            "buys": self.buys,
            "sells": self.sells,
            "posts": self.posts,
            "likes": self.likes,
            "sentiment": self.sentiment,
            "events": list(self.events),
            "invalid": self.invalid,
            "reverted": self.reverted,
        }


@dataclass(frozen=True)
class PersonaFlow:
    """Swap totals of one persona over the run (``agents`` comes from ``personaMix``)."""

    persona: str
    agents: int
    buys: int
    sells: int
    eth_in: Decimal
    eth_out: Decimal

    @property
    def net_flow_eth(self) -> Decimal:
        return self.eth_in - self.eth_out

    def to_dict(self) -> dict[str, Any]:
        return {
            "persona": self.persona,
            "agents": self.agents,
            "buys": self.buys,
            "sells": self.sells,
            "ethIn": format_decimal(self.eth_in),
            "ethOut": format_decimal(self.eth_out),
            "netFlowEth": format_decimal(self.net_flow_eth),
        }


@dataclass(frozen=True)
class Candidate:
    """A turning-point candidate with the components of its score."""

    round: int
    score: float
    price_change_pct: float | None
    sentiment_change: float
    flow_flip: bool
    has_event: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "round": self.round,
            "score": self.score,
            "priceChangePct": self.price_change_pct,
            "sentimentChange": self.sentiment_change,
            "netFlowFlipped": self.flow_flip,
            "injectedEvent": self.has_event,
        }


@dataclass(frozen=True)
class PriceDriver:
    """One executed swap and its price impact in percent."""

    round: int
    agent_id: str
    persona: str
    kind: str
    amount_in: str
    amount_out: str
    price_before: str
    price_after: str
    impact_pct: float
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "round": self.round,
            "agentId": self.agent_id,
            "persona": self.persona,
            "kind": self.kind,
            "amountIn": self.amount_in,
            "amountOut": self.amount_out,
            "priceBefore": self.price_before,
            "priceAfter": self.price_after,
            "impactPct": self.impact_pct,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class ReportStats:
    rounds: list[RoundStats]
    persona_flows: list[PersonaFlow]
    candidates: list[Candidate]
    drivers: list[PriceDriver]

    @property
    def sentiment_by_round(self) -> list[float]:
        return [row.sentiment for row in self.rounds]


def compute_stats(
    inp: ReportInput, *, max_candidates: int = MAX_CANDIDATES, max_drivers: int = MAX_DRIVERS
) -> ReportStats:
    table = round_table(inp)
    return ReportStats(
        rounds=table,
        persona_flows=persona_flows(inp),
        candidates=turning_point_candidates(table, max_candidates),
        drivers=price_drivers(inp, max_drivers),
    )


def round_table(inp: ReportInput) -> list[RoundStats]:
    rows: list[RoundStats] = []
    previous = parse_decimal(inp.initial_market["price"], "initial_market.price")
    for trace in inp.rounds:
        market = trace.market_after
        price = parse_decimal(market["price"], f"round {trace.n} price")
        eth_in = eth_out = Decimal(0)
        buys = sells = 0
        for swap in trace.swaps:
            if _swap_kind(swap) == SWAP_BUY:
                buys += 1
                eth_in += parse_decimal(swap["amountIn"], f"round {trace.n} swap amountIn")
            else:
                sells += 1
                eth_out += parse_decimal(swap["amountOut"], f"round {trace.n} swap amountOut")
        rows.append(
            RoundStats(
                n=trace.n,
                price=str(market["price"]),
                price_change_pct=percent_change(previous, price),
                reserve0=str(market["reserve0"]),
                reserve1=str(market["reserve1"]),
                holders=int(market["holders"]),
                net_flow_eth=eth_in - eth_out,
                buys=buys,
                sells=sells,
                posts=len(trace.posts),
                likes=sum(int(post.get("likes", 0)) for post in trace.posts),
                sentiment=mean_sentiment(trace.sentiments),
                events=tuple(trace.injected_events),
                invalid=trace.invalid_count,
                reverted=trace.reverted_count,
            )
        )
        previous = price
    return rows


def sentiment_by_round(inp: ReportInput) -> list[float]:
    """``report.sentimentByRound``: the mean agent sentiment of each round (see ``mean_sentiment``)."""
    return [mean_sentiment(trace.sentiments) for trace in inp.rounds]


def mean_sentiment(sentiments: Mapping[str, Any]) -> float:
    """Mean of the finite numeric values (each clamped to [-1, 1]), rounded to 4 decimals; 0.0 if none."""
    values = [
        _clamp(float(value))
        for value in sentiments.values()
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    ]
    if not values:
        return 0.0
    return _clamp(round(math.fsum(values) / len(values), 4)) + 0.0  # + 0.0 turns -0.0 into 0.0


def persona_flows(inp: ReportInput) -> list[PersonaFlow]:
    mix: Mapping[str, int] = inp.crowd.get("personaMix", {})
    totals: dict[str, list[Any]] = {persona: [0, 0, Decimal(0), Decimal(0)] for persona in mix}
    for trace in inp.rounds:
        for swap in trace.swaps:
            entry = totals.setdefault(str(swap["persona"]), [0, 0, Decimal(0), Decimal(0)])
            if _swap_kind(swap) == SWAP_BUY:
                entry[0] += 1
                entry[2] += parse_decimal(swap["amountIn"], f"round {trace.n} swap amountIn")
            else:
                entry[1] += 1
                entry[3] += parse_decimal(swap["amountOut"], f"round {trace.n} swap amountOut")
    return [
        PersonaFlow(persona, int(mix.get(persona, 0)), *totals[persona]) for persona in sorted(totals)
    ]


def turning_point_candidates(table: list[RoundStats], limit: int = MAX_CANDIDATES) -> list[Candidate]:
    """Score every round (formula in the module docstring) and return the best ``limit`` rounds."""
    price_moves = [abs(row.price_change_pct or 0.0) for row in table]
    sentiment_changes = [0.0] + [b.sentiment - a.sentiment for a, b in pairwise(table)]
    max_price = max(price_moves, default=0.0)
    max_sentiment = max((abs(change) for change in sentiment_changes), default=0.0)
    candidates: list[Candidate] = []
    last_sign = 0
    for row, price_move, sentiment_change in zip(table, price_moves, sentiment_changes):
        sign = (row.net_flow_eth > 0) - (row.net_flow_eth < 0)
        flip = sign != 0 and last_sign != 0 and sign != last_sign
        last_sign = sign or last_sign
        score = round(
            W_PRICE * _ratio(price_move, max_price)
            + W_SENTIMENT * _ratio(abs(sentiment_change), max_sentiment)
            + W_FLOW_FLIP * flip
            + W_EVENT * bool(row.events),
            4,
        )
        if score > 0:
            candidates.append(
                Candidate(
                    round=row.n,
                    score=score,
                    price_change_pct=row.price_change_pct,
                    sentiment_change=round(sentiment_change, 4) + 0.0,
                    flow_flip=flip,
                    has_event=bool(row.events),
                )
            )
    candidates.sort(key=lambda c: (-c.score, c.round))
    return candidates[:limit]


def price_drivers(inp: ReportInput, limit: int = MAX_DRIVERS) -> list[PriceDriver]:
    """The ``limit`` executed swaps with the largest absolute price impact (earliest first on ties)."""
    ranked: list[tuple[float, int, PriceDriver]] = []
    for trace in inp.rounds:
        for swap in trace.swaps:
            impact = percent_change(
                parse_decimal(swap["priceBefore"], f"round {trace.n} swap priceBefore"),
                parse_decimal(swap["priceAfter"], f"round {trace.n} swap priceAfter"),
            )
            if impact is None:
                continue
            driver = PriceDriver(
                round=trace.n,
                agent_id=str(swap["agentId"]),
                persona=str(swap["persona"]),
                kind=_swap_kind(swap),
                amount_in=str(swap["amountIn"]),
                amount_out=str(swap["amountOut"]),
                price_before=str(swap["priceBefore"]),
                price_after=str(swap["priceAfter"]),
                impact_pct=impact,
                reason=str(swap.get("reason") or ""),
            )
            ranked.append((abs(impact), len(ranked), driver))
    ranked.sort(key=lambda item: (-item[0], item[1]))
    return [driver for _, _, driver in ranked[:limit]]


def percent_change(before: Decimal, after: Decimal) -> float | None:
    """``(after - before) / before * 100`` rounded half-even to 4 decimals; ``None`` when before is 0."""
    if before == 0:
        return None
    with localcontext() as ctx:
        ctx.prec = 60
        change = ((after - before) / before * 100).quantize(_FOUR_PLACES, rounding=ROUND_HALF_EVEN)
    return float(change) + 0.0


def parse_decimal(value: Any, what: str) -> Decimal:
    """Parse a Decimal string (or int) exactly; floats are rejected to keep amounts exact."""
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ValueError(f"{what}: expected a decimal string, got {value!r}")
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise ValueError(f"{what}: not a decimal number: {value!r}") from None
    if not number.is_finite():
        raise ValueError(f"{what}: not a finite number: {value!r}")
    return number


def format_decimal(value: Decimal) -> str:
    """Plain decimal notation without exponent or trailing zeros; keeps the sign of negatives."""
    if value == 0:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _swap_kind(swap: Mapping[str, Any]) -> str:
    kind = swap.get("kind")
    if kind not in (SWAP_BUY, SWAP_SELL):
        raise ValueError(f"swap kind must be {SWAP_BUY} or {SWAP_SELL}, got {kind!r}")
    return str(kind)


def _clamp(value: float) -> float:
    return max(-1.0, min(1.0, value))


def _ratio(value: float, maximum: float) -> float:
    return value / maximum if maximum > 0 else 0.0
