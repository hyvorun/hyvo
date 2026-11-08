from __future__ import annotations

import random
import re
from decimal import Decimal

import pytest

from hyvo.world.units import format_amount, format_price, to_base_units

RUN_DECIMAL = re.compile(r"^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$")  # docs/RUN_FORMAT.md "Decimal"


@pytest.mark.parametrize(
    ("value", "decimals", "expected"),
    [
        ("0", 18, 0),
        ("0.0", 18, 0),
        ("0.000000000000000001", 18, 1),
        ("1", 18, 10**18),
        ("1.5", 18, 15 * 10**17),
        ("0.05", 18, 5 * 10**16),
        ("1.000000000000000000000", 18, 10**18),  # zeros beyond 18 digits need no rounding
        (Decimal("1.50"), 1, 15),
        (Decimal("1E+3"), 0, 1000),
        (Decimal("2.5E-17"), 18, 25),
        (Decimal("-0"), 18, 0),
        ("5", 0, 5),
        ("123.456789", 6, 123_456_789),
    ],
)
def test_to_base_units_is_exact(value, decimals, expected):
    assert to_base_units(value, decimals) == expected


@pytest.mark.parametrize(
    "value",
    [
        "0.0000000000000000001",  # 19 fractional digits
        Decimal("1E-19"),
        Decimal("1.0000000000000000001"),
        Decimal("1E-1000000000"),  # rejected without computing 10**1000000000
        Decimal("1E+60"),  # 10**78 base units: above uint256
        Decimal("1E+1000000000"),
        Decimal(-1),
        Decimal("NaN"),
        Decimal("Infinity"),
        "-1",
        "1e5",
        " 1",
        "1_000",
        ".5",
        "5.",
        "",
        "0x10",
        "NaN",
    ],
)
def test_to_base_units_rejects_inexact_negative_and_malformed_amounts(value):
    with pytest.raises(ValueError):
        to_base_units(value, 18)


@pytest.mark.parametrize("value", [0.5, 1, True, None])
def test_to_base_units_accepts_only_str_and_decimal(value):
    with pytest.raises(TypeError):
        to_base_units(value, 18)


def test_to_base_units_checks_decimals():
    with pytest.raises(ValueError):
        to_base_units("1", 256)
    with pytest.raises(ValueError):
        to_base_units("1", -1)
    with pytest.raises(TypeError):
        to_base_units("1", True)


@pytest.mark.parametrize(
    ("base_units", "decimals", "expected"),
    [
        (0, 18, "0"),
        (1, 18, "0.000000000000000001"),
        (10**18, 18, "1"),
        (10**18 + 1, 18, "1.000000000000000001"),
        (15 * 10**17, 18, "1.5"),
        (5 * 10**16, 18, "0.05"),
        (1_000_000 * 10**18, 18, "1000000"),
        (123_456_789, 0, "123456789"),
        (1_500_000, 6, "1.5"),
        (
            2**256 - 1,
            18,
            "115792089237316195423570985008687907853269984665640564039457.584007913129639935",
        ),
    ],
)
def test_format_amount_is_canonical(base_units, decimals, expected):
    text = format_amount(base_units, decimals)
    assert text == expected
    assert RUN_DECIMAL.match(text)


def test_format_amount_rejects_negative_and_non_int():
    with pytest.raises(ValueError):
        format_amount(-1, 18)
    with pytest.raises(TypeError):
        format_amount(1.0, 18)  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        format_amount(True, 18)


def test_format_and_parse_round_trip():
    rng = random.Random(4663)
    for _ in range(2000):
        decimals = rng.choice([0, 1, 6, 8, 18])
        units = rng.choice([rng.randrange(10**4), rng.randrange(10**30), rng.randrange(2**112)])
        text = format_amount(units, decimals)
        assert RUN_DECIMAL.match(text)
        assert to_base_units(text, decimals) == units


@pytest.mark.parametrize(
    ("reserve_quote", "reserve_token", "expected"),
    [
        (100 * 10**18, 1_000_000 * 10**18, "0.0001"),
        (10**18, 10**18, "1"),
        (3 * 10**18, 2 * 10**18, "1.5"),
        (1, 3, "0.333333333333333333"),  # rounds down
        (2, 3, "0.666666666666666667"),  # rounds up
        (0, 10**18, "0"),
        (1, 10**19, "0"),  # 1e-19 rounds to 0
        (5, 10**19, "0"),  # exactly half: half-even keeps 0
        (15, 10**19, "0.000000000000000002"),  # half: rounds to the even 2
        (25, 10**19, "0.000000000000000002"),  # half: rounds to the even 2
        (35, 10**19, "0.000000000000000004"),
        (2**112 - 1, 1, "5192296858534827628530496329220095"),  # largest reserve ratio
        (1, 2**112 - 1, "0"),
    ],
)
def test_format_price_rounds_half_even_to_18_digits_and_trims(
    reserve_quote, reserve_token, expected
):
    text = format_price(reserve_quote, reserve_token)
    assert text == expected
    assert RUN_DECIMAL.match(text)


def test_format_price_divides_at_40_significant_digits_first():
    # Exactly 123456789012345678901.000000000000000001490: rounded straight to 18 fractional digits
    # it would end in ...001, but the division keeps 40 significant digits (...0015), and that
    # half then rounds to the even ...002. This pins the two-step rule of docs/RUN_FORMAT.md.
    reserve_quote = int("123456789012345678901" + "000000000000000001490")
    assert format_price(reserve_quote, 10**21) == "123456789012345678901.000000000000000002"


def test_format_price_rejects_an_empty_token_reserve_and_bad_input():
    with pytest.raises(ValueError):
        format_price(1, 0)
    with pytest.raises(ValueError):
        format_price(-1, 1)
    with pytest.raises(TypeError):
        format_price(1.0, 1)  # type: ignore[arg-type]
