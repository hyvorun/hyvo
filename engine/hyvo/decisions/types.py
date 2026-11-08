"""Inputs and outputs of the batched decision protocol (``agent_decisions/v2``).

Amounts are decimal strings in whole units (ETH or tokens, run.json ``Decimal`` style); only
``AgentCard.pnl_eth`` may be negative. Percentages are floats. The dataclasses are frozen but
the lists inside them are not copied, so treat them as read-only.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

_POST_ID_RE = re.compile(r"^[pc][0-9]+$")
SWAP_KINDS = ("swap_buy", "swap_sell")


def is_post_id(value: object) -> bool:
    """True for ``p<n>`` (a top-level post) or ``c<n>`` (a reply)."""
    return isinstance(value, str) and _POST_ID_RE.match(value) is not None


def _check_amount(name: str, value: object, *, signed: bool = False) -> None:
    try:
        number = Decimal(value) if isinstance(value, str) else None
    except InvalidOperation:
        number = None
    if number is None or not number.is_finite() or (number < 0 and not signed):
        kind = "a signed decimal string" if signed else "a non-negative decimal string"
        raise ValueError(f"{name} must be {kind}, got {value!r}")


def _check_count(name: str, value: object) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a whole number >= 0, got {value!r}")


@dataclass(frozen=True)
class FeedPost:
    """A post (``p<n>``) or a reply (``c<n>``, with ``reply_to`` set) on the shared feed."""

    id: str
    author_agent_id: str
    author_handle: str
    text: str
    reply_to: str | None
    likes: int
    replies: int
    round: int

    def __post_init__(self) -> None:
        if not is_post_id(self.id):
            raise ValueError(f"post id must look like 'p12' or 'c40', got {self.id!r}")
        if self.reply_to is not None and not is_post_id(self.reply_to):
            raise ValueError(f"reply_to must be a post id or None, got {self.reply_to!r}")
        if self.id.startswith("c") != (self.reply_to is not None):
            raise ValueError("a 'c' id is a reply and needs reply_to; a 'p' id must not have one")
        for name in ("likes", "replies", "round"):
            _check_count(name, getattr(self, name))


@dataclass(frozen=True)
class MarketView:
    """The market panel every agent sees. ``recent_swaps`` holds dicts with ``handle``,
    ``kind`` (``swap_buy`` | ``swap_sell``), ``amountIn``, ``amountOut`` and ``priceAfter``."""

    price: str
    change_pct_since_start: float
    change_pct_last_round: float
    reserve_eth: str
    reserve_token: str
    holders: int
    recent_swaps: list[dict[str, Any]] = field(default_factory=list)
    change_period: str = "last round"  # what ``change_pct_last_round`` covers, in the prompt's words

    def __post_init__(self) -> None:
        for name in ("price", "reserve_eth", "reserve_token"):
            _check_amount(name, getattr(self, name))
        for name in ("change_pct_since_start", "change_pct_last_round"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"{name} must be a finite number, got {value!r}")
        _check_count("holders", self.holders)
        for swap in self.recent_swaps:
            if not isinstance(swap, dict) or swap.get("kind") not in SWAP_KINDS:
                raise ValueError(f"recent_swaps entries need kind swap_buy or swap_sell, got {swap!r}")
            if not isinstance(swap.get("handle"), str):
                raise ValueError("recent_swaps entries need a handle string")
            for key in ("amountIn", "amountOut", "priceAfter"):
                _check_amount(f"recent_swaps {key}", swap.get(key))


@dataclass(frozen=True)
class AgentCard:
    """One agent's private view this round.

    ``profile`` is ``Persona.describe()``. ``cap_eth`` is the per-swap cap. ``detailed_market``
    is set only when the agent chose ``check_market`` last round. ``liked`` holds the ids of shown
    posts the agent already liked (a post can be liked once).
    """

    agent_id: str
    handle: str
    persona_id: str
    profile: str
    eth_balance: str
    token_balance: str
    token_value_eth: str
    pnl_eth: str
    cap_eth: str
    own_recent_posts: list[FeedPost] = field(default_factory=list)
    replies_to_me: list[FeedPost] = field(default_factory=list)
    detailed_market: dict[str, Any] | None = None
    liked: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        for name in ("eth_balance", "token_balance", "token_value_eth", "cap_eth"):
            _check_amount(name, getattr(self, name))
        _check_amount("pnl_eth", self.pnl_eth, signed=True)


@dataclass(frozen=True)
class RoundContext:
    """What every agent of a round shares: scenario, events, market and feed."""

    scenario_title: str
    scenario_text: str
    round_n: int
    total_rounds: int
    events_now: list[str]
    events_earlier: list[tuple[int, str]]
    market: MarketView
    feed: list[FeedPost]

    def __post_init__(self) -> None:
        _check_count("total_rounds", self.total_rounds)
        if isinstance(self.round_n, bool) or not isinstance(self.round_n, int):
            raise ValueError("round_n must be a whole number")
        if not 1 <= self.round_n <= self.total_rounds:
            raise ValueError(f"round_n must be in 1..{self.total_rounds}, got {self.round_n}")


@dataclass(frozen=True)
class PostIntent:
    """A post (``reply_to`` None) or a reply to a known post id."""

    text: str
    reply_to: str | None


@dataclass(frozen=True)
class Decision:
    """One agent's move for one round, after parsing and sanitizing.

    ``market`` is the raw market object (e.g. ``{"action": "swap_buy", "amountEth": "0.05"}``)
    or None; ``hyvo.actions`` validates it. ``notes`` records what parsing changed or dropped.
    """

    agent_id: str
    post: PostIntent | None
    likes: list[str]
    market: dict[str, Any] | None
    sentiment: float
    reason: str
    notes: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not -1.0 <= self.sentiment <= 1.0:
            raise ValueError(f"sentiment must be in [-1, 1], got {self.sentiment!r}")

    def to_dict(self) -> dict[str, Any]:
        """JSON-ready form (camelCase), e.g. for the engine event log."""
        post = None if self.post is None else {"text": self.post.text, "replyTo": self.post.reply_to}
        return {
            "agentId": self.agent_id,
            "post": post,
            "likes": list(self.likes),
            "market": None if self.market is None else dict(self.market),
            "sentiment": self.sentiment,
            "reason": self.reason,
            "notes": list(self.notes),
        }
