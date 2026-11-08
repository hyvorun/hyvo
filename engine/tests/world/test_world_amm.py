from __future__ import annotations

import random

import pytest

from hyvo.world.amm import Reserves, apply_buy, apply_sell, get_amount_out, spot_value

E18 = 10**18


@pytest.mark.parametrize(
    ("amount_in", "reserve_in", "reserve_out", "fee_bps", "expected"),
    [  # reference vectors of chain/README.md and test/test-assets/HyvoV2Router.t.sol
        (E18, 100 * E18, 1_000_000 * E18, 30, 9871580343970612988504),
        (E18, 100 * E18, 1_000_000 * E18, 0, 9900990099009900990099),
        (E18, 100 * E18, 1_000_000 * E18, 1000, 8919722497522299306243),
        (10_000 * E18, 1_000_000 * E18, 100 * E18, 30, 987158034397061298),
        (1, 10**24, 10**20, 30, 0),  # dust rounds down to nothing
    ],
)
def test_get_amount_out_matches_the_contract_vectors(
    amount_in, reserve_in, reserve_out, fee_bps, expected
):
    assert get_amount_out(amount_in, reserve_in, reserve_out, fee_bps) == expected


@pytest.mark.parametrize(
    "args",
    [(0, 1, 1, 30), (-1, 1, 1, 30), (1, 0, 1, 30), (1, 1, 0, 30), (1, 1, 1, 1001), (1, 1, 1, -1)],
)
def test_get_amount_out_rejects_what_the_router_rejects(args):
    with pytest.raises(ValueError):
        get_amount_out(*args)


def test_apply_buy_and_sell_move_reserves_by_the_swapped_amounts():
    start = Reserves(token=1_000_000 * E18, quote=100 * E18)
    tokens, after_buy = apply_buy(start, E18, 30)
    assert tokens == 9871580343970612988504
    assert after_buy == Reserves(token=start.token - tokens, quote=start.quote + E18)
    eth, after_sell = apply_sell(after_buy, tokens, 30)
    assert after_sell == Reserves(token=start.token, quote=after_buy.quote - eth)
    assert eth < E18  # the round trip pays the fee twice


def test_constant_product_never_decreases_with_a_fee():
    rng = random.Random(7)
    reserves = Reserves(token=1_000_000 * E18, quote=100 * E18)
    for _ in range(500):
        k = reserves.token * reserves.quote
        if rng.random() < 0.5:
            _, reserves = apply_buy(reserves, rng.randrange(1, 5 * E18), 30)
        else:
            _, reserves = apply_sell(reserves, rng.randrange(1, 50_000 * E18), 30)
        assert reserves.token * reserves.quote >= k
        assert reserves.token > 0 and reserves.quote > 0


def test_spot_value_rounds_down():
    reserves = Reserves(token=3, quote=10)
    assert spot_value(1, reserves) == 3  # 3.33...
    assert spot_value(0, reserves) == 0
    with pytest.raises(ValueError):
        spot_value(1, Reserves(token=0, quote=1))
