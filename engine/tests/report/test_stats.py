"""Deterministic report statistics on the hand-built 4-round run of ``samples.make_input``."""

from __future__ import annotations

import math
from decimal import Decimal

import pytest

from hyvo.report.stats import (
    compute_stats,
    format_decimal,
    mean_sentiment,
    parse_decimal,
    percent_change,
    persona_flows,
    price_drivers,
    round_table,
    sentiment_by_round,
    turning_point_candidates,
)
from hyvo.report.types import RoundTrace

from .samples import make_input


def _flat_round(n: int, **overrides: object) -> RoundTrace:
    values: dict[str, object] = {
        "n": n,
        "market_after": {"price": "0.000001", "reserve0": "1000000", "reserve1": "1", "holders": 0},
        "sentiments": {"a01": 0.1},
    }
    values.update(overrides)
    return RoundTrace(**values)  # type: ignore[arg-type]


def test_round_table_matches_hand_computed_values() -> None:
    rows = [row.to_dict() for row in round_table(make_input())]
    assert [r["price"] for r in rows] == ["0.00000121", "0.00000144", "0.000001", "0.000001"]
    assert [r["priceChangePct"] for r in rows] == [21.0, 19.0083, -30.5556, 0.0]
    assert [r["netFlowEth"] for r in rows] == ["0.1", "0.1", "-0.105", "0"]
    assert [(r["buys"], r["sells"]) for r in rows] == [(1, 0), (1, 0), (0, 2), (0, 0)]
    assert [(r["posts"], r["likes"]) for r in rows] == [(2, 5), (1, 1), (3, 9), (0, 0)]
    assert [r["holders"] for r in rows] == [1, 2, 2, 2]
    assert (rows[0]["reserve0"], rows[0]["reserve1"]) == ("909338.7", "1.1")
    assert [r["events"] for r in rows] == [[], [], ["Rumor: the dev wallet sold 20%"], []]
    assert [(r["invalid"], r["reverted"]) for r in rows] == [(0, 0), (0, 0), (1, 0), (0, 1)]
    assert [r["round"] for r in rows] == [1, 2, 3, 4]


def test_sentiment_by_round_is_the_mean_of_agent_sentiments() -> None:
    inp = make_input()
    assert sentiment_by_round(inp) == [0.15, 0.25, -0.35, -0.225]
    assert compute_stats(inp).sentiment_by_round == [0.15, 0.25, -0.35, -0.225]


@pytest.mark.parametrize(
    ("sentiments", "expected"),
    [
        ({}, 0.0),
        ({"a01": 1 / 3}, 0.3333),
        ({"a01": 1.5, "a02": 2}, 1.0),  # each value is clamped to [-1, 1]
        ({"a01": -7.0}, -1.0),
        ({"a01": float("nan"), "a02": float("inf"), "a03": 0.5}, 0.5),  # non-finite values skipped
        ({"a01": True, "a02": "0.9", "a03": None, "a04": -0.5}, -0.5),  # non-numbers skipped
        ({"a01": 0.00001, "a02": -0.00002}, 0.0),
        ({"a01": 1, "a02": 0}, 0.5),
    ],
)
def test_mean_sentiment(sentiments: dict[str, object], expected: float) -> None:
    value = mean_sentiment(sentiments)
    assert value == expected
    assert math.copysign(1.0, value) == math.copysign(1.0, expected), "no negative zero"


def test_persona_flows() -> None:
    flows = {f.persona: f.to_dict() for f in persona_flows(make_input())}
    assert list(flows) == ["holder", "panic_seller", "skeptic", "sniper"]
    assert flows["sniper"] == {"persona": "sniper", "agents": 1, "buys": 1, "sells": 1,
                               "ethIn": "0.1", "ethOut": "0.045", "netFlowEth": "0.055"}
    assert flows["holder"]["netFlowEth"] == "0.1"
    assert flows["panic_seller"]["netFlowEth"] == "-0.06"
    assert flows["skeptic"] == {"persona": "skeptic", "agents": 1, "buys": 0, "sells": 0,
                                "ethIn": "0", "ethOut": "0", "netFlowEth": "0"}


def test_turning_point_candidates_scores_and_order() -> None:
    candidates = compute_stats(make_input()).candidates
    assert [(c.round, c.score) for c in candidates] == [(3, 1.0), (2, 0.2988), (1, 0.2749)]
    top = candidates[0].to_dict()
    assert top == {"round": 3, "score": 1.0, "priceChangePct": -30.5556, "sentimentChange": -0.6,
                   "netFlowFlipped": True, "injectedEvent": True}
    assert candidates[1].sentiment_change == 0.1 and not candidates[1].flow_flip


