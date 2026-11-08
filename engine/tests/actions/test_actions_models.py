from __future__ import annotations

from decimal import Decimal

import pytest
from pydantic import ValidationError

from hyvo.actions.models import (
    ActionLimits,
    ActionRecord,
    CheckMarket,
    Hold,
    SwapBuy,
    SwapSell,
    parse_market_action,
)
from hyvo.runfile.models import Action

TX = "0x" + "ab" * 32
RECORD_KEYS = ["agentId", "kind", "amountIn", "amountOut", "txHash", "status", "note"]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ({"kind": "swap_buy", "amount_eth": "0.05"}, SwapBuy(amount_eth=Decimal("0.05"))),
        ({"kind": "swap_buy", "amount_eth": 0.1}, SwapBuy(amount_eth=Decimal("0.1"))),
        ({"kind": "swap_buy", "amount_eth": 2}, SwapBuy(amount_eth=Decimal(2))),
        ('{"kind": "swap_buy", "amount_eth": 0.1}', SwapBuy(amount_eth=Decimal("0.1"))),
        (b'{"kind": "swap_sell", "fraction": 0.25}', SwapSell(fraction=Decimal("0.25"))),
        ({"kind": "swap_sell", "fraction": 1}, SwapSell(fraction=Decimal(1))),
        (
            {"kind": " SWAP_SELL ", "fraction": "0.5", "reason": "noted"},
            SwapSell(fraction=Decimal("0.5")),
        ),
        ({"kind": "hold"}, Hold()),
        ({"kind": "hold", "amount_eth": 5}, Hold()),
        ({"kind": "check_market"}, CheckMarket()),
        (CheckMarket(), CheckMarket()),
    ],
)
def test_parses_valid_actions(raw, expected):
    assert parse_market_action(raw) == (expected, None)


def test_numbers_stay_exact_decimals():
    from_float, _ = parse_market_action({"kind": "swap_buy", "amount_eth": 0.1})
    from_json, _ = parse_market_action('{"kind": "swap_buy", "amount_eth": 0.30000000000000004}')
    assert isinstance(from_float, SwapBuy) and isinstance(from_json, SwapBuy)
    assert str(from_float.amount_eth) == "0.1"
    assert from_json.amount_eth == Decimal("0.30000000000000004")


@pytest.mark.parametrize(
    ("raw", "note_start"),
    [
        (None, "market action must be an object, got NoneType"),
        ([], "market action must be an object, got list"),
        (5, "market action must be an object, got int"),
        ("buy 0.1 ETH", "market action is not valid JSON: 'buy 0.1 ETH'"),
        ('"hold"', "market action must be an object, got str"),
        ({}, "unknown market action kind None"),
        ({"kind": "moon"}, "unknown market action kind 'moon'"),
        ({"kind": 5}, "unknown market action kind 5"),
        ({"kind": "swap_buy"}, "invalid swap_buy: amount_eth: Field required"),
        (
            {"kind": "swap_buy", "amount_eth": 0},
            "invalid swap_buy: amount_eth: Input should be greater than 0",
        ),
        (
            {"kind": "swap_buy", "amount_eth": "-1"},
            "invalid swap_buy: amount_eth: Input should be greater than 0",
        ),
        ({"kind": "swap_buy", "amount_eth": "lots"}, "invalid swap_buy: amount_eth: "),
        ({"kind": "swap_buy", "amount_eth": True}, "invalid swap_buy: amount_eth: "),
        ({"kind": "swap_buy", "amount_eth": "NaN"}, "invalid swap_buy: amount_eth: "),
        (
            {"kind": "swap_sell", "fraction": 0},
            "invalid swap_sell: fraction: Input should be greater than 0",
        ),
        (
            {"kind": "swap_sell", "fraction": 1.5},
            "invalid swap_sell: fraction: Input should be less than or equal to 1",
        ),
        ({"kind": "swap_sell", "amount_eth": 1}, "invalid swap_sell: fraction: Field required"),
    ],
)
def test_bad_input_becomes_hold_with_a_note(raw, note_start):
    action, note = parse_market_action(raw)
    assert action == Hold()
    assert note is not None and note.startswith(note_start)


def test_notes_quote_long_input_briefly():
    _, note = parse_market_action("x" * 5000)
    assert note is not None and len(note) < 120


@pytest.mark.parametrize(
    ("raw", "note"),
    [
        ("[" * 100_000, "market action JSON is nested too deeply"),
        (
            '{"kind": "hold", "x": ' + "[" * 17 + "]" * 17 + "}",
            "market action JSON is nested too deeply",
        ),
        ("1" * 5000, "market action is not valid JSON: "),
        (b"\xff\xfe", "market action is not valid UTF-8"),
    ],
    ids=["deep-nesting", "just-too-deep", "huge-int", "bad-bytes"],
)
def test_hostile_json_never_raises(raw, note):
    action, got = parse_market_action(raw)
    assert action == Hold() and got is not None and got.startswith(note)


