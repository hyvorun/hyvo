from __future__ import annotations

import re

import pytest
from eth_utils import to_checksum_address

from hyvo.runfile.models import World
from hyvo.world.amm import Reserves, apply_buy, apply_sell, get_amount_out
from hyvo.world.market import DEPLOYER, MAX_UINT256, Market, MarketConfig, MarketError
from hyvo.world.wallets import Wallets

E18 = 10**18
TRADER = to_checksum_address("0x" + "77" * 20)
TX_HASH = re.compile(r"0x[0-9a-f]{64}")


def funded_trader(market: Market, eth: int = 100 * E18) -> str:
    market.set_eth_balance(TRADER, eth)
    market.approve_router(TRADER)
    return TRADER


@pytest.mark.anvil
def test_deploy_seeds_the_pool_and_describes_the_world(market):
    world = market.run_world(market.state().to_run_market())
    World.model_validate(world)  # the run.json model of packages/schema's Python twin
    pool = world["pools"][0]
    assert world["chainId"] == 4663 and world["forkBlock"] is None
    assert pool == {
        "address": market.addresses.pair,
        "token0": market.token0,
        "token1": market.token1,
        "kind": "v2-test",
        "feeBps": 30,
    }
    assert sorted([pool["token0"], pool["token1"]], key=str.lower) == [
        pool["token0"],
        pool["token1"],
    ]
    assert {pool["token0"], pool["token1"]} == {market.addresses.token, market.addresses.weth}
    assert world["token"] == {
        "address": market.addresses.token,
        "symbol": "HYVX",
        "name": "Hyvo Test Token",
        "decimals": 18,
    }
    assert world["quote"] == {"address": market.addresses.weth, "symbol": "WETH", "decimals": 18}
    for address in (pool["address"], pool["token0"], pool["token1"], market.addresses.router):
        assert to_checksum_address(address) == address

    assert market.reserves() == Reserves(token=1_000_000 * E18, quote=100 * E18)
    state = market.state()
    assert state.price == "0.0001" and state.holders == ()
    # the deployer put everything into the pool and holds only LP shares
    assert market.balances(DEPLOYER).eth == 0 and market.balances(DEPLOYER).token == 0
    assert market.pair.functions.balanceOf(DEPLOYER).call() > 0


@pytest.mark.anvil
def test_the_first_buy_matches_the_contract_reference_vector(market):
    result = market.buy(funded_trader(market), E18, 0)
    assert (result.status, result.amount_out) == ("ok", 9871580343970612988504)