def test_candidates_are_limited_and_need_a_positive_score() -> None:
    table = round_table(make_input())
    assert [c.round for c in turning_point_candidates(table, limit=1)] == [3]
    assert [c.round for c in turning_point_candidates(table, limit=10)] == [3, 2, 1, 4]
    flat = make_input(rounds=[_flat_round(1), _flat_round(2), _flat_round(3)])
    assert compute_stats(flat).candidates == []


def test_candidate_ties_go_to_the_earlier_round() -> None:
    rounds = [_flat_round(1), _flat_round(2, injected_events=["a"]), _flat_round(3, injected_events=["b"])]
    candidates = compute_stats(make_input(rounds=rounds)).candidates
    assert [(c.round, c.score) for c in candidates] == [(2, 0.1), (3, 0.1)]


def test_net_flow_flip_compares_with_the_last_nonzero_round() -> None:
    buy = {"agentId": "a01", "persona": "sniper", "kind": "swap_buy", "amountIn": "0.1",
           "amountOut": "1", "priceBefore": "0.000001", "priceAfter": "0.000001", "reason": ""}
    sell = buy | {"kind": "swap_sell", "amountIn": "1", "amountOut": "0.1"}
    rounds = [_flat_round(1, swaps=[buy]), _flat_round(2), _flat_round(3, swaps=[sell])]
    candidates = compute_stats(make_input(rounds=rounds)).candidates
    assert [(c.round, c.flow_flip) for c in candidates] == [(3, True)]


def test_price_drivers_rank_swaps_by_absolute_impact() -> None:
    drivers = price_drivers(make_input())
    assert [(d.round, d.agent_id, d.impact_pct) for d in drivers] == [
        (1, "a01", 21.0), (2, "a02", 19.0083), (3, "a03", -18.0556), (3, "a01", -15.2542),
    ]
    assert drivers[2].to_dict() == {
        "round": 3, "agentId": "a03", "persona": "panic_seller", "kind": "swap_sell",
        "amountIn": "50000", "amountOut": "0.06", "priceBefore": "0.00000144",
        "priceAfter": "0.00000118", "impactPct": -18.0556, "reason": "rumor",
    }
    assert [d.agent_id for d in price_drivers(make_input(), limit=2)] == ["a01", "a02"]


def test_price_drivers_skip_swaps_without_a_price_before() -> None:
    swap = {"agentId": "a01", "persona": "sniper", "kind": "swap_buy", "amountIn": "0.1",
            "amountOut": "1", "priceBefore": "0", "priceAfter": "0.000001"}
    assert price_drivers(make_input(rounds=[_flat_round(1, swaps=[swap])])) == []


def test_percent_change_and_zero_base() -> None:
    assert percent_change(Decimal("0.00000121"), Decimal("0.00000144")) == 19.0083
    assert percent_change(Decimal(2), Decimal(1)) == -50.0
    assert percent_change(Decimal(1), Decimal(1)) == 0.0
    assert percent_change(Decimal(0), Decimal(1)) is None
    zero_start = make_input(initial_market={"price": "0", "reserve0": "0", "reserve1": "0", "holders": 0})
    assert round_table(zero_start)[0].price_change_pct is None


@pytest.mark.parametrize("value", [0.1, True, None, "abc", "NaN", "Infinity"])
def test_parse_decimal_rejects_floats_and_non_numbers(value: object) -> None:
    with pytest.raises(ValueError):
        parse_decimal(value, "test value")


def test_unknown_swap_kind_is_rejected() -> None:
    swap = {"agentId": "a01", "persona": "sniper", "kind": "hold", "amountIn": "0", "amountOut": "0",
            "priceBefore": "1", "priceAfter": "1"}
    with pytest.raises(ValueError, match="swap kind"):
        round_table(make_input(rounds=[_flat_round(1, swaps=[swap])]))


@pytest.mark.parametrize(
    ("value", "expected"),
    [("1.500", "1.5"), ("-0.105", "-0.105"), ("0E-7", "0"), ("1E+2", "100"), ("0.000001", "0.000001"),
     ("-0", "0")],
)
def test_format_decimal(value: str, expected: str) -> None:
    assert format_decimal(Decimal(value)) == expected