def test_brackets_inside_strings_do_not_count_as_nesting():
    text = '{"kind": "hold", "reason": "' + "[{" * 40 + '\\" }"}'
    assert parse_market_action(text) == (Hold(), None)
    nested = '{"kind": "check_market", "meta": {"a": [{"b": [1]}]}}'
    assert parse_market_action(nested) == (CheckMarket(), None)


def test_action_limits_defaults_and_conversions():
    limits = ActionLimits(Decimal(1))
    assert (limits.min_trade_eth, limits.max_slippage_bps, limits.keep_eth) == (
        Decimal("0.0001"),
        500,
        Decimal(0),
    )
    assert (limits.cap_wei, limits.min_trade_wei, limits.keep_wei) == (10**18, 10**14, 0)
    given_as_text = ActionLimits("0.5", min_trade_eth="0.01", keep_eth=1)  # type: ignore[arg-type]
    assert given_as_text.per_agent_cap_eth == Decimal("0.5")
    assert given_as_text.keep_eth == Decimal(1)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"per_agent_cap_eth": "0"},
        {"per_agent_cap_eth": "-1"},
        {"per_agent_cap_eth": "abc"},
        {"per_agent_cap_eth": "0.0000000000000000001"},
        {"per_agent_cap_eth": "1", "min_trade_eth": "-0.1"},
        {"per_agent_cap_eth": "1", "min_trade_eth": "2"},
        {"per_agent_cap_eth": "1", "max_slippage_bps": 10_001},
        {"per_agent_cap_eth": "1", "max_slippage_bps": -1},
        {"per_agent_cap_eth": "1", "max_slippage_bps": True},
        {"per_agent_cap_eth": "1", "max_slippage_bps": 1.5},
    ],
)
def test_action_limits_reject_bad_values(kwargs):
    with pytest.raises(ValueError):
        ActionLimits(**kwargs)


def test_action_limits_reject_floats():
    with pytest.raises(TypeError):
        ActionLimits(0.5)  # type: ignore[arg-type]


def test_records_match_the_run_format():
    invalid = ActionRecord.invalid("a07", "swap_buy of 2 ETH is above the per-agent cap of 1 ETH")
    assert invalid.to_dict() == {
        "agentId": "a07",
        "kind": "hold",
        "amountIn": None,
        "amountOut": None,
        "txHash": None,
        "status": "invalid",
        "note": "swap_buy of 2 ETH is above the per-agent cap of 1 ETH",
    }
    check = ActionRecord.no_tx("a01", "check_market")
    swap = ActionRecord(
        agent_id="a12",
        kind="swap_buy",
        amount_in="0.05",
        amount_out="41234.5",
        tx_hash=TX,
        status="ok",
        note=None,
    )
    reverted = ActionRecord(
        agent_id="a13",
        kind="swap_sell",
        amount_in="10",
        amount_out=None,
        tx_hash=TX,
        status="reverted",
        note="reverted: InsufficientOutput(amountOut=1, amountOutMin=2)",
    )
    for record in (invalid, check, swap, reverted):
        data = record.to_dict()
        assert list(data) == RECORD_KEYS
        assert Action.model_validate(data).model_dump(by_alias=True) == data
        assert ActionRecord.model_validate(data) == record


@pytest.mark.parametrize(
    "fields",
    [
        {"kind": "swap_buy", "status": "invalid", "note": "x"},  # invalid must be recorded as hold
        {"kind": "swap_buy", "amount_in": "1", "amount_out": "2", "status": "ok"},  # no txHash
        {"kind": "hold", "tx_hash": TX, "status": "ok"},
        {"kind": "hold", "status": "invalid"},  # no note
        {"kind": "swap_buy", "amount_in": "1.50", "amount_out": "2", "tx_hash": TX, "status": "ok"},
        {
            "kind": "swap_buy",
            "amount_in": "1",
            "amount_out": "2",
            "tx_hash": TX.upper(),
            "status": "ok",
        },
    ],
)
def test_records_enforce_the_run_format_rules(fields):
    base = {"agent_id": "a01", "amount_in": None, "amount_out": None, "tx_hash": None, "note": None}
    with pytest.raises(ValidationError):
        ActionRecord(**{**base, **fields})


def test_records_are_frozen():
    record = ActionRecord.no_tx("a01", "hold")
    with pytest.raises(ValidationError):
        record.status = "invalid"  # type: ignore[misc]
