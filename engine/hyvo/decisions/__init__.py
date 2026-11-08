"""Batched per-round agent decisions (protocol ``agent_decisions/v2``).

Replaces OASIS's one-LLM-call-per-agent loop (docs/MIROFISH_NOTES.md section 9): each round, one
``agents`` call per batch of agents returns every agent's post or reply, likes, market action,
sentiment and reason as JSON.

- ``types``           ``RoundContext``, ``MarketView``, ``FeedPost``, ``AgentCard`` in;
                      ``Decision``, ``PostIntent`` out
- ``prompt``          ``build_messages``, ``max_tokens_for``, ``visible_posts``, ``max_buy_eth``
- ``parse``           ``parse_decisions`` -> ``DecisionBatch`` (never raises on bad items)
- ``batch``           ``request_decisions``: build, call, parse, one retry, all-hold fallback
- ``offline_policy``  ``register_offline``: the deterministic persona rules model for the
                      offline client (call it once before using ``OfflineClient``)
"""

from .batch import request_decisions
from .offline_policy import register_offline
from .parse import DecisionBatch, hold_decisions, parse_decisions
from .prompt import (
    GAS_RESERVE_ETH,
    MAX_LIKES,
    MAX_POST_CHARS,
    MAX_REASON_CHARS,
    PROTOCOL,
    build_messages,
    max_buy_eth,
    max_tokens_for,
    visible_posts,
)
from .types import AgentCard, Decision, FeedPost, MarketView, PostIntent, RoundContext

__all__ = [
    "GAS_RESERVE_ETH",
    "MAX_LIKES",
    "MAX_POST_CHARS",
    "MAX_REASON_CHARS",
    "PROTOCOL",
    "AgentCard",
    "Decision",
    "DecisionBatch",
    "FeedPost",
    "MarketView",
    "PostIntent",
    "RoundContext",
    "build_messages",
    "hold_decisions",
    "max_buy_eth",
    "max_tokens_for",
    "parse_decisions",
    "register_offline",
    "request_decisions",
    "visible_posts",
]
