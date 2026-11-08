"""Execute one market action in the world and record it as a run.json ``actions[]`` entry.

The minimum output of a swap is the output expected at the reserves the agent saw when it decided
(the round start), less ``max_slippage_bps``. If the pool moved further before the swap, the router
reverts; the transaction is still mined, so the record has status ``reverted`` and a ``txHash``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from hyvo.actions.models import (
    ActionLimits,
    ActionRecord,
    MarketAction,
    SwapBuy,
    SwapSell,
)
from hyvo.actions.validate import sell_amount, validate
from hyvo.world.amm import BPS, Reserves, get_amount_out
from hyvo.world.units import ETH_DECIMALS, format_amount, to_base_units

if TYPE_CHECKING:
    from hyvo.world.market import Market, TxResult
    from hyvo.world.wallets import AgentWallet


def min_output(expected_out: int, max_slippage_bps: int) -> int:
    """The least output a swap accepts: ``expected_out * (10000 - max_slippage_bps) // 10000``."""
    return expected_out * (BPS - max_slippage_bps) // BPS


def execute(
    market: Market,
    agent: AgentWallet,
    action: MarketAction,
    decision_reserves: Reserves,
    limits: ActionLimits,
) -> ActionRecord:
    """Validate ``action`` against the agent's balances now, then run it.

    ``swap_buy`` and ``swap_sell`` send one transaction (a sell sends ``floor(holdings * fraction)``
    tokens); ``hold`` and ``check_market`` send none and are recorded with status ``ok``; an action
    that fails validation is recorded as ``hold`` with status ``invalid``.
    """
    balances = market.balances(agent.address)
    action, note = validate(action, balances, limits)
    if note is not None:
        return ActionRecord.invalid(agent.agent_id, note)

    if isinstance(action, SwapBuy):
        eth_in = to_base_units(action.amount_eth, ETH_DECIMALS)
        expected = get_amount_out(
            eth_in, decision_reserves.quote, decision_reserves.token, market.fee_bps
        )
        result = market.buy(agent.address, eth_in, min_output(expected, limits.max_slippage_bps))
        return _swap_record(agent.agent_id, "swap_buy", result, ETH_DECIMALS, market.token_decimals)

    if isinstance(action, SwapSell):
        tokens_in = sell_amount(balances.token, action.fraction)
        expected = get_amount_out(
            tokens_in, decision_reserves.token, decision_reserves.quote, market.fee_bps
        )
        result = market.sell(
            agent.address, tokens_in, min_output(expected, limits.max_slippage_bps)
        )
        return _swap_record(
            agent.agent_id, "swap_sell", result, market.token_decimals, ETH_DECIMALS
        )

    return ActionRecord.no_tx(agent.agent_id, action.kind)


def _swap_record(
    agent_id: str,
    kind: Literal["swap_buy", "swap_sell"],
    result: TxResult,
    in_decimals: int,
    out_decimals: int,
) -> ActionRecord:
    if result.status == "ok" and result.amount_out is not None:
        amount_out: str | None = format_amount(result.amount_out, out_decimals)
        note = None
    else:
        amount_out, note = None, f"reverted: {result.revert_reason}"
    return ActionRecord(
        agent_id=agent_id,
        kind=kind,
        amount_in=format_amount(result.amount_in, in_decimals),
        amount_out=amount_out,
        tx_hash=result.tx_hash,
        status=result.status,
        note=note,
    )
