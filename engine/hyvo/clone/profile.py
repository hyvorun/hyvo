"""From a wallet's trades to a profile (SPEC 11.3): statistics about what it did, and nothing about who it is.

A profile holds numbers only: no address, no token, no date. It says how much the wallet buys, how long it stays, how much of a position it lets go at once
and how soon after a token's creation it enters. ``clone_persona`` turns those numbers into the agent's prompt, without guessing at a character.
"""

from __future__ import annotations

import statistics
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass
from decimal import Decimal
from typing import Any

from hyvo.personas import Persona

from .history import MAX_TOKEN_AGES, Trade

MIN_TRADES = 5
PROFILE_VERSION = 1
HOUR_S = 3600.0
DEFAULT_BUY_ETH = 0.02
MIN_BUY_ETH = 0.001
MAX_BUY_ETH = 2.0


class NotEnoughHistory(ValueError):
    """The wallet has too few trades for its numbers to mean anything."""


@dataclass(frozen=True)
class CloneProfile:
    """What the run receives. Whole numbers where a finer one would help identify a wallet."""

    version: int
    trades: int
    buys: int
    sells: int
    tokens: int
    typicalBuyEth: float | None
    smallBuyEth: float | None
    largeBuyEth: float | None
    medianHoldHours: float | None
    soldWithinHourPct: int | None
    stillHeldPct: int | None
    medianSellPct: int | None
    medianEntryMinutes: float | None
    earlyEntryPct: int | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> CloneProfile:
        known = {field: data.get(field) for field in cls.__dataclass_fields__}
        if set(data) - set(known):
            raise ValueError(f"unknown clone profile members: {sorted(set(data) - set(known))}")
        return cls(**known)


def _coarse(value: float) -> float:
    """Two significant figures: enough to trade like, too coarse to look a wallet up by."""
    return float(f"{value:.2g}")


def _percent(part: int, whole: int) -> int | None:
    return round(100 * part / whole) if whole else None


def tokens_to_date(trades: Sequence[Trade]) -> list[str]:
    """The tokens worth asking the age of, most traded first, up to ``MAX_TOKEN_AGES``."""
    counts: dict[str, int] = {}
    for trade in trades:
        if trade.side == "buy":
            counts[trade.token] = counts.get(trade.token, 0) + 1
    return sorted(counts, key=lambda token: (-counts[token], token))[:MAX_TOKEN_AGES]


def build_profile(trades: Sequence[Trade], created_at: Mapping[str, float | None] | None = None) -> CloneProfile:
    """The statistics of a wallet's trades, oldest first. ``created_at`` holds the tokens' creation times, where known."""
    if len(trades) < MIN_TRADES:
        raise NotEnoughHistory(f"this wallet has {len(trades)} trades on Robinhood Chain, and a clone needs at least {MIN_TRADES}")
    buys = [trade for trade in trades if trade.side == "buy"]
    sells = [trade for trade in trades if trade.side == "sell"]
    sizes = sorted(float(trade.eth) for trade in buys if trade.eth is not None and trade.eth > 0)
    opened: dict[str, float] = {}  # when each open position was bought
    first_sale_done: set[str] = set()
    holding: dict[str, Decimal] = {}
    holds: list[float] = []
    sold_shares: list[float] = []
    for trade in trades:
        if trade.side == "buy":
            if trade.token not in opened:
                opened[trade.token] = trade.at
                first_sale_done.discard(trade.token)
            holding[trade.token] = holding.get(trade.token, Decimal(0)) + trade.tokens
            continue
        held = holding.get(trade.token, Decimal(0))
        if held <= 0:
            continue  # Bought outside the window this history covers.
        sold = min(trade.tokens, held)
        sold_shares.append(float(sold / held))
        if trade.token not in first_sale_done:
            holds.append(trade.at - opened[trade.token])
            first_sale_done.add(trade.token)
        holding[trade.token] = held - sold
        if holding[trade.token] <= held * Decimal("0.01"):  # what is left is dust: the position is closed
            holding[trade.token] = Decimal(0)
            del opened[trade.token]
    entries = [
        (buy.at - created) / 60
        for token, buy in _first_buys(trades).items()
        if created_at is not None and (created := created_at.get(token)) is not None and buy.at >= created
    ]
    positions = {trade.token for trade in buys}
    still_held = sum(1 for token in positions if holding.get(token, Decimal(0)) > 0)
    return CloneProfile(
        version=PROFILE_VERSION,
        trades=len(trades),
        buys=len(buys),
        sells=len(sells),
        tokens=len({trade.token for trade in trades}),
        typicalBuyEth=_coarse(statistics.median(sizes)) if sizes else None,
        smallBuyEth=_coarse(_quantile(sizes, 0.25)) if sizes else None,
        largeBuyEth=_coarse(_quantile(sizes, 0.75)) if sizes else None,
        medianHoldHours=_coarse(statistics.median(holds) / HOUR_S) if holds else None,
        soldWithinHourPct=_percent(sum(hold <= HOUR_S for hold in holds), len(holds)),
        stillHeldPct=_percent(still_held, len(positions)),
        medianSellPct=round(100 * statistics.median(sold_shares)) if sold_shares else None,
        medianEntryMinutes=_coarse(statistics.median(entries)) if entries else None,
        earlyEntryPct=_percent(sum(entry <= 60 for entry in entries), len(entries)),
    )


