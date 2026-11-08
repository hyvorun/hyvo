"""A tiny in-memory world (constant-product pool, wallets, feed) that drives the decision protocol
for many rounds without anvil or OASIS. It validates market decisions the way the actions layer
will (cap, balance minus gas reserve, tokens to sell) and records anything invalid."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from decimal import ROUND_DOWN, Decimal, localcontext
from typing import Any

from hyvo.decisions import (
    GAS_RESERVE_ETH,
    AgentCard,
    Decision,
    FeedPost,
    MarketView,
    RoundContext,
    request_decisions,
)
from hyvo.decisions.numbers import plain
from hyvo.llm.types import LLMClient
from hyvo.personas import AgentSpec, generate_crowd

from .samples import SEED, TITLE

FEE = Decimal("0.003")
WEI = Decimal(10) ** 18
Q18 = Decimal("1e-18")
FEED_SIZE = 15
SWAPS_SHOWN = 6
SEED_TOKENS = Decimal(100_000)  # tokens per unit of persona token weight


def fmt(value: Decimal) -> str:
    return plain(value.quantize(Q18, rounding=ROUND_DOWN))


@dataclass
class StubPost:
    id: str
    author: str
    handle: str
    text: str
    reply_to: str | None
    round: int
    likes: int = 0
    replies: int = 0

    def view(self) -> FeedPost:
        return FeedPost(self.id, self.author, self.handle, self.text, self.reply_to, self.likes,
                        self.replies, self.round)  # fmt: skip


@dataclass
class RoundLog:
    n: int
    decisions: dict[str, Decision]
    batch_notes: list[str]
    posts: list[StubPost] = field(default_factory=list)
    actions: list[tuple[str, str]] = field(default_factory=list)  # (agent id, kind)
    invalid: list[tuple[str, str]] = field(default_factory=list)  # (agent id, why)
    likes: int = 0

    @property
    def replies(self) -> list[StubPost]:
        return [post for post in self.posts if post.reply_to is not None]

    def count(self, kind: str) -> int:
        return sum(1 for _, done in self.actions if done == kind)


class StubWorld:
    def __init__(self, size: int = 50, seed: int = 0, rounds: int = 10,
                 events: Mapping[int, Sequence[str]] | None = None) -> None:  # fmt: skip
        self.agents: list[AgentSpec] = generate_crowd(size, seed=seed)
        self.rounds = rounds
        self.events = {n: list(texts) for n, texts in (events or {}).items()}
        self.reserve_eth = Decimal(10)
        self.reserve_token = Decimal(10_000_000)
        self.start_price = self.round_start_price = self.price
        self.eth = {a.agent_id: Decimal(a.initial_eth_wei) / WEI for a in self.agents}
        self.tokens = {a.agent_id: Decimal(str(a.initial_token_weight)) * SEED_TOKENS for a in self.agents}
        self.start_value = {a: self.eth[a] + self.tokens[a] * self.price for a in self.eth}
        self.posts: list[StubPost] = []
        self.swaps: list[dict[str, Any]] = []
        self.checked: set[str] = set()
        self._counters = {"p": 0, "c": 0}

    @property
    def price(self) -> Decimal:
        with localcontext() as ctx:
            ctx.prec = 40
            return self.reserve_eth / self.reserve_token

    def run(self, client: LLMClient, batch_size: int = 10) -> list[RoundLog]:
        return [self.play_round(n, client, batch_size) for n in range(1, self.rounds + 1)]

    def play_round(self, n: int, client: LLMClient, batch_size: int = 10) -> RoundLog:
        ctx = self.context(n)
        decisions: dict[str, Decision] = {}
        notes: list[str] = []
        for start in range(0, len(self.agents), batch_size):
            batch = request_decisions(
                client, ctx, [self.card(a) for a in self.agents[start : start + batch_size]], temperature=0.8
            )
            decisions.update(batch)
            notes += batch.notes
        return self.apply(RoundLog(n, decisions, notes))

    def context(self, n: int) -> RoundContext:
        price = self.price
        market = MarketView(
            price=fmt(price),
            change_pct_since_start=_change(self.start_price, price),
            change_pct_last_round=_change(self.round_start_price, price),
            reserve_eth=fmt(self.reserve_eth),
            reserve_token=fmt(self.reserve_token),
            holders=sum(1 for amount in self.tokens.values() if amount > 0),
            recent_swaps=self.swaps[-SWAPS_SHOWN:],
        )
        return RoundContext(
            scenario_title=TITLE,
            scenario_text=SEED,
            round_n=n,
            total_rounds=self.rounds,
            events_now=list(self.events.get(n, [])),
            events_earlier=[(r, text) for r in sorted(self.events) if r < n for text in self.events[r]],
            market=market,
            feed=[post.view() for post in reversed(self.posts[-FEED_SIZE:])],
        )

    def card(self, spec: AgentSpec) -> AgentCard:
        agent = spec.agent_id
        value = self.tokens[agent] * self.price
        mine = {post.id for post in self.posts if post.author == agent}
        newest = list(reversed(self.posts))
        return AgentCard(
            agent_id=agent,
            handle=spec.handle,
            persona_id=spec.persona.id,
            profile=spec.persona.describe(),
            eth_balance=fmt(self.eth[agent]),
            token_balance=fmt(self.tokens[agent]),
            token_value_eth=fmt(value),
            pnl_eth=fmt(self.eth[agent] + value - self.start_value[agent]),
            cap_eth=str(spec.per_agent_cap_eth),
            own_recent_posts=[post.view() for post in newest if post.author == agent][:2],
            replies_to_me=[p.view() for p in newest if p.reply_to in mine and p.author != agent][:3],
            detailed_market=self._detail() if agent in self.checked else None,
        )

    def apply(self, log: RoundLog) -> RoundLog:
        self.round_start_price = self.price
        self.checked = set()
        by_id = {post.id: post for post in self.posts}
        for spec in self.agents:
            decision = log.decisions[spec.agent_id]
            self._apply_social(spec, decision, log, by_id)
            self._apply_market(spec, decision.market or {"action": "hold"}, log)
        return log

    def _apply_social(self, spec: AgentSpec, d: Decision, log: RoundLog, by_id: dict[str, StubPost]) -> None:
        for post_id in d.likes:
            by_id[post_id].likes += 1
            log.likes += 1
        if d.post is None:
            return
        prefix = "c" if d.post.reply_to else "p"
        self._counters[prefix] += 1
        new = StubPost(f"{prefix}{self._counters[prefix]}", spec.agent_id, spec.handle, d.post.text,
                       d.post.reply_to, log.n)  # fmt: skip
        if new.reply_to:
            by_id[new.reply_to].replies += 1
        self.posts.append(new)
        log.posts.append(new)

    def _apply_market(self, spec: AgentSpec, market: dict[str, Any], log: RoundLog) -> None:
        agent, action = spec.agent_id, market.get("action")
        if action == "swap_buy":
            amount = Decimal(market["amountEth"])
            if not 0 < amount <= min(spec.per_agent_cap_eth, self.eth[agent] - GAS_RESERVE_ETH):
                log.invalid.append((agent, f"buy {amount} out of bounds"))
                return
            out = self._swap_out(amount, self.reserve_eth, self.reserve_token)
            self.reserve_eth += amount
            self.reserve_token -= out
            self.eth[agent] -= amount
            self.tokens[agent] += out
            self._record(spec, action, amount, out)
        elif action == "swap_sell":
            fraction = Decimal(market["fraction"])
            if not 0 < fraction <= 1 or self.tokens[agent] <= 0:
                log.invalid.append((agent, f"sell {fraction} of {self.tokens[agent]} tokens"))
                return
            amount = (self.tokens[agent] * fraction).quantize(Q18, rounding=ROUND_DOWN)
            out = self._swap_out(amount, self.reserve_token, self.reserve_eth)
            self.reserve_token += amount
            self.reserve_eth -= out
            self.tokens[agent] -= amount
            self.eth[agent] += out
            self._record(spec, action, amount, out)
        elif action == "check_market":
            self.checked.add(agent)
        elif action != "hold":
            log.invalid.append((agent, f"unknown action {action!r}"))
            return
        log.actions.append((agent, str(action)))

    @staticmethod
    def _swap_out(amount_in: Decimal, reserve_in: Decimal, reserve_out: Decimal) -> Decimal:
        with localcontext() as ctx:
            ctx.prec = 60
            effective = amount_in * (1 - FEE)
            return (reserve_out * effective / (reserve_in + effective)).quantize(Q18, rounding=ROUND_DOWN)

    def _record(self, spec: AgentSpec, kind: str, amount_in: Decimal, amount_out: Decimal) -> None:
        self.swaps.append({"handle": spec.handle, "kind": kind, "amountIn": fmt(amount_in),
                           "amountOut": fmt(amount_out), "priceAfter": fmt(self.price)})  # fmt: skip

    def _detail(self) -> dict[str, Any]:
        return {
            "price": fmt(self.price),
            "reserveEth": fmt(self.reserve_eth),
            "reserveToken": fmt(self.reserve_token),
            "holders": sum(1 for amount in self.tokens.values() if amount > 0),
            "swapsSoFar": len(self.swaps),
        }


def _change(before: Decimal, after: Decimal) -> float:
    return round(float((after - before) / before * 100), 4) + 0.0
