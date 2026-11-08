from __future__ import annotations

import pytest

from hyvo.runfile.models import Market as RunMarket
from hyvo.world.amm import Reserves
from hyvo.world.state import AgentBalances, MarketState, SwapKind, SwapRecord

E18 = 10**18
TX = "0x" + "ab" * 32


def _swap(kind: SwapKind, amount_in: int, amount_out: int) -> SwapRecord:
    return SwapRecord("a07", "0x" + "11" * 20, kind, amount_in, amount_out, TX, 9)


@pytest.mark.parametrize("token_is_token0", [True, False])
def test_from_reserves_maps_token0_and_token1(token_is_token0):
    token, quote = 1_000_000 * E18, 100 * E18
    reserve0, reserve1 = (token, quote) if token_is_token0 else (quote, token)
    state = MarketState.from_reserves(
        block_number=12,
        reserve0=reserve0,
        reserve1=reserve1,
        token_is_token0=token_is_token0,
        holders=["0x" + "22" * 20],
    )
    assert state.reserves == Reserves(token=token, quote=quote)
    assert (state.reserve0_raw, state.reserve1_raw) == (reserve0, reserve1)
    assert state.price == "0.0001"
    assert state.to_run_market() == {
        "price": "0.0001",
        "reserve0": "1000000" if token_is_token0 else "100",
        "reserve1": "100" if token_is_token0 else "1000000",
        "holders": 1,
    }
    RunMarket.model_validate(state.to_run_market())


def test_to_prompt_dict_is_compact_and_in_whole_units():
    state = MarketState.from_reserves(
        block_number=40,
        reserve0=101 * E18,
        reserve1=990_000 * E18,
        token_is_token0=False,
        recent_swaps=[
            _swap("swap_buy", E18 // 2, 4960 * E18),
            _swap("swap_sell", 500 * E18, E18 // 20),
        ],
    )
    assert state.to_prompt_dict() == {
        "block": 40,
        "price_eth_per_token": "0.000102020202020202",
        "reserve_eth": "101",
        "reserve_token": "990000",
        "holders": 0,
        "recent_swaps": [
            {"agent": "a07", "kind": "swap_buy", "eth": "0.5", "token": "4960"},
            {"agent": "a07", "kind": "swap_sell", "eth": "0.05", "token": "500"},
        ],
    }


def test_the_price_needs_equal_decimals():
    with pytest.raises(ValueError, match="same decimals"):
        MarketState.from_reserves(
            block_number=1, reserve0=1, reserve1=1, token_is_token0=True, quote_decimals=6
        )


def test_swap_record_sides_and_balances_dict():
    buy, sell = _swap("swap_buy", 3, 70), _swap("swap_sell", 70, 2)
    assert (buy.eth, buy.tokens) == (3, 70)
    assert (sell.eth, sell.tokens) == (2, 70)
    assert AgentBalances(eth=15 * E18 // 10, token=0).to_dict() == {"eth": "1.5", "token": "0"}
