from __future__ import annotations

import pytest
from eth_utils import is_checksum_address

from hyvo.world.amm import spot_value
from hyvo.world.market import MAX_UINT256
from hyvo.world.wallets import AgentPnL, Wallets, agent_address

E18 = 10**18


def test_agent_addresses_are_deterministic_and_pinned():
    # Pinned: replays and verifiers rely on the same seed giving the same addresses.
    assert agent_address("run_01JC8Z6Q3W1Y2V9K7T5R4N3M2P", "a01") == (
        "0xF785043fA9720A167FbaB4Cd293fD082ecbB9550"
    )
    assert (
        agent_address(7, "a07")
        == agent_address("7", "a07")
        == "0x09c5cfD588881339A60A38f92e6396F7B7B77Af4"
    )


def test_agent_addresses_differ_by_seed_and_agent():
    addresses = {agent_address("seed", f"a{n:04d}") for n in range(1000)}
    assert len(addresses) == 1000
    assert all(is_checksum_address(address) for address in addresses)
    assert agent_address("seed", "a01") != agent_address("seed2", "a01")


@pytest.mark.parametrize(("seed", "agent_id"), [(None, "a01"), (True, "a01"), (1.5, "a01")])
def test_agent_address_rejects_bad_seeds(seed, agent_id):
    with pytest.raises(TypeError):
        agent_address(seed, agent_id)


def test_agent_address_needs_an_agent_id():
    with pytest.raises(ValueError):
        agent_address("seed", "")


def test_pnl_is_marked_to_market():
    pnl = AgentPnL(eth_spent=5, eth_received=2, token_balance=9, token_value=4, seed_value=0)
    assert pnl.pnl == 1
    loss = AgentPnL(eth_spent=E18, eth_received=0, token_balance=0, token_value=0, seed_value=0)
    assert loss.to_dict()["pnl_eth"] == "-1"


@pytest.mark.anvil
def test_add_funds_seeds_and_approves(market):
    wallets = Wallets(market, run_seed="wallets")
    wallet = wallets.add("a01", eth="1.5", tokens="250")
    assert wallet.address == agent_address("wallets", "a01")
    balances = wallets.balances("a01")
    assert (balances.eth, balances.token) == (15 * 10**17, 250 * E18)
    allowance = market.token.functions.allowance(wallet.address, market.addresses.router).call()
    assert allowance == MAX_UINT256
    assert market.agent_addresses == (wallet.address,)
    assert "a01" in wallets and len(wallets) == 1 and list(wallets) == [wallet]
    with pytest.raises(ValueError, match="already has a wallet"):
        wallets.add("a01", eth="1")
    with pytest.raises(ValueError):
        wallets.add("a02", eth="0.0000000000000000001")  # finer than one wei


@pytest.mark.anvil
def test_pnl_follows_the_swap_log(market):
    wallets = Wallets(market, run_seed="pnl")
    trader = wallets.add("a01", eth="2")
    holder = wallets.add("a02", eth="0", tokens="1000")
    start = market.reserves()
    assert wallets.pnl("a02", start).seed_value == spot_value(1000 * E18, start)
    assert wallets.pnl("a02", start).pnl == 0

    bought = market.buy(trader.address, E18, 0)
    sold = market.sell(trader.address, bought.amount_out // 2, 0)
    now = market.reserves()
    pnl = wallets.pnl("a01", now)
    remaining = bought.amount_out - bought.amount_out // 2
    assert (pnl.eth_spent, pnl.eth_received, pnl.token_balance) == (E18, sold.amount_out, remaining)
    assert pnl.token_value == spot_value(remaining, now)
    assert pnl.pnl == sold.amount_out - E18 + pnl.token_value
    # gas is free, so the ETH balance is exactly start - spent + received
    assert wallets.balances("a01").eth == 2 * E18 - pnl.eth_spent + pnl.eth_received
    assert wallets.pnl("a02").pnl == spot_value(1000 * E18, now) - spot_value(1000 * E18, start)
    assert set(wallets.pnl("a01").to_dict()) == {
        "eth_spent",
        "eth_received",
        "token_value_eth",
        "pnl_eth",
    }
    assert holder.address in market.state().holders
