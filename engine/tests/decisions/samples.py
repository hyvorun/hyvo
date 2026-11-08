"""Builders for decision-protocol inputs and a scripted fake LLM client."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from hyvo.decisions import AgentCard, FeedPost, MarketView, RoundContext
from hyvo.llm.pricing import FREE
from hyvo.llm.types import ChatMessage, LLMResult, Prices
from hyvo.personas import generate_crowd

TITLE = "Pons token X lists with 5% creator tax"
SEED = (
    "A new token launches on Pons with a 5% creator tax on every trade. The team is anonymous but "
    "has shipped two earlier tools. Liquidity starts at 10 ETH. The dev wallet holds 8% of supply "
    "and says it is locked for 30 days, but there is no public lock contract. A partnership with a "
    "wallet app is teased for next week. Early buyers are mostly bots."
)
POST_TEXTS = (
    "In at round 1 with 0.12 ETH. Thin pool, early wallets eat first. Momentum is real here.",
    "A 5% creator tax on every trade? Who holds the top wallets? Nobody has shown the distribution yet.",
    "We've seen shakeouts before. Picked up a little more and went back to reading the docs.",
    "Is anyone else seeing this?? Down 6.2% in one round. I'm out, sold 60% of my bag.",
    "Still holding. +12.4% since start is noise next to where this community could be in weeks.",
)
CROWD = generate_crowd(50, seed=3)


def post(post_id: str, author: int = 0, *, text: str = "hello there", reply_to: str | None = None,
         likes: int = 0, replies: int = 0, round_n: int = 1) -> FeedPost:  # fmt: skip
    spec = CROWD[author]
    return FeedPost(post_id, spec.agent_id, spec.handle, text, reply_to, likes, replies, round_n)


def market(**overrides: Any) -> MarketView:
    values: dict[str, Any] = {
        "price": "0.000001234567890123",
        "change_pct_since_start": 12.4,
        "change_pct_last_round": -3.1,
        "reserve_eth": "10.523456789",
        "reserve_token": "8532100.123456",
        "holders": 41,
        "recent_swaps": [
            {
                "handle": CROWD[i].handle,
                "kind": "swap_buy" if i % 2 else "swap_sell",
                "amountIn": "0.1" if i % 2 else "4000.5",
                "amountOut": "81234.5" if i % 2 else "0.0049",
                "priceAfter": "0.00000123",
            }
            for i in range(6)
        ],
    }
    return MarketView(**(values | overrides))


def feed(count: int = 15, round_n: int = 2) -> list[FeedPost]:
    """``count`` posts by agents a01.. a50 (every third one a reply to the post before it)."""
    posts = []
    for i in range(count):
        is_reply = i % 3 == 2
        posts.append(
            post(
                f"c{100 + i}" if is_reply else f"p{100 + i}",
                (i * 7) % len(CROWD),
                text=POST_TEXTS[i % len(POST_TEXTS)],
                reply_to=f"p{100 + i - 1}" if is_reply else None,
                likes=i % 4,
                replies=i % 2,
                round_n=round_n,
            )
        )
    return posts


def context(**overrides: Any) -> RoundContext:
    values: dict[str, Any] = {
        "scenario_title": TITLE,
        "scenario_text": SEED,
        "round_n": 3,
        "total_rounds": 10,
        "events_now": ["Rumor: dev wallet sold 20%"],
        "events_earlier": [(2, "Teaser: partnership with a wallet app next week")],
        "market": market(),
        "feed": feed(),
    }
    return RoundContext(**(values | overrides))


def card(index: int = 0, **overrides: Any) -> AgentCard:
    spec = CROWD[index]
    values: dict[str, Any] = {
        "agent_id": spec.agent_id,
        "handle": spec.handle,
        "persona_id": spec.persona.id,
        "profile": spec.persona.describe(),
        "eth_balance": "0.8123456789",
        "token_balance": "81234.56789",
        "token_value_eth": "0.1002345",
        "pnl_eth": "-0.0123456",
        "cap_eth": str(spec.per_agent_cap_eth),
    }
    return AgentCard(**(values | overrides))


def cards(count: int = 10, posts: Sequence[FeedPost] = ()) -> list[AgentCard]:
    """Cards for a01..; each card lists its own posts found in ``posts``."""
    result = []
    for index in range(count):
        agent_id = CROWD[index].agent_id
        own = [p for p in posts if p.author_agent_id == agent_id][:2]
        result.append(card(index, own_recent_posts=own))
    return result


@dataclass
class ScriptedClient:
    """``LLMClient`` that answers from a script: each entry is a text or a callable that raises
    or returns text. Records every call."""

    script: list[str | Callable[[], str]]
    model_label: str = "test/scripted"
    prices: Prices = FREE
    calls: list[dict[str, Any]] = field(default_factory=list)

    def complete(self, messages: Sequence[ChatMessage], *, temperature: float, max_tokens: int,
                 json_mode: bool, purpose: str) -> LLMResult:  # fmt: skip
        self.calls.append({"messages": list(messages), "temperature": temperature, "max_tokens": max_tokens,
                           "json_mode": json_mode, "purpose": purpose})  # fmt: skip
        step = self.script.pop(0)
        text = step() if callable(step) else step
        return LLMResult(text, 10, 10, self.model_label, "stop", 1, 0.0, True)