@pytest.mark.anvil
@pytest.mark.parametrize("fee_bps", [0, 30, 1000])
def test_swaps_move_the_reserves_exactly_by_the_router_formula(anvil, fee_bps):
    market = Market.deploy(anvil, MarketConfig(fee_bps=fee_bps))
    trader = funded_trader(market)
    expected = market.reserves()
    for eth_in in (E18, 3 * 10**17, 7 * E18 + 1, 12_345):
        k = expected.token * expected.quote
        assert market.quote_buy(eth_in) == get_amount_out(
            eth_in, expected.quote, expected.token, fee_bps
        )
        tokens_out, expected = apply_buy(expected, eth_in, fee_bps)
        result = market.buy(trader, eth_in, min_out=tokens_out)  # the exact output is accepted
        assert (result.status, result.amount_in, result.amount_out) == ("ok", eth_in, tokens_out)
        assert market.reserves() == expected
        assert expected.token * expected.quote >= k
    holdings = market.token_balance(trader)
    for tokens_in in (holdings // 3, holdings // 5 + 1, 10**21 + 7):
        assert market.quote_sell(tokens_in) == get_amount_out(
            tokens_in, expected.token, expected.quote, fee_bps
        )
        eth_out, expected = apply_sell(expected, tokens_in, fee_bps)
        result = market.sell(trader, tokens_in, min_out=eth_out)
        assert (result.status, result.amount_in, result.amount_out) == ("ok", tokens_in, eth_out)
        assert market.reserves() == expected
    reserve0, reserve1, _ = market.pair.functions.getReserves().call()
    assert market.state().reserves == expected
    assert (reserve0, reserve1) == (
        (expected.token, expected.quote)
        if market.token_is_token0
        else (expected.quote, expected.token)
    )


@pytest.mark.anvil
def test_a_swap_below_its_minimum_reverts_but_is_mined(market):
    trader = funded_trader(market, eth=5 * E18)
    reserves, swaps = market.reserves(), market.swaps
    quote = market.quote_buy(E18)
    result = market.buy(trader, E18, quote + 1)  # one unit more than the exact output
    assert result.status == "reverted" and result.amount_out is None
    assert TX_HASH.fullmatch(result.tx_hash)
    assert (
        result.revert_reason == f"InsufficientOutput(amountOut={quote}, amountOutMin={quote + 1})"
    )
    assert market.w3.eth.get_transaction_receipt(result.tx_hash)["status"] == 0
    assert market.reserves() == reserves and market.swaps == swaps
    assert market.eth_balance(trader) == 5 * E18  # a reverted swap costs nothing

    market.buy(trader, E18, 0)
    tokens = market.token_balance(trader)
    eth_quote = market.quote_sell(tokens)
    result = market.sell(trader, tokens, eth_quote + 1)
    assert result.status == "reverted"
    assert (
        result.revert_reason
        == f"InsufficientOutput(amountOut={eth_quote}, amountOutMin={eth_quote + 1})"
    )
    assert market.token_balance(trader) == tokens


@pytest.mark.anvil
def test_a_sell_that_outputs_nothing_reverts(market):
    trader = funded_trader(market)
    market.buy(trader, E18, 0)
    result = market.sell(trader, 1, 0)  # one base unit is worth less than one wei
    assert result.status == "reverted"
    assert result.revert_reason == "InsufficientOutput(amountOut=0, amountOutMin=0)"


@pytest.mark.anvil
def test_balances_move_only_through_trades(market):
    trader = funded_trader(market, eth=3 * E18)
    assert market.eth_balance(trader) == 3 * E18  # the approval was free
    bought = market.buy(trader, E18, 0)
    assert market.balances(trader).eth == 2 * E18
    assert market.balances(trader).token == bought.amount_out
    sold = market.sell(trader, bought.amount_out, 0)
    assert market.balances(trader).eth == 2 * E18 + sold.amount_out
    assert market.balances(trader).token == 0


@pytest.mark.anvil
def test_both_token_orders_map_the_reserves(anvil):
    seen: dict[bool, Market] = {}
    for _ in range(12):  # deterministic deployer nonces, so this ends quickly
        market = Market.deploy(anvil)
        seen.setdefault(market.token_is_token0, market)
        if len(seen) == 2:
            break
    assert set(seen) == {True, False}
    for market in seen.values():
        market.buy(funded_trader(market), 2 * E18, 0)
        state = market.state()
        reserve0, reserve1, _ = market.pair.functions.getReserves().call()
        assert (state.reserve0_raw, state.reserve1_raw) == (reserve0, reserve1)
        token_side = reserve0 if market.token_is_token0 else reserve1
        assert state.reserve_token == token_side == market.reserves().token
        assert market.token0 == (
            market.addresses.token if market.token_is_token0 else market.addresses.weth
        )


@pytest.mark.anvil
def test_state_counts_agent_holders_and_lists_recent_swaps(market):
    wallets = Wallets(market, run_seed="holders")
    seeded = wallets.add("a01", eth="1", tokens="500")
    buyer = wallets.add("a02", eth="1")
    wallets.add("a03", eth="1")
    assert market.state().holders == (seeded.address,)

    first = market.buy(buyer.address, E18 // 10, 0)
    market.buy(funded_trader(market), E18, 0)  # not an agent: never counted as a holder
    state = market.state()
    assert state.holders == (seeded.address, buyer.address)
    assert state.to_run_market()["holders"] == 2

    market.sell(seeded.address, market.token_balance(seeded.address), 0)  # sells everything
    state = market.state(recent=2)
    assert state.holders == (buyer.address,)
    assert state.block_number == market.w3.eth.block_number
    assert [(swap.agent_id, swap.kind) for swap in state.recent_swaps] == [
        (None, "swap_buy"),
        ("a01", "swap_sell"),
    ]
    assert market.swaps[0].tx_hash == first.tx_hash
    assert market.state(recent=0).recent_swaps == ()


@pytest.mark.anvil
def test_rejects_bad_amounts_and_unfunded_transactions(market):
    with pytest.raises(ValueError):
        market.buy(TRADER, 0, 0)
    with pytest.raises(ValueError):
        market.sell(TRADER, 1, -1)
    with pytest.raises(ValueError):
        market.quote_sell(0)
    market.set_eth_balance(TRADER, 10)
    with pytest.raises(MarketError, match="rejected"):
        market.buy(TRADER, E18, 0)  # more ETH than it holds: the node refuses to send it
    with pytest.raises(ValueError, match="already registered"):
        market.register_agent("a01", TRADER)
        market.register_agent("a02", TRADER)


@pytest.mark.anvil
def test_router_approval_is_unlimited(market):
    funded_trader(market)
    assert market.token.functions.allowance(TRADER, market.addresses.router).call() == MAX_UINT256


@pytest.mark.parametrize(
    "kwargs",
    [
        {"fee_bps": 1001},
        {"fee_bps": -1},
        {"liquidity_eth": "0"},
        {"liquidity_tokens": "0.0000000000000000001"},
        {"token_symbol": " "},
    ],
)
def test_market_config_rejects_bad_values(kwargs):
    with pytest.raises((ValueError, TypeError)):
        MarketConfig(**kwargs)


def test_market_config_converts_liquidity_to_base_units():
    config = MarketConfig(liquidity_eth="2.5", liquidity_tokens="1000")
    assert (config.liquidity_wei, config.liquidity_token_units) == (25 * 10**17, 1000 * E18)