def _first_buys(trades: Iterable[Trade]) -> dict[str, Trade]:
    first: dict[str, Trade] = {}
    for trade in trades:
        if trade.side == "buy":
            first.setdefault(trade.token, trade)
    return first


def _quantile(ordered: Sequence[float], share: float) -> float:
    return ordered[min(len(ordered) - 1, int(len(ordered) * share))]


def _hours(value: float) -> str:
    return f"{value:g} hours" if value >= 1 else f"{value * 60:.0f} minutes"


def clone_persona(profile: CloneProfile) -> Persona:
    """The agent that trades by these numbers. Every sentence comes from a number, or says that there is none."""
    typical = min(MAX_BUY_ETH, max(MIN_BUY_ETH, profile.typicalBuyEth or DEFAULT_BUY_ETH))
    low = min(typical, max(MIN_BUY_ETH, profile.smallBuyEth or typical / 2))
    high = max(min(MAX_BUY_ETH, profile.largeBuyEth or typical * 1.5), low * 1.01)
    cap = round(high * 1.25, 4)
    horizon = f"a median of {_hours(profile.medianHoldHours)} between buying a token and first selling it" if profile.medianHoldHours is not None else "no sale on record to measure"
    flips = f"{profile.soldWithinHourPct}% of its first sales came within an hour of buying" if profile.soldWithinHourPct is not None else "no sale on record"
    kept = f"{profile.stillHeldPct}% of the tokens it bought are still held" if profile.stillHeldPct is not None else "nothing bought on record"
    pieces = f"it lets go of a median of {profile.medianSellPct}% of a position at a time" if profile.medianSellPct is not None else "it has not sold on record"
    entry = (
        f"a token about {profile.medianEntryMinutes:g} minutes old, the median age at which it enters, and {profile.earlyEntryPct}% of its entries came in a token's first hour"
        if profile.medianEntryMinutes is not None
        else "a token of any age; its entries have no measured timing"
    )
    return Persona(
        id="clone",
        label="Clone",
        goal=f"Trade the way one wallet's recorded numbers describe, over {profile.trades} trades in {profile.tokens} tokens, and nothing beyond them.",
        risk_tolerance=f"read from the record: {flips}, and {kept}",
        time_horizon=horizon,
        triggers=(entry, f"holding a position for about as long as its record says, when {pieces}", f"{profile.buys} buys against {profile.sells} sells on record, a balance it keeps"),
        posting_style="Plain and short, about its own trades and the numbers. It says nothing about who it is.",
        typical_size_eth=(round(low, 4), round(high, 4)),
        initial_eth=(round(max(cap * 5, 0.2), 4), round(max(cap * 8, 0.3), 4)),
        initial_token_weight=0.0,
        per_agent_cap_eth=cap,
    )
