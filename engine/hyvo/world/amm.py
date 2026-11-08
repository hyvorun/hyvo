"""Constant-product swap math of ``HyvoV2Router`` in exact integers (chain/README.md, "Swap math").

With ``in_with_fee = amountIn * (10000 - fee)`` and the reserves from before the swap,
``amountOut = in_with_fee * reserveOut // (reserveIn * 10000 + in_with_fee)``. The router outputs
exactly this, so the engine can replay recorded swaps without a node.
"""

from __future__ import annotations

from dataclasses import dataclass

BPS = 10_000
MAX_FEE_BPS = 1_000  # the highest fee a HyvoV2Pair accepts


@dataclass(frozen=True)
class Reserves:
    """Pool reserves in base units: the traded token and the quote asset (WETH)."""

    token: int
    quote: int


def get_amount_out(amount_in: int, reserve_in: int, reserve_out: int, fee_bps: int) -> int:
    """``HyvoV2Router.getAmountOut``: the output of swapping ``amount_in``, rounded down.

    Raises ``ValueError`` where the contract reverts: a zero input (``ZeroAmount``), an empty
    reserve (``InsufficientLiquidity``) or a fee above 1000 bps (``FeeTooHigh``).
    """
    if amount_in <= 0:
        raise ValueError(f"amount_in must be > 0, got {amount_in}")
    if reserve_in <= 0 or reserve_out <= 0:
        raise ValueError(f"reserves must be > 0, got {reserve_in} and {reserve_out}")
    if not 0 <= fee_bps <= MAX_FEE_BPS:
        raise ValueError(f"fee_bps must be in 0..{MAX_FEE_BPS}, got {fee_bps}")
    amount_in_with_fee = amount_in * (BPS - fee_bps)
    return amount_in_with_fee * reserve_out // (reserve_in * BPS + amount_in_with_fee)


def apply_buy(reserves: Reserves, eth_in: int, fee_bps: int) -> tuple[int, Reserves]:
    """Tokens received for ``eth_in`` wei, and the reserves after that swap."""
    tokens_out = get_amount_out(eth_in, reserves.quote, reserves.token, fee_bps)
    return tokens_out, Reserves(token=reserves.token - tokens_out, quote=reserves.quote + eth_in)


def apply_sell(reserves: Reserves, tokens_in: int, fee_bps: int) -> tuple[int, Reserves]:
    """Wei received for ``tokens_in`` base units, and the reserves after that swap."""
    eth_out = get_amount_out(tokens_in, reserves.token, reserves.quote, fee_bps)
    return eth_out, Reserves(token=reserves.token + tokens_in, quote=reserves.quote - eth_out)


def spot_value(tokens: int, reserves: Reserves) -> int:
    """Wei value of ``tokens`` at the pool's spot price (no fee, no price impact), rounded down."""
    if reserves.token <= 0:
        raise ValueError("the spot price needs a token reserve > 0")
    return tokens * reserves.quote // reserves.token
