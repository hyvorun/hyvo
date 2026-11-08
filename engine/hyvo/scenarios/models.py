"""Scenario data model. ``Scenario.to_run_dict()`` is the run.json ``scenario`` object."""

from __future__ import annotations

import re
from dataclasses import dataclass, fields
from decimal import Decimal
from typing import Any, Literal, get_args

from .sanitize import MAX_EVENT_CHARS, MAX_SEED_CHARS, MAX_TITLE_CHARS

SeedKind = Literal["url", "onchain", "user"]

MAX_EVENTS = 50
MAX_EVENTS_PER_ROUND = 5
MAX_REF_CHARS = 200
MAX_TOKEN_NAME_CHARS = 64
MAX_FEE_BPS = 1000
MAX_LIQUIDITY_ETH = Decimal(10**6)
MAX_LIQUIDITY_TOKENS = Decimal(10**15)  # stays far below the uint112 pair reserves at 18 decimals

_SYMBOL_RE = re.compile(r"^[A-Z0-9]{1,11}$")


class ScenarioError(ValueError):
    """A scenario is malformed. Messages say what to fix (with a line number when parsing)."""


@dataclass(frozen=True)
class SeedSource:
    kind: SeedKind
    ref: str

    def __post_init__(self) -> None:
        if self.kind not in get_args(SeedKind):
            raise ScenarioError(f"seed source kind must be one of {get_args(SeedKind)}")
        if not isinstance(self.ref, str) or not 1 <= len(self.ref) <= MAX_REF_CHARS:
            raise ScenarioError(f"seed source ref must be 1-{MAX_REF_CHARS} characters")


@dataclass(frozen=True)
class InjectedEvent:
    """Text injected into every agent's observation (and the feed) at round ``round``."""

    round: int
    text: str

    def __post_init__(self) -> None:
        if isinstance(self.round, bool) or not isinstance(self.round, int) or self.round < 1:
            raise ScenarioError("event round must be a whole number >= 1")
        if not isinstance(self.text, str) or not 1 <= len(self.text) <= MAX_EVENT_CHARS:
            raise ScenarioError(f"event text must be 1-{MAX_EVENT_CHARS} characters")


@dataclass(frozen=True)
class MarketOverrides:
    """Optional market settings for the world. ``None`` means the world's default."""

    token_symbol: str | None = None
    token_name: str | None = None
    liquidity_eth: Decimal | None = None
    liquidity_tokens: Decimal | None = None
    fee_bps: int | None = None

    def __post_init__(self) -> None:
        for f in fields(self):
            value = getattr(self, f.name)
            if value is not None:
                check_market_field(f.name, value)


def check_market_field(name: str, value: Any) -> None:
    """Validate one ``MarketOverrides`` field; raises ``ScenarioError``."""
    if name == "token_symbol":
        if not isinstance(value, str) or not _SYMBOL_RE.match(value):
            raise ScenarioError("token_symbol must be 1-11 uppercase letters or digits")
    elif name == "token_name":
        if not isinstance(value, str) or not 1 <= len(value) <= MAX_TOKEN_NAME_CHARS:
            raise ScenarioError(f"token_name must be 1-{MAX_TOKEN_NAME_CHARS} characters")
    elif name in ("liquidity_eth", "liquidity_tokens"):
        limit = MAX_LIQUIDITY_ETH if name == "liquidity_eth" else MAX_LIQUIDITY_TOKENS
        if (
            not isinstance(value, Decimal)
            or not value.is_finite()
            or not 0 < value <= limit
            or int(value.as_tuple().exponent) < -18
        ):
            raise ScenarioError(
                f"{name} must be a number > 0 and <= {limit:,} with at most 18 decimals"
            )
    elif name == "fee_bps":
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_FEE_BPS:
            raise ScenarioError(f"fee_bps must be a whole number from 0 to {MAX_FEE_BPS}")
    else:
        raise ScenarioError(f"unknown market setting {name!r}")


@dataclass(frozen=True)
class Scenario:
    """A sanitized scenario. Build with ``parse_scenario_markdown`` or ``from_text``."""

    title: str
    seed_text: str
    seed_sources: tuple[SeedSource, ...]
    injected_events: tuple[InjectedEvent, ...] = ()
    market: MarketOverrides | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.title, str) or not 1 <= len(self.title) <= MAX_TITLE_CHARS:
            raise ScenarioError(f"title must be 1-{MAX_TITLE_CHARS} characters")
        if not isinstance(self.seed_text, str) or len(self.seed_text) > MAX_SEED_CHARS:
            raise ScenarioError(f"seed text must be at most {MAX_SEED_CHARS} characters")
        if len(self.injected_events) > MAX_EVENTS:
            raise ScenarioError(f"a scenario can have at most {MAX_EVENTS} injected events")
        per_round: dict[int, int] = {}
        for event in self.injected_events:
            per_round[event.round] = per_round.get(event.round, 0) + 1
            if per_round[event.round] > MAX_EVENTS_PER_ROUND:
                raise ScenarioError(
                    f"round {event.round} has more than {MAX_EVENTS_PER_ROUND} injected events"
                )

    def events_at(self, round_n: int) -> tuple[InjectedEvent, ...]:
        return tuple(e for e in self.injected_events if e.round == round_n)

    def check_rounds(self, rounds: int) -> None:
        """Raise if an injected event falls after the last round of a ``rounds``-round run."""
        late = sorted({e.round for e in self.injected_events if e.round > rounds})
        if late:
            raise ScenarioError(
                f"injected events at round(s) {', '.join(map(str, late))} fall after the last "
                f"round ({rounds}); add rounds or move the events"
            )

    def to_run_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "seedText": self.seed_text,
            "seedSources": [{"kind": s.kind, "ref": s.ref} for s in self.seed_sources],
            "injectedEvents": [{"round": e.round, "text": e.text} for e in self.injected_events],
        }
