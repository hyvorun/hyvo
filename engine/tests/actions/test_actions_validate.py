from __future__ import annotations

import time
from decimal import Decimal

import pytest

from hyvo.actions.models import ActionLimits, CheckMarket, Hold, SwapBuy, SwapSell
from hyvo.actions.validate import sell_amount, validate
from hyvo.world.state import AgentBalances

E18 = 10**18
LIMITS = ActionLimits(Decimal("0.5"), min_trade_eth=Decimal("0.001"), keep_eth=Decimal("0.1"))
RICH = AgentBalances(eth=E18, token=1000 * E18)


def buy(amount: str) -> SwapBuy:
    return SwapBuy(amount_eth=Decimal(amount))


def sell(fraction: str) -> SwapSell:
    return SwapSell(fraction=Decimal(fraction))


@pytest.mark.parametrize(
    ("action", "balances", "note"),
    [
        (Hold(), RICH, None),
        (CheckMarket(), RICH, None),
        (buy("0.5"), RICH, None),  # the cap is inclusive
        (buy("0.001"), RICH, None),  # the minimum is inclusive
        (buy("0.0009"), RICH, "swap_buy of 0.0009 ETH is below the minimum trade of 0.001 ETH"),
        (buy("0.6"), RICH, "swap_buy of 0.6 ETH is above the per-agent cap of 0.5 ETH"),
        (buy("1E+30"), RICH, "swap_buy of 1E+30 ETH is above the per-agent cap of 0.5 ETH"),
        (buy("0.5"), AgentBalances(eth=6 * E18 // 10, token=0), None),  # 0.6 - keep 0.1 = 0.5
        (
            buy("0.5"),
            AgentBalances(eth=55 * E18 // 100, token=0),
            "swap_buy of 0.5 ETH exceeds the available 0.45 ETH",
        ),
        (
            buy("0.01"),
            AgentBalances(eth=E18 // 20, token=0),  # holds less than keep_eth
            "swap_buy of 0.01 ETH exceeds the available 0 ETH",
        ),
        (
            buy("0.1234567890123456789"),
            RICH,
            "swap_buy amount_eth 0.1234567890123456789 has more than 18 decimal places",
        ),
        (
            SwapBuy.model_construct(amount_eth=Decimal(0)),
            RICH,
            "swap_buy amount_eth must be > 0, got 0",
        ),
        (sell("0.5"), RICH, None),
        (sell("1"), RICH, None),
        (sell("0.5"), AgentBalances(eth=E18, token=0), "swap_sell with no tokens to sell"),
        (
            sell("0.1"),
            AgentBalances(eth=E18, token=5),
            "swap_sell fraction 0.1 of the holdings rounds down to 0 tokens",
        ),
        (
            sell("1E-999999999"),
            RICH,
            "swap_sell fraction 1E-999999999 of the holdings rounds down to 0 tokens",
        ),
        (
            SwapSell.model_construct(fraction=Decimal("1.5")),
            RICH,
            "swap_sell fraction must be in (0, 1], got 1.5",
        ),
    ],
)
def test_validate(action, balances, note):
    checked, got = validate(action, balances, LIMITS)
    assert got == note
    assert checked == (action if note is None else Hold())


def test_validate_rejects_an_unknown_action_type():
    checked, note = validate("swap_buy", RICH, LIMITS)  # type: ignore[arg-type]
    assert checked == Hold() and note == "unknown market action str"


@pytest.mark.parametrize(
    ("holdings", "fraction", "expected"),
    [
        (10, "0.5", 5),
        (11, "0.5", 5),  # rounds down
        (10**24 + 7, "0.3333", (10**24 + 7) * 3333 // 10000),
        (10**24 + 7, "1", 10**24 + 7),
        (10**24 + 7, "1.000", 10**24 + 7),
        (999, "0.001", 0),
        (0, "1", 0),
    ],
)
def test_sell_amount_is_an_exact_floor(holdings, fraction, expected):
    assert sell_amount(holdings, Decimal(fraction)) == expected


def test_sell_amount_is_cheap_for_tiny_fractions_and_rejects_bad_ones():
    started = time.perf_counter()
    assert sell_amount(10**30, Decimal("1E-999999999")) == 0
    assert time.perf_counter() - started < 0.1
    for fraction in ("0", "1.01", "-0.5", "NaN"):
        with pytest.raises(ValueError):
            sell_amount(10, Decimal(fraction))
