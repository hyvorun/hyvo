"""Replay a run's recorded swaps with exact integer AMM math and compare the result with the
recorded markets: the Phase 1 check that "the recorded price matches the swaps".

Only executed swaps move the pool: actions with status ``ok`` and kind ``swap_buy`` or
``swap_sell``. ``hold``, ``check_market``, ``invalid`` (recorded as ``hold``) and ``reverted``
actions are skipped. A round's ``actions`` must be listed in execution order, since each swap's
output depends on the swaps before it. Recorded decimal strings convert back to base units
exactly (no floats).

The replay starts from ``world.initialMarket`` (the pool before round 1). Callers may pass the
reserves explicitly instead; a document without ``initialMarket`` is replayed from reserves
reconstructed by undoing round 1's swaps (weaker: round 1 then only checks the swap formula).
When ``crowd.agents`` carry ``startTokens``/``startEth``, each agent's balances are tracked through
its executed swaps, so every round's ``holders`` is checked and no agent may spend tokens or ETH it
does not have (gas is free on the per-job chain, so balances move only by swaps).
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from hyvo.world.amm import Reserves, apply_buy, apply_sell
from hyvo.world.state import MarketState
from hyvo.world.units import format_amount, to_base_units

SWAP_KINDS = ("swap_buy", "swap_sell")
MARKET_KEYS = ("price", "reserve0", "reserve1")


@dataclass(frozen=True)
class RoundReplay:
    n: int
    reserves: Reserves  # after the round's executed swaps
    mismatches: tuple[str, ...]  # executed swaps whose recorded output differs from the formula


@dataclass(frozen=True)
class _Swap:
    where: str
    agent_id: str
    kind: str
    amount_in: int
    amount_out: int
    amount_out_text: str


def replay_rounds(
    initial: Reserves,
    rounds: Sequence[Mapping[str, Any]],
    *,
    fee_bps: int,
    token_decimals: int = 18,
    quote_decimals: int = 18,
) -> list[RoundReplay]:
    """Recompute the reserves after each round from ``initial`` and the rounds' executed swaps.

    Each swap's output is recomputed from its recorded ``amountIn`` with the router formula; a
    recorded ``amountOut`` that differs is reported, and the replay continues with the formula
    value.
    """
    replays = []
    reserves = initial
    for index, rnd in enumerate(rounds):
        n = rnd.get("n", index + 1)
        mismatches = []
        for swap in _executed_swaps(rnd, n, token_decimals, quote_decimals, mismatches):
            apply = apply_buy if swap.kind == "swap_buy" else apply_sell
            try:
                amount_out, reserves = apply(reserves, swap.amount_in, fee_bps)
            except ValueError as error:
                mismatches.append(f"{swap.where}: cannot replay: {error}")
                continue
            if amount_out != swap.amount_out:
                decimals = token_decimals if swap.kind == "swap_buy" else quote_decimals
                mismatches.append(
                    f"{swap.where}: amountOut is {swap.amount_out_text!r}, "
                    f"replayed {format_amount(amount_out, decimals)!r}"
                )
        replays.append(RoundReplay(n=n, reserves=reserves, mismatches=tuple(mismatches)))
    return replays


def check_run_market(run: Mapping[str, Any], initial_reserves: Reserves | None = None) -> list[str]:
    """Mismatches between the replay and the recorded run; an empty list means they agree.

    Compares the replayed ``price``, ``reserve0`` and ``reserve1`` strings (and ``holders`` when
    start balances are recorded) with each round's recorded ``market``, and reports executed swaps
    whose ``amountOut`` differs from the formula. ``initial_reserves`` overrides
    ``world.initialMarket`` as the pool before round 1.
    """
    try:
        world = run["world"]
        pool, token, quote = world["pools"][0], world["token"], world["quote"]
        pair = (pool["token0"].lower(), pool["token1"].lower())
        if pair == (token["address"].lower(), quote["address"].lower()):
            token_is_token0 = True
        elif pair == (quote["address"].lower(), token["address"].lower()):
            token_is_token0 = False
        else:
            return ["world.pools[0] must pair world.token with world.quote"]
        fee_bps, token_decimals, quote_decimals = (
            pool["feeBps"],
            token["decimals"],
            quote["decimals"],
        )
        rounds = run["rounds"]
    except (KeyError, IndexError, TypeError, AttributeError) as error:
        return [f"the run has no readable world and rounds: {error!r}"]
    mismatches: list[str] = []
    initial_market = world.get("initialMarket")
    if initial_reserves is None and initial_market is not None:
        try:
            initial_reserves = _reserves_of(
                initial_market, token_is_token0, token_decimals, quote_decimals
            )
            start = _market_strings(initial_reserves, token_is_token0, token_decimals, quote_decimals)
        except ValueError as error:
            return [f"world.initialMarket is unreadable: {error}"]
        if initial_market.get("price") != start["price"]:
            mismatches.append(
                f"world.initialMarket.price is {initial_market.get('price')!r}, "
                f"replayed {start['price']!r}"
            )
    if not rounds:
        return mismatches
    if initial_reserves is None:
        try:
            initial_reserves = _reserves_before(
                rounds[0], token_is_token0, token_decimals, quote_decimals
            )
        except ValueError as error:
            return [f"cannot reconstruct the reserves before round 1: {error}"]

    replays = replay_rounds(
        initial_reserves,
        rounds,
        fee_bps=fee_bps,
        token_decimals=token_decimals,
        quote_decimals=quote_decimals,
    )
    for rnd, replay in zip(rounds, replays, strict=True):
        mismatches.extend(replay.mismatches)
        try:
            expected = _market_strings(
                replay.reserves, token_is_token0, token_decimals, quote_decimals
            )
        except ValueError as error:
            mismatches.append(f"round {replay.n}: cannot format the replayed market: {error}")
            continue
        recorded = rnd.get("market") or {}
        for key in MARKET_KEYS:
            if recorded.get(key) != expected[key]:
                mismatches.append(
                    f"round {replay.n}: market.{key} is {recorded.get(key)!r}, "
                    f"replayed {expected[key]!r}"
                )
    mismatches.extend(_check_balances(run, token_decimals, quote_decimals))
    return mismatches


def _check_balances(run: Mapping[str, Any], token_decimals: int, quote_decimals: int) -> list[str]:
    """Track each agent's tokens and ETH from its start balances through its executed swaps and
    check ``holders`` before and after every round. Skipped when start balances are absent."""
    agents = (run.get("crowd") or {}).get("agents") or []
    if not agents or any("startTokens" not in a or "startEth" not in a for a in agents):
        return []
    try:
        tokens = {a["agentId"]: to_base_units(a["startTokens"], token_decimals) for a in agents}
        eth = {a["agentId"]: to_base_units(a["startEth"], quote_decimals) for a in agents}
    except (KeyError, TypeError, ValueError) as error:
        return [f"crowd.agents start balances are unreadable: {error}"]
    problems: list[str] = []
    initial_market = run["world"].get("initialMarket")
    if initial_market is not None:
        _compare_holders("world.initialMarket", initial_market, tokens, problems)
    for index, rnd in enumerate(run["rounds"]):
        n = rnd.get("n", index + 1)
        for swap in _executed_swaps(rnd, n, token_decimals, quote_decimals, []):
            if swap.agent_id not in tokens:
                problems.append(f"{swap.where}: agent {swap.agent_id!r} is not in crowd.agents")
                continue
            if swap.kind == "swap_buy":
                eth[swap.agent_id] -= swap.amount_in
                tokens[swap.agent_id] += swap.amount_out
            else:
                tokens[swap.agent_id] -= swap.amount_in
                eth[swap.agent_id] += swap.amount_out
            if eth[swap.agent_id] < 0 or tokens[swap.agent_id] < 0:
                problems.append(f"{swap.where}: spends more than the agent holds")
        _compare_holders(f"round {n}: market", rnd.get("market") or {}, tokens, problems)
    return problems


def _compare_holders(
    where: str, market: Mapping[str, Any], tokens: Mapping[str, int], problems: list[str]
) -> None:
    holders = sum(balance > 0 for balance in tokens.values())
    if market.get("holders") != holders:
        problems.append(f"{where}.holders is {market.get('holders')!r}, tracked {holders}")


def _reserves_of(
    market: Mapping[str, Any], token_is_token0: bool, token_decimals: int, quote_decimals: int
) -> Reserves:
    """A market object's reserves as ``Reserves`` (token, quote) in base units."""
    decimals0, decimals1 = (
        (token_decimals, quote_decimals) if token_is_token0 else (quote_decimals, token_decimals)
    )
    try:
        reserve0 = to_base_units(market["reserve0"], decimals0)
        reserve1 = to_base_units(market["reserve1"], decimals1)
    except (KeyError, TypeError) as error:
        raise ValueError(f"reserves are unreadable: {error!r}") from error
    token, quote = (reserve0, reserve1) if token_is_token0 else (reserve1, reserve0)
    return Reserves(token=token, quote=quote)


