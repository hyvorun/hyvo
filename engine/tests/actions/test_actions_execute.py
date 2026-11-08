from __future__ import annotations

import re
from decimal import Decimal

import pytest

from hyvo.actions.execute import execute, min_output
from hyvo.actions.models import (
    ActionLimits,
    ActionRecord,
    CheckMarket,
    Hold,
    SwapBuy,
    SwapSell,
)
from hyvo.runfile.models import Action
from hyvo.world.amm import get_amount_out
from hyvo.world.units import format_amount

E18 = 10**18
LIMITS = ActionLimits(Decimal(1))
TX_HASH = re.compile(r"0x[0-9a-f]{64}")


def test_min_output_applies_the_slippage_limit():
    assert min_output(10_000, 500) == 9_500
    assert min_output(9_999, 500) == 9_499  # rounds down
    assert min_output(123, 0) == 123
    assert min_output(123, 10_000) == 0


@pytest.mark.anvil
def test_a_buy_records_the_amounts_of_the_chain(market, wallets):
    agent = wallets.add("a01", eth="2")
    decision = market.state()
    record = execute(market, agent, SwapBuy(amount_eth=Decimal("0.75")), decision.reserves, LIMITS)
    tokens = get_amount_out(75 * 10**16, decision.reserve_quote, decision.reserve_token, 30)
    assert record.tx_hash is not None and TX_HASH.fullmatch(record.tx_hash)
    assert record.to_dict() == {
        "agentId": "a01",
        "kind": "swap_buy",
        "amountIn": "0.75",
        "amountOut": format_amount(tokens, 18),
        "txHash": record.tx_hash,
        "status": "ok",
        "note": None,
    }
    assert wallets.balances("a01").token == tokens
    assert wallets.balances("a01").eth == 2 * E18 - 75 * 10**16
    Action.model_validate(record.to_dict())


@pytest.mark.anvil
def test_a_sell_sends_the_floor_of_the_fraction(market, wallets):
    agent = wallets.add("a02", eth="0", tokens="333.333333333333333333")
    holdings = market.token_balance(agent.address)
    decision = market.state()
    record = execute(market, agent, SwapSell(fraction=Decimal("0.3")), decision.reserves, LIMITS)
    sent = holdings * 3 // 10
    eth_out = get_amount_out(sent, decision.reserve_token, decision.reserve_quote, 30)
    assert (record.status, record.amount_in) == ("ok", format_amount(sent, 18))
    assert record.amount_out == format_amount(eth_out, 18)
    assert market.token_balance(agent.address) == holdings - sent
    assert market.eth_balance(agent.address) == eth_out


@pytest.mark.anvil
@pytest.mark.parametrize("action", [Hold(), CheckMarket()])
def test_hold_and_check_market_send_no_transaction(market, wallets, action):
    agent = wallets.add("a03", eth="1")
    block = market.w3.eth.block_number
    record = execute(market, agent, action, market.state().reserves, LIMITS)
    assert record == ActionRecord.no_tx("a03", action.kind)
    assert market.w3.eth.block_number == block


@pytest.mark.anvil
def test_invalid_actions_become_hold_without_a_transaction(market, wallets):
    agent = wallets.add("a04", eth="0.5")
    reserves = market.state().reserves
    block = market.w3.eth.block_number
    over_cap = execute(market, agent, SwapBuy(amount_eth=Decimal(2)), reserves, LIMITS)
    no_tokens = execute(market, agent, SwapSell(fraction=Decimal(1)), reserves, LIMITS)
    too_much = execute(market, agent, SwapBuy(amount_eth=Decimal("0.6")), reserves, LIMITS)
    assert over_cap == ActionRecord.invalid(
        "a04", "swap_buy of 2 ETH is above the per-agent cap of 1 ETH"
    )
    assert no_tokens == ActionRecord.invalid("a04", "swap_sell with no tokens to sell")
    assert too_much == ActionRecord.invalid(
        "a04", "swap_buy of 0.6 ETH exceeds the available 0.5 ETH"
    )
    assert market.w3.eth.block_number == block


@pytest.mark.anvil
def test_a_buy_slippage_revert_is_recorded_with_its_tx_hash(market, wallets):
    early, late = wallets.add("a05", eth="10"), wallets.add("a06", eth="1")
    limits = ActionLimits(Decimal(10), max_slippage_bps=100)
    decision = market.state()  # both decide at the round start
    assert (
        execute(market, early, SwapBuy(amount_eth=Decimal(5)), decision.reserves, limits).status
        == "ok"
    )
    moved = market.reserves()
    record = execute(market, late, SwapBuy(amount_eth=Decimal(1)), decision.reserves, limits)

    expected = get_amount_out(E18, decision.reserve_quote, decision.reserve_token, 30)
    actual = get_amount_out(E18, moved.quote, moved.token, 30)
    assert (record.kind, record.status, record.amount_in, record.amount_out) == (
        "swap_buy",
        "reverted",
        "1",
        None,
    )
    assert record.tx_hash is not None and TX_HASH.fullmatch(record.tx_hash)
    assert record.note == (
        f"reverted: InsufficientOutput(amountOut={actual}, "
        f"amountOutMin={min_output(expected, 100)})"
    )
    assert market.w3.eth.get_transaction_receipt(record.tx_hash)["status"] == 0
    assert market.reserves() == moved
    assert market.eth_balance(late.address) == E18  # nothing moved, not even gas
    Action.model_validate(record.to_dict())


@pytest.mark.anvil
def test_a_sell_slippage_revert_keeps_the_tokens(market, wallets):
    early = wallets.add("a07", eth="0", tokens="200000")
    late = wallets.add("a08", eth="0", tokens="1000")
    limits = ActionLimits(Decimal(1), max_slippage_bps=100)
    decision = market.state()
    assert (
        execute(market, early, SwapSell(fraction=Decimal(1)), decision.reserves, limits).status
        == "ok"
    )
    record = execute(market, late, SwapSell(fraction=Decimal(1)), decision.reserves, limits)
    assert (record.status, record.amount_in) == ("reverted", "1000")
    assert record.note is not None and record.note.startswith("reverted: InsufficientOutput(")
    assert market.token_balance(late.address) == 1000 * E18
