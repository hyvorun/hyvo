"""Rewind (SPEC 11.4): a past moment of a real pool, played again with one thing changed, next to what actually happened.

The fork starts at the block, a test pair is seeded with the reserves the pool had there, the crowd is rebuilt, and one event differs. What really happened after that block is read
from the chain before the run starts and goes into its file, so the comparison is hashed with the result and cannot be chosen afterwards. It compares; it does not forecast.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from hyvo.scenarios import MarketOverrides, Scenario, ScenarioError
from hyvo.scenarios.sanitize import MAX_SEED_CHARS
from hyvo.world.units import format_amount, format_price

from .chain import DECIMALS, NAME, SYMBOL, TOKEN0, TOKEN1, CallReverted, Chain

MIN_HOURS, MAX_HOURS = 1.0, 72.0
DEFAULT_FEE_BPS = 100
ETH_SYMBOLS = frozenset({"WETH", "ETH"})
GECKO = "https://api.geckoterminal.com/api/v2/networks/robinhood/pools/{pool}?include=base_token"
_NOT_A_SYMBOL = re.compile(r"[^A-Z0-9]")
TIMEOUT_S = 20.0


class RewindError(ValueError):
    """This rewind cannot be played: the words say why, for whoever asked for it."""


@dataclass(frozen=True)
class RewindRequest:
    pool: str
    block: int
    hours: float


@dataclass(frozen=True)
class TokenInfo:
    symbol: str
    name: str


@dataclass(frozen=True)
class RewindPlan:
    scenario: Scenario
    block: int
    section: dict[str, Any]


def gecko_token_info(pool: str) -> TokenInfo | None:
    """A Pons pool's token: Pons pools do not answer ``token0()``, and GeckoTerminal names them without a key."""
    request = urllib.request.Request(GECKO.format(pool=pool), headers={"Accept": "application/json", "User-Agent": "hyvo-engine"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:  # noqa: S310 - a fixed host
            answer = json.load(response)
        token = next(item for item in answer["included"] if item["type"] == "token")["attributes"]
        return TokenInfo(str(token["symbol"]), str(token["name"]))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, TypeError, StopIteration):
        return None


def _symbol(text: str | None) -> str:
    return _NOT_A_SYMBOL.sub("", (text or "").upper())[:11] or "TOKEN"


def _iso(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _sides(chain: Chain, request: RewindRequest, lookup: Callable[[str], TokenInfo | None]) -> tuple[bool, TokenInfo, int]:
    """Whether the first reserve is the ETH side, the token, and its decimals."""
    first = chain.address_or_none(request.pool, TOKEN0, request.block)
    second = chain.address_or_none(request.pool, TOKEN1, request.block)
    if first is None or second is None:
        # A Pons pool: its first reserve is the ETH side, on every pool read (docs/OPEN_ITEMS.md item 25).
        found = lookup(request.pool)
        return True, found or TokenInfo("TOKEN", "Token"), 18
    symbols = [(chain.text_or_none(address, SYMBOL, request.block) or "").upper() for address in (first, second)]
    if symbols[0] in ETH_SYMBOLS:
        eth_first, token = True, second
    elif symbols[1] in ETH_SYMBOLS:
        eth_first, token = False, first
    else:
        raise RewindError("this pool is not priced in ETH, and a rewind needs one that is")
    decimals = chain.number_or_none(token, DECIMALS, request.block)
    return eth_first, TokenInfo(symbols[1 if eth_first else 0] or "TOKEN", chain.text_or_none(token, NAME, request.block) or "Token"), 18 if decimals is None else decimals


def plan_rewind(
    request: RewindRequest,
    scenario: Scenario,
    rounds: int,
    chain: Chain,
    *,
    lookup: Callable[[str], TokenInfo | None] = gecko_token_info,
) -> RewindPlan:
    """What to play and what to compare it with. ``scenario`` holds the title, what the crowd should know, and the one event that differs."""
    if not MIN_HOURS <= request.hours <= MAX_HOURS:
        raise RewindError(f"a rewind looks {MIN_HOURS:g} to {MAX_HOURS:g} hours ahead, not {request.hours:g}")
    if len(scenario.injected_events) != 1:
        raise RewindError("a rewind changes one thing: give exactly one event")
    change = scenario.injected_events[0]
    head = chain.head()
    if request.block >= head:
        raise RewindError(f"block {request.block} is not in the past: the chain is at {head}")
    started = chain.time_of(request.block)
    newest = chain.time_of(head)
    per_second = (head - request.block) / max(1, newest - started)
    end = request.block + round(request.hours * 3600 * per_second)
    if end > head:
        raise RewindError(f"{request.hours:g} hours after block {request.block} is still in the future; choose an earlier block or fewer hours")
    try:
        eth_first, token, decimals = _sides(chain, request, lookup)
        path = _path(chain, request, end, rounds, eth_first, decimals)
    except CallReverted as error:
        raise RewindError(f"the pool could not be read at block {request.block}: {error}") from None
    start = path[0]
    if Decimal(start["reserveEth"]) <= 0 or Decimal(start["reserveToken"]) <= 0:
        raise RewindError(f"this pool held nothing at block {request.block}; it may not have existed yet")
    symbol = _symbol(token.symbol)
    given = scenario.market
    market = MarketOverrides(
        token_symbol=given.token_symbol if given and given.token_symbol else symbol,
        token_name=given.token_name if given and given.token_name else token.name[:64],
        liquidity_eth=Decimal(start["reserveEth"]),
        liquidity_tokens=Decimal(start["reserveToken"]),
        fee_bps=given.fee_bps if given and given.fee_bps is not None else DEFAULT_FEE_BPS,
    )
    seed = (
        f"This replays a real moment. At {_iso(started)} (block {request.block}) a pool held {start['reserveEth']} ETH and {start['reserveToken']} {market.token_symbol}, "
        f"a price of {start['price']} ETH per token. One thing is different this time, in round {change.round}: {change.text} "
        "This is a private test market seeded with those numbers. Nothing here touches the real pool."
    )
    if scenario.seed_text:
        seed = f"{seed}\n\n{scenario.seed_text}"
    try:
        played = replace(scenario, seed_text=seed[:MAX_SEED_CHARS], market=market)
    except ScenarioError as error:
        raise RewindError(str(error)) from None
    return RewindPlan(
        scenario=played,
        block=request.block,
        section={"pool": request.pool, "block": request.block, "at": _iso(started), "hours": request.hours, "change": change.text, "actual": path},
    )


def _path(chain: Chain, request: RewindRequest, end: int, rounds: int, eth_first: bool, decimals: int) -> list[dict[str, Any]]:
    """The pool at the block and at the end of each round's share of the window."""
    points = []
    for index in range(rounds + 1):
        block = request.block + (end - request.block) * index // rounds
        first, second = chain.reserves_at(request.pool, block)
        eth, tokens = (first, second) if eth_first else (second, first)
        # The price of whole tokens, whatever their decimals: the same units as a run's own price.
        scaled = tokens * 10 ** (18 - decimals) if decimals <= 18 else tokens // 10 ** (decimals - 18)
        points.append(
            {
                "block": block,
                "at": _iso(chain.time_of(block)),
                "price": format_price(eth, scaled) if eth and scaled else "0",
                "reserveEth": format_amount(eth, 18),
                "reserveToken": format_amount(tokens, decimals),
            }
        )
    return points