def _executed_swaps(
    rnd: Mapping[str, Any],
    n: int,
    token_decimals: int,
    quote_decimals: int,
    mismatches: list[str],
) -> Iterator[_Swap]:
    """The round's ``ok`` swaps in order; unreadable amounts are reported and skipped."""
    for index, action in enumerate(rnd.get("actions") or ()):
        if action.get("status") != "ok" or action.get("kind") not in SWAP_KINDS:
            continue
        kind = action["kind"]
        where = f"round {n} actions[{index}] ({action.get('agentId')})"
        in_decimals, out_decimals = (
            (quote_decimals, token_decimals)
            if kind == "swap_buy"
            else (token_decimals, quote_decimals)
        )
        try:
            amount_in = to_base_units(action["amountIn"], in_decimals)
            amount_out = to_base_units(action["amountOut"], out_decimals)
        except (KeyError, TypeError, ValueError) as error:
            mismatches.append(f"{where}: unreadable amounts: {error}")
            continue
        yield _Swap(
            where, str(action.get("agentId")), kind, amount_in, amount_out, action["amountOut"]
        )


def _market_strings(
    reserves: Reserves, token_is_token0: bool, token_decimals: int, quote_decimals: int
) -> dict[str, str]:
    """The ``price``/``reserve0``/``reserve1`` strings the engine records for ``reserves``."""
    if token_is_token0:
        reserve0, reserve1 = reserves.token, reserves.quote
    else:
        reserve0, reserve1 = reserves.quote, reserves.token
    market = MarketState.from_reserves(
        block_number=0,
        reserve0=reserve0,
        reserve1=reserve1,
        token_is_token0=token_is_token0,
        token_decimals=token_decimals,
        quote_decimals=quote_decimals,
    ).to_run_market()
    return {key: market[key] for key in MARKET_KEYS}


def _reserves_before(
    rnd: Mapping[str, Any], token_is_token0: bool, token_decimals: int, quote_decimals: int
) -> Reserves:
    """Undo a round's recorded swaps, newest first, from its recorded market."""
    try:
        start = _reserves_of(rnd.get("market") or {}, token_is_token0, token_decimals, quote_decimals)
    except ValueError as error:
        raise ValueError(f"round 1 market {error}") from error
    token, quote = start.token, start.quote
    problems: list[str] = []
    swaps = list(_executed_swaps(rnd, 1, token_decimals, quote_decimals, problems))
    if problems:
        raise ValueError("; ".join(problems))
    for swap in reversed(swaps):
        if swap.kind == "swap_buy":
            token, quote = token + swap.amount_out, quote - swap.amount_in
        else:
            token, quote = token - swap.amount_in, quote + swap.amount_out
    if token <= 0 or quote <= 0:
        raise ValueError(f"undoing round 1 gives non-positive reserves ({token}, {quote})")
    return Reserves(token=token, quote=quote)
