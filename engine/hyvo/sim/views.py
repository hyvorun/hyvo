"""Glue between the world, the social feed and the decision protocol.

- ``feed_post``: an OASIS ``SocialPost`` as a decision-protocol ``FeedPost``.
- ``market_view``: the shared market panel of a round from a ``MarketState``.
- ``plan_action``: one agent's ``Decision`` as a validated-or-rejected market action.
- ``reported_sentiment``: the sentiment an agent actually reported (placeholders excluded).
- ``SwapTape``: the pool's reserves and prices across the swaps of a round, for the prompts and
  the report.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, localcontext
from typing import Any

from hyvo.actions.models import Hold, MarketAction, parse_market_action
from hyvo.decisions import Decision, FeedPost, MarketView
from hyvo.sim.social import SocialPost
from hyvo.world.amm import Reserves
from hyvo.world.state import MarketState
from hyvo.world.units import ETH_DECIMALS, format_amount, format_price, to_base_units

SWAP_KINDS = ("swap_buy", "swap_sell")

# Holds the engine forced on an agent; the run.json action carries the note.
FORCED_HOLD_NOTES = ("budget_exhausted", "llm_request_failed", "batch_failed", "missing_decision")
# A decision with one of these notes reported no sentiment (its 0.0 is a placeholder).
NO_SENTIMENT_NOTES = frozenset({*FORCED_HOLD_NOTES, "sentiment_missing", "sentiment_invalid"})
MARKET_INVALID_NOTE = "market action must be an object with an 'action' name"


def feed_post(post: SocialPost) -> FeedPost:
    return FeedPost(
        id=post.ref,
        author_agent_id=post.author_agent_id,
        author_handle=post.author_handle,
        text=post.text,
        reply_to=post.reply_to,
        likes=post.likes,
        replies=post.replies,
        round=post.round,
    )


def percent_change(before: str, after: str) -> float:
    """``(after - before) / before * 100`` as a float rounded to 4 decimals (0.0 for before 0)."""
    start, end = Decimal(before), Decimal(after)
    if start == 0:
        return 0.0
    with localcontext() as ctx:
        ctx.prec = 40
        change = (end - start) / start * 100
    return round(float(change), 4) + 0.0  # + 0.0 turns -0.0 into 0.0


def market_view(
    state: MarketState,
    *,
    start_price: str,
    previous_price: str,
    recent_swaps: Sequence[Mapping[str, Any]],
    change_period: str = "last round",
) -> MarketView:
    """The market panel of a round: ``state`` is the decision snapshot, ``start_price`` the price
    before round 1 and ``previous_price`` the price the change is measured from: the previous round's
    snapshot, or this round's for a later wave, which says so in ``change_period``."""
    return MarketView(
        price=state.price,
        change_pct_since_start=percent_change(start_price, state.price),
        change_pct_last_round=percent_change(previous_price, state.price),
        reserve_eth=format_amount(state.reserve_quote, state.quote_decimals),
        reserve_token=format_amount(state.reserve_token, state.token_decimals),
        holders=len(state.holders),
        recent_swaps=[dict(swap) for swap in recent_swaps],
        change_period=change_period,
    )


@dataclass(frozen=True)
class ActionPlan:
    """What to do with an agent's market decision.

    Exactly one applies: ``invalid`` (record ``hold``/``invalid`` with this note), ``forced``
    (record an ``ok`` hold with this note: the engine made the agent hold), or ``action`` (a
    parsed action to validate and execute).
    """

    action: MarketAction
    invalid: str | None = None
    forced: str | None = None


def plan_action(decision: Decision) -> ActionPlan:
    """Map the decision protocol's market object (``{"action": "swap_buy", "amountEth": "0.05"}``,
    ``{"action": "swap_sell", "fraction": "0.5"}``, ``{"action": "hold"}``...) onto
    ``hyvo.actions``. No market object means hold."""
    forced = next((note for note in decision.notes if note in FORCED_HOLD_NOTES), None)
    if forced is not None:
        return ActionPlan(Hold(), forced=forced)
    market = decision.market
    if market is None:
        if "market_invalid" in decision.notes:
            return ActionPlan(Hold(), invalid=MARKET_INVALID_NOTE)
        return ActionPlan(Hold())
    raw: dict[str, Any] = {"kind": market.get("action")}
    for source, target in (("amountEth", "amount_eth"), ("amount_eth", "amount_eth"),
                           ("fraction", "fraction")):  # fmt: skip
        if source in market and target not in raw:
            raw[target] = market[source]
    action, note = parse_market_action(raw)
    return ActionPlan(action, invalid=note)


def reported_sentiment(decision: Decision) -> float | None:
    """The agent's sentiment, or None when the decision only carries a placeholder."""
    if NO_SENTIMENT_NOTES.intersection(decision.notes):
        return None
    return decision.sentiment


class SwapTape:
    """Follows the pool through a round's executed swaps, starting at the decision snapshot.

    Each executed swap moves the reserves by its recorded amounts (the pair keeps the fee, so the
    input reserve grows by the full input). ``reserves`` must equal the chain's afterwards.
    """

    def __init__(self, reserves: Reserves, token_decimals: int) -> None:
        self.reserves = reserves
        self.token_decimals = token_decimals

    @property
    def price(self) -> str:
        return format_price(self.reserves.quote, self.reserves.token)

    def apply(self, kind: str, amount_in: str, amount_out: str) -> tuple[str, str]:
        """Apply an executed swap; return the prices before and after it."""
        before = self.price
        if kind == "swap_buy":
            eth_in = to_base_units(amount_in, ETH_DECIMALS)
            tokens_out = to_base_units(amount_out, self.token_decimals)
            self.reserves = Reserves(
                token=self.reserves.token - tokens_out, quote=self.reserves.quote + eth_in
            )
        elif kind == "swap_sell":
            tokens_in = to_base_units(amount_in, self.token_decimals)
            eth_out = to_base_units(amount_out, ETH_DECIMALS)
            self.reserves = Reserves(
                token=self.reserves.token + tokens_in, quote=self.reserves.quote - eth_out
            )
        else:
            raise ValueError(f"not a swap kind: {kind!r}")
        return before, self.price
