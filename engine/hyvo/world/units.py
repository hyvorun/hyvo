"""Exact conversions between integer base units and the decimal strings of run.json.

Amounts are integers in base units (wei for ETH). ``run.json`` stores them as ``Decimal`` strings in
whole units (docs/RUN_FORMAT.md, "Primitive formats"): no sign, exponent, leading zeros or trailing
fractional zeros. Nothing in this module goes through a float.
"""

from __future__ import annotations

import re
from decimal import ROUND_HALF_EVEN, Context, Decimal

ETH_DECIMALS = 18
PRICE_SIGNIFICANT_DIGITS = 40
PRICE_FRACTION_DIGITS = 18
MAX_DECIMALS = 255  # ERC-20 decimals() is a uint8
_UINT256_DIGITS = 78  # 2**256 - 1 has 78 decimal digits

# A string amount is digits with an optional fraction: no sign, exponent, space or underscore.
_PLAIN_DECIMAL = re.compile(r"[0-9]+(\.[0-9]+)?")
_PRICE_CONTEXT = Context(prec=PRICE_SIGNIFICANT_DIGITS, rounding=ROUND_HALF_EVEN)
# Quantizing to 18 fractional digits must never overflow the precision: uint112 reserves give a
# price below 10**34, so 34 integer digits plus 18 fractional digits fit easily.
_QUANTIZE_CONTEXT = Context(prec=100, rounding=ROUND_HALF_EVEN)
_PRICE_STEP = Decimal(1).scaleb(-PRICE_FRACTION_DIGITS)


def to_base_units(value: str | Decimal, decimals: int) -> int:
    """Convert a whole-unit amount to integer base units, exactly.

    ``value`` is a ``Decimal`` or a plain decimal string such as ``"0.05"``. Trailing zeros beyond
    ``decimals`` are fine; a non-zero digit there raises ``ValueError`` (it would need rounding), as
    do negative, non-finite and uint256-overflowing amounts.
    """
    _check_decimals(decimals)
    if isinstance(value, str):
        if not _PLAIN_DECIMAL.fullmatch(value):
            raise ValueError(f"not a plain decimal amount: {value!r}")
        value = Decimal(value)
    elif not isinstance(value, Decimal):
        raise TypeError(f"an amount must be a str or Decimal, got {type(value).__name__}")
    if not value.is_finite() or value < 0:
        raise ValueError(f"an amount must be finite and non-negative, got {value}")

    _, digits, exponent = value.as_tuple()
    coefficient = int("".join(map(str, digits)))
    if coefficient == 0:
        return 0
    shift = int(exponent) + decimals  # the exponent is an int for finite values
    if shift >= 0:
        if len(digits) + shift > _UINT256_DIGITS:
            raise ValueError(f"{value} does not fit in a uint256 with {decimals} decimals")
        units = coefficient * 10**shift
        if units >= 2**256:
            raise ValueError(f"{value} does not fit in a uint256 with {decimals} decimals")
        return units
    if -shift > len(digits):  # every significant digit lies beyond `decimals`
        raise ValueError(f"{value} has more than {decimals} fractional digits")
    units, rest = divmod(coefficient, 10**-shift)
    if rest:
        raise ValueError(f"{value} has more than {decimals} fractional digits")
    return units


def format_amount(base_units: int, decimals: int) -> str:
    """Base units as the canonical whole-unit ``Decimal`` string: ``1500000000000000000`` with 18
    decimals is ``"1.5"``, ``0`` is ``"0"``, ``1`` is ``"0.000000000000000001"``."""
    _check_int(base_units, "base_units")
    if base_units < 0:
        raise ValueError(f"base_units must be non-negative, got {base_units}")
    _check_decimals(decimals)
    whole, fraction = divmod(base_units, 10**decimals)
    if fraction == 0:
        return str(whole)
    return f"{whole}.{fraction:0{decimals}d}".rstrip("0")


def format_price(reserve_quote: int, reserve_token: int) -> str:
    """The run.json ``price``: ``reserve_quote / reserve_token`` (ETH per token).

    Computed with ``Decimal`` at 40 significant digits, rounded half-even to 18 fractional digits
    and trimmed to the ``Decimal`` string format. Both reserves are base units of assets with the
    same decimals (18 for TestToken and TestWETH), so their ratio is the whole-unit price.
    """
    _check_int(reserve_quote, "reserve_quote")
    _check_int(reserve_token, "reserve_token")
    if reserve_quote < 0 or reserve_token <= 0:
        raise ValueError(
            "price needs reserve_quote >= 0 and reserve_token > 0, "
            f"got {reserve_quote} and {reserve_token}"
        )
    ratio = _PRICE_CONTEXT.divide(Decimal(reserve_quote), Decimal(reserve_token))
    rounded = ratio.quantize(_PRICE_STEP, rounding=ROUND_HALF_EVEN, context=_QUANTIZE_CONTEXT)
    text = format(rounded, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _check_int(value: int, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} must be an int, got {type(value).__name__}")


def _check_decimals(decimals: int) -> None:
    _check_int(decimals, "decimals")
    if not 0 <= decimals <= MAX_DECIMALS:
        raise ValueError(f"decimals must be in 0..{MAX_DECIMALS}, got {decimals}")
