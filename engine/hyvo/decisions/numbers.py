"""Number formatting shared by the prompt and the offline policy (decimal strings in, text out)."""

from __future__ import annotations

from decimal import ROUND_DOWN, ROUND_HALF_EVEN, Decimal
from typing import Any


def plain(value: Decimal) -> str:
    """run.json Decimal style: plain notation, no exponent, no trailing zeros."""
    if value == 0:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def eth(value: Any, places: int = 4, rounding: str = ROUND_DOWN) -> str:
    """An ETH amount with at most ``places`` decimals. Rounds down by default, so a shown
    balance or limit is always spendable."""
    return plain(Decimal(str(value)).quantize(Decimal(1).scaleb(-places), rounding=rounding))


def signed_eth(value: Any, places: int = 4) -> str:
    """A signed ETH amount such as ``+0.0123`` or ``-0.004`` (``0`` without a sign)."""
    shown = eth(value, places, ROUND_HALF_EVEN)
    return shown if shown.startswith("-") or shown == "0" else "+" + shown


def tokens(value: Any) -> str:
    """Whole tokens with thousands separators, or 4 significant digits below 1,000."""
    number = Decimal(str(value))
    return f"{int(number):,}" if number >= 1000 else sig(number, 4)


def sig(value: Any, digits: int) -> str:
    """``value`` rounded to ``digits`` significant digits, in plain notation."""
    number = Decimal(str(value))
    if number == 0:
        return "0"
    quantum = Decimal(1).scaleb(number.adjusted() - digits + 1)
    return plain(number.quantize(quantum, rounding=ROUND_HALF_EVEN))


def pct(value: float) -> str:
    """A signed percentage with one decimal, e.g. ``+3.2%``; ``-0.0`` is shown as ``+0.0%``."""
    return "+0.0%" if round(value, 1) == 0 else f"{value:+.1f}%"
