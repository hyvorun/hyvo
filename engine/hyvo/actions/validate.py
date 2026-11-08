"""Server-side validation of a market action against an agent's balances and the run's limits.

An action that fails becomes ``Hold`` with a note saying why; the engine records it with status
``invalid`` (docs/RUN_FORMAT.md). ``min_trade_eth`` applies to buys: a sell's ETH value depends on
the pool, and a sell that rounds down to zero tokens is rejected instead.
"""

from __future__ import annotations

from decimal import Decimal

from hyvo.actions.models import (
    ActionLimits,
    CheckMarket,
    Hold,
    MarketAction,
    SwapBuy,
    SwapSell,
)
from hyvo.world.state import AgentBalances
from hyvo.world.units import ETH_DECIMALS, format_amount, to_base_units


def validate(
    action: MarketAction, balances: AgentBalances, limits: ActionLimits
) -> tuple[MarketAction, str | None]:
    """``(action, None)`` when the action may execute, else ``(Hold(), note)``."""
    if isinstance(action, SwapBuy):
        note = _buy_problem(action.amount_eth, balances, limits)
    elif isinstance(action, SwapSell):
        note = _sell_problem(action.fraction, balances)
    elif isinstance(action, (Hold, CheckMarket)):
        note = None
    else:
        note = f"unknown market action {type(action).__name__}"
    return (action, None) if note is None else (Hold(), note)


def sell_amount(holdings: int, fraction: Decimal) -> int:
    """The token base units a ``swap_sell`` of ``fraction`` sends: ``floor(holdings * fraction)``.

    Works on the decimal digits directly, so a tiny fraction such as ``1E-999999999`` is cheap.
    """
    if not fraction.is_finite() or not 0 < fraction <= 1:
        raise ValueError(f"fraction must be in (0, 1], got {fraction}")
    _, digits, exponent = fraction.as_tuple()
    scaled = holdings * int("".join(map(str, digits)))
    shift = -int(exponent)  # 0 < fraction <= 1, so the exponent is <= 0
    if shift > len(str(scaled)):
        return 0
    return scaled // 10**shift


def _buy_problem(amount: Decimal, balances: AgentBalances, limits: ActionLimits) -> str | None:
    if not amount.is_finite() or amount <= 0:
        return f"swap_buy amount_eth must be > 0, got {amount}"
    if amount < limits.min_trade_eth:
        return f"swap_buy of {amount} ETH is below the minimum trade of {limits.min_trade_eth} ETH"
    if amount > limits.per_agent_cap_eth:
        return (
            f"swap_buy of {amount} ETH is above the per-agent cap of {limits.per_agent_cap_eth} ETH"
        )
    try:
        wei = to_base_units(amount, ETH_DECIMALS)
    except ValueError:
        return f"swap_buy amount_eth {amount} has more than {ETH_DECIMALS} decimal places"
    available = max(balances.eth - limits.keep_wei, 0)
    if wei > available:
        return (
            f"swap_buy of {amount} ETH exceeds the available "
            f"{format_amount(available, ETH_DECIMALS)} ETH"
        )
    return None


def _sell_problem(fraction: Decimal, balances: AgentBalances) -> str | None:
    if not fraction.is_finite() or not 0 < fraction <= 1:
        return f"swap_sell fraction must be in (0, 1], got {fraction}"
    if balances.token <= 0:
        return "swap_sell with no tokens to sell"
    if sell_amount(balances.token, fraction) == 0:
        return f"swap_sell fraction {fraction} of the holdings rounds down to 0 tokens"
    return None
