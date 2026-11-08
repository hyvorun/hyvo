"""Deterministic offline responder for ``agent_decisions/v2``: a persona-driven rules model.

It reads only the prompt's DATA block and the rng that the offline client seeds from the
messages, so the same prompt always gets the same answer. Per persona:

- sniper: buys in the first rounds and on momentum, takes profit on run-ups, exits pullbacks;
- holder: builds a position early, adds on dips and good news, mostly holds, trims on hard news;
- panic_seller: sells 30-100% on drops, scary events or losses; may come back late after a rise;
- skeptic: posts objections, replies to bullish posts, trims small or holds, rarely starts small;
- swing_trader: takes pullbacks, trims a stall after a run-up;
- whale: enters early in pieces when the pool can take it, leaves in pieces into a run-up;
- kol_follower: follows the feed's mood in both directions, more so when posts collect likes;
- market_maker_bot: trades small against every move and almost never posts;
- stock_token_holder: a small side bet on good news, out on bad news;
- newcomer: joins after a rise, leaves on a fright;
- clone: sized by its own cap; enters early or on a rise, leaves on a gain or a drop;
- everyone: checks the market now and then. Unknown personas only hold, check and post.

Buys stay within the card's max buy (cap and balance minus gas reserve); sells need tokens.
Event, title and post text move the policy through ``lexicon.tone``.
"""

from __future__ import annotations

import json
import random
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from decimal import ROUND_DOWN, Decimal
from typing import Any

from hyvo.llm.offline import register_responder
from hyvo.llm.types import ChatMessage
from hyvo.personas import ARCHETYPES
from hyvo.report.prompt import extract_data

from .lexicon import tone
from .numbers import eth, pct, plain, sig, signed_eth
from .offline_templates import DEFAULT, FALLBACK, POSTS, REASONS
from .prompt import MAX_LIKES, PROTOCOL, rows

MIN_BUY_ETH = Decimal("0.001")
MIN_POSITION_ETH = Decimal("0.0005")  # smaller token holdings count as "not holding"
_BUY_STEP = Decimal("0.001")
_DEFAULT_SIZE = (0.01, 0.03)

CHECK_P = {
    "sniper": 0.04,
    "holder": 0.05,
    "panic_seller": 0.1,
    "skeptic": 0.1,
    "swing_trader": 0.1,
    "whale": 0.15,
    "kol_follower": 0.02,
    "market_maker_bot": 0.0,
    "stock_token_holder": 0.15,
    "newcomer": 0.06,
}
POST_P = {
    "sniper": 0.4,
    "holder": 0.3,
    "panic_seller": 0.35,
    "skeptic": 0.45,
    "swing_trader": 0.25,
    "whale": 0.06,
    "kol_follower": 0.45,
    "market_maker_bot": 0.02,
    "stock_token_holder": 0.2,
    "newcomer": 0.4,
}
REPLY_P = {
    "sniper": 0.15,
    "holder": 0.4,
    "panic_seller": 0.3,
    "skeptic": 0.5,
    "swing_trader": 0.15,
    "whale": 0.05,
    "kol_follower": 0.55,
    "market_maker_bot": 0.0,
    "stock_token_holder": 0.25,
    "newcomer": 0.5,
}
LIKE_WEIGHTS = {  # weights of liking 0, 1, 2 or 3 posts
    "sniper": (0.3, 0.3, 0.25, 0.15),
    "holder": (0.35, 0.3, 0.2, 0.15),
    "panic_seller": (0.35, 0.3, 0.2, 0.15),
    "skeptic": (0.5, 0.3, 0.15, 0.05),
    "swing_trader": (0.6, 0.3, 0.1, 0.0),
    "whale": (0.9, 0.1, 0.0, 0.0),
    "kol_follower": (0.1, 0.25, 0.35, 0.3),
    "market_maker_bot": (1.0, 0.0, 0.0, 0.0),
    "stock_token_holder": (0.6, 0.3, 0.1, 0.0),
    "newcomer": (0.25, 0.35, 0.25, 0.15),
}
BASE_MOOD = {
    "sniper": 0.35,
    "holder": 0.45,
    "panic_seller": 0.0,
    "skeptic": -0.3,
    "swing_trader": 0.05,
    "whale": 0.1,
    "kol_follower": 0.3,
    "market_maker_bot": 0.0,
    "stock_token_holder": -0.1,
    "newcomer": 0.2,
}
# How strongly each persona feels bad / good swings (crowd psychology, not market logic).
SWING_SCALE = {
    "panic_seller": (1.4, 1.0),
    "holder": (0.6, 1.0),
    "skeptic": (0.7, 0.5),
    "swing_trader": (0.6, 0.6),
    "whale": (0.4, 0.4),
    "kol_follower": (1.1, 1.3),
    "market_maker_bot": (0.0, 0.0),
    "stock_token_holder": (0.8, 0.5),
    "newcomer": (1.3, 1.2),
}
NEWS = 0.3  # |tone| of this round's events that counts as news
HARD_NEWS = -0.8  # tone of events a holder treats as credible risk (exploit, rug, scam, ...)


def register_offline() -> None:
    """Register ``respond`` for ``agent_decisions/v2`` with the offline client (idempotent)."""
    register_responder(PROTOCOL, respond)


def respond(messages: Sequence[ChatMessage], rng: random.Random) -> str:
    """The offline answer to one batch prompt: one valid decision per agent, as JSON text."""
    data = extract_data(messages)
    world = _World.read(data)
    base = rng.getrandbits(64)
    used: set[str] = set()  # templates already used in this batch, so voices differ
    decisions = [
        _decide(agent, world, random.Random(f"{base}:{agent.id}"), used)
        for agent in map(_Agent.read, rows(data, "agents"))
    ]
    return json.dumps({"decisions": decisions}, ensure_ascii=False, separators=(",", ":"))


@dataclass(frozen=True)
class _Post:
    id: str
    by: str
    handle: str
    likes: int
    tone: float


@dataclass(frozen=True)
class _World:
    round: int
    rounds: int
    momentum: float  # price change last round, percent
    runup: float  # price change since the start, percent
    news: float  # tone of this round's events
    events: float  # this round's events, earlier events (decaying) and the title
    social: float  # like-weighted tone of the feed
    buys: int
    sells: int
    holders: int
    price: str
    pool: str
    feed: tuple[_Post, ...]
    posts: Mapping[str, _Post]

    @classmethod
    def read(cls, data: Mapping[str, Any]) -> _World:
        round_n = data["round"]
        news = _clamp(sum(tone(text) for text in data["eventsNow"]), 1.0)
        earlier = sum(tone(text) * 0.5 ** (round_n - n) for n, text in data["eventsEarlier"])
        posts = [
            _Post(row["id"], row["by"], row["handle"], row["likes"], tone(row["text"]))
            for row in rows(data, "posts")
        ]
        feed = tuple(posts[: data["feedCount"]])
        weight = sum(1 + post.likes for post in feed)
        kinds = [swap["kind"] for swap in rows(data, "swaps")]
        market = data["market"]
        return cls(
            round=round_n,
            rounds=data["rounds"],
            momentum=market["changeLastPct"],
            runup=market["changeStartPct"],
            news=news,
            events=_clamp(news + earlier + 0.3 * tone(data["title"]), 1.0),
            social=sum((1 + p.likes) * p.tone for p in feed) / weight if feed else 0.0,
            buys=kinds.count("swap_buy"),
            sells=kinds.count("swap_sell"),
            holders=market["holders"],
            price=market["price"],
            pool=market["reserveEth"],
            feed=feed,
            posts={post.id: post for post in posts},
        )

    @property
    def flow(self) -> float:
        """Net direction of the recent swaps in [-1, 1]."""
        return (self.buys - self.sells) / max(1, self.buys + self.sells)


@dataclass(frozen=True)
class _Agent:
    id: str
    persona: str
    eth: Decimal
    tokens: Decimal
    value: Decimal
    pnl: Decimal
    max_buy: Decimal
    replies_to_me: tuple[str, ...]
    checked: bool  # it chose check_market last round
    liked: frozenset[str]  # posts it already liked
    cap: Decimal = Decimal("0.05")  # the most it swaps at once

    @classmethod
    def read(cls, row: Mapping[str, Any]) -> _Agent:
        return cls(
            id=row["agentId"],
            persona=row["persona"],
            eth=Decimal(row["eth"]),
            tokens=Decimal(row["tokens"]),
            value=Decimal(row["tokenValueEth"]),
            pnl=Decimal(row["pnlEth"]),
            max_buy=Decimal(row["maxBuyEth"]),
            replies_to_me=tuple(row["repliesToMe"]),
            checked=row["detailedMarket"] is not None,
            liked=frozenset(row["liked"]),
            cap=Decimal(row["capEth"]),
        )

    @property
    def holding(self) -> bool:
        return self.tokens > 0 and self.value >= MIN_POSITION_ETH

    @property
    def pnl_frac(self) -> float:
        """PnL relative to the starting value (current value minus PnL)."""
        basis = self.eth + self.value - self.pnl
        return float(self.pnl / basis) if basis > 0 else 0.0

    @property
    def size(self) -> tuple[float, float]:
        if self.persona == "clone":  # not an archetype: its size is its own, and only the cap says it here
            return float(self.cap) / 3, float(self.cap) / 1.25
        persona = ARCHETYPES.get(self.persona)
        return persona.typical_size_eth if persona else _DEFAULT_SIZE


@dataclass(frozen=True)
class _Move:
    kind: str  # swap_buy | swap_sell | hold | check_market
    why: str  # template and reason key
    amount: Decimal | None = None  # ETH in, for swap_buy
    fraction: Decimal | None = None  # share of tokens, for swap_sell

    def market(self) -> dict[str, str]:
        if self.kind == "swap_buy" and self.amount is not None:
            return {"action": "swap_buy", "amountEth": plain(self.amount)}
        if self.kind == "swap_sell" and self.fraction is not None:
            return {"action": "swap_sell", "fraction": plain(self.fraction)}
        return {"action": self.kind}


HOLD = _Move("hold", "hold")


def _decide(agent: _Agent, world: _World, rng: random.Random, used: set[str]) -> dict[str, Any]:
    if not agent.checked and rng.random() < CHECK_P.get(agent.persona, 0.08):
        move = _Move("check_market", "check")
    else:
        move = POLICIES.get(agent.persona, _watcher)(agent, world, rng)
    mood = _sentiment(agent, world, move, rng)
    params = _params(agent, world, move)
    return {
        "agentId": agent.id,
        "post": _post(agent, world, move, mood, params, rng, used),
        "likes": _likes(agent, world, mood, rng),
        "market": move.market(),
        "sentiment": mood,
        "reason": _reason(move, mood, params, rng),
    }


# --- market policies ------------------------------------------------------------------------


def _sniper(a: _Agent, w: _World, rng: random.Random) -> _Move:
    low, high = a.size
    if a.holding:
        if (w.runup >= 15 or a.pnl_frac >= 0.12) and rng.random() < 0.6:
            return _sell(rng, 0.5, 1.0, "profit" if a.pnl > 0 else "cut")
        if (w.momentum <= -4 or w.news <= -0.4) and rng.random() < 0.65:
            return _sell(rng, 0.6, 1.0, "cut")
    if a.value < Decimal(str(high)) * 2:
        if w.round <= 2 and rng.random() < 0.8:
            return _buy(a, rng, low, high, "early")
        if w.momentum >= 3 and rng.random() < 0.45:
            return _buy(a, rng, low, high, "momentum")
    return HOLD


def _holder(a: _Agent, w: _World, rng: random.Random) -> _Move:
    low, high = a.size
    if w.news <= HARD_NEWS:  # credible bad news is the one thing that moves a holder out
        return _sell(rng, 0.3, 0.7, "evidence") if a.holding and rng.random() < 0.4 else HOLD
    if w.momentum <= -3 and rng.random() < 0.5:
        return _buy(a, rng, low, (low + high) / 2, "dip")
    if w.round <= 2 and a.value < Decimal(str(high)) and rng.random() < 0.5:
        return _buy(a, rng, low, high, "build")
    if w.news >= NEWS and rng.random() < 0.35:
        return _buy(a, rng, low, high, "news")
    return HOLD


def _panic_seller(a: _Agent, w: _World, rng: random.Random) -> _Move:
    low, high = a.size
    if a.holding:
        why = (
            "fear_drop" if w.momentum <= -3
            else "fear_news" if w.news <= -NEWS
            else "fear_loss" if a.pnl_frac <= -0.08
            else None
        )  # fmt: skip
        fear = max(0.0, -w.momentum) / 10 + max(0.0, -w.news) + max(0.0, -w.social) / 2
        if why and rng.random() < min(0.95, 0.5 + fear):
            return _sell(rng, min(0.3 + fear / 2, 0.9), 1.0, why)
    elif w.round > w.rounds // 2 and w.momentum >= 3 and w.runup > 0 and rng.random() < 0.35:
        return _buy(a, rng, low, (low + high) / 2, "fomo")
    return HOLD


def _skeptic(a: _Agent, w: _World, rng: random.Random) -> _Move:
    low, high = a.size
    if a.holding and (w.momentum <= -2 or w.news <= -NEWS) and rng.random() < 0.4:
        return _sell(rng, 0.1, 0.35, "trim")
    broad_activity = w.round >= 3 and w.flow > 0.3 and w.runup > 0 and w.news >= 0
    if not a.holding and broad_activity and rng.random() < 0.15:
        return _buy(a, rng, low, (low + high) / 2, "starter")
    return HOLD


def _swing_trader(a: _Agent, w: _World, rng: random.Random) -> _Move:
    low, high = a.size
    if a.holding and w.runup >= 10 and w.momentum <= 1 and rng.random() < 0.55:
        return _sell(rng, 0.3, 0.8, "stall")
    if w.momentum <= -3 and w.news > HARD_NEWS and rng.random() < 0.5:
        return _buy(a, rng, low, high, "pullback")
    return HOLD


def _whale(a: _Agent, w: _World, rng: random.Random) -> _Move:
    low, high = a.size
    if a.holding and w.runup >= 15 and rng.random() < 0.45:
        return _sell(rng, 0.1, 0.3, "pieces_out")
    if w.news <= HARD_NEWS:
        return _sell(rng, 0.2, 0.5, "pieces_out") if a.holding and rng.random() < 0.5 else HOLD
    deep_enough = Decimal(w.pool) >= Decimal(str(high)) * 3
    if deep_enough and w.round <= 3 and rng.random() < 0.4:
        return _buy(a, rng, low, high, "pieces_in")
    return HOLD


def _kol_follower(a: _Agent, w: _World, rng: random.Random) -> _Move:
    low, high = a.size
    loud = max((post.likes for post in w.feed), default=0) >= 2
    if a.holding and w.social <= -0.15 and rng.random() < 0.6:
        return _sell(rng, 0.5, 1.0, "followed_out")
    if (w.social >= 0.05 or (loud and w.momentum > 0)) and rng.random() < (0.45 if loud else 0.2):
        return _buy(a, rng, low, high, "followed_in")
    return HOLD


def _market_maker_bot(a: _Agent, w: _World, rng: random.Random) -> _Move:
    low, high = a.size
    if a.holding and w.momentum >= 1:
        return _sell(rng, 0.03, 0.1, "rebalance_down")
    if w.momentum <= -1:
        return _buy(a, rng, low, high, "rebalance_up")
    return HOLD


def _stock_token_holder(a: _Agent, w: _World, rng: random.Random) -> _Move:
    low, high = a.size
    if a.holding and w.news <= -NEWS and rng.random() < 0.5:
        return _sell(rng, 0.5, 1.0, "side_bet_out")
    if not a.holding and w.news >= NEWS and w.round >= 2 and rng.random() < 0.3:
        return _buy(a, rng, low, high, "side_bet")
    return HOLD


def _newcomer(a: _Agent, w: _World, rng: random.Random) -> _Move:
    low, high = a.size
    if a.holding and (w.momentum <= -5 or w.news <= -NEWS or a.pnl_frac <= -0.15) and rng.random() < 0.6:
        return _sell(rng, 0.5, 1.0, "fright")
    if not a.holding and w.runup >= 5 and w.social >= 0 and rng.random() < 0.35:
        return _buy(a, rng, low, high, "joining")
    return HOLD


def _clone(a: _Agent, w: _World, rng: random.Random) -> _Move:
    low, high = a.size
    if a.holding and (a.pnl_frac >= 0.1 or w.momentum <= -4) and rng.random() < 0.6:
        return _sell(rng, 0.4, 1.0, "by_its_record_out")
    if a.value < Decimal(str(high)) * 2 and (w.round <= 2 or w.momentum >= 2) and rng.random() < 0.6:
        return _buy(a, rng, low, high, "by_its_record_in")
    return HOLD


def _watcher(a: _Agent, w: _World, rng: random.Random) -> _Move:
    return HOLD


POLICIES: Mapping[str, Callable[[_Agent, _World, random.Random], _Move]] = {
    "sniper": _sniper,
    "holder": _holder,
    "panic_seller": _panic_seller,
    "skeptic": _skeptic,
    "swing_trader": _swing_trader,
    "whale": _whale,
    "kol_follower": _kol_follower,
    "market_maker_bot": _market_maker_bot,
    "stock_token_holder": _stock_token_holder,
    "newcomer": _newcomer,
    "clone": _clone,
}


def _buy(a: _Agent, rng: random.Random, low: float, high: float, why: str) -> _Move:
    """A buy of a typical size, cut to the agent's max buy; a hold when that is too small."""
    amount = Decimal(str(rng.uniform(low, high))).quantize(_BUY_STEP, rounding=ROUND_DOWN)
    amount = min(amount, a.max_buy.quantize(_BUY_STEP, rounding=ROUND_DOWN))
    return _Move("swap_buy", why, amount=amount) if amount >= MIN_BUY_ETH else _Move("hold", "broke")


def _sell(rng: random.Random, low: float, high: float, why: str) -> _Move:
    fraction = Decimal(str(round(rng.uniform(low, high), 2)))
    return _Move("swap_sell", why, fraction=Decimal(1) if fraction >= Decimal("0.95") else fraction)


# --- sentiment and social actions -------------------------------------------------------------


def _sentiment(a: _Agent, w: _World, move: _Move, rng: random.Random) -> float:
    swing = (
        0.35 * w.news
        + 0.2 * w.events
        + _clamp(w.momentum / 25, 0.25)
        + 0.15 * w.social
        + _clamp(a.pnl_frac, 0.2)
    )
    bad, good = SWING_SCALE.get(a.persona, (1.0, 1.0))
    swing *= bad if swing < 0 else good
    mood = BASE_MOOD.get(a.persona, 0.0) + swing + {"swap_buy": 0.1, "swap_sell": -0.1}.get(move.kind, 0.0)
    return round(_clamp(mood + rng.uniform(-0.1, 0.1), 1.0), 2)


def _post(
    a: _Agent,
    w: _World,
    move: _Move,
    mood: float,
    params: dict[str, Any],
    rng: random.Random,
    used: set[str],
) -> dict[str, Any] | None:
    trading = move.kind in ("swap_buy", "swap_sell")
    target = None if trading else _reply_target(a, w, rng)  # traders post about their trade
    if target is not None and rng.random() < REPLY_P.get(a.persona, 0.2):
        key = "reply_bull" if target.tone > 0 else "reply_bear"
        text = _fill(a.persona, key, {**params, "handle": target.handle}, rng, used)
        return {"text": text, "replyTo": target.id}
    chance = POST_P.get(a.persona, 0.25)
    chance += 0.25 if trading else 0.0
    chance += 0.15 if abs(w.news) >= NEWS else 0.0
    chance += 0.1 if a.checked else 0.0
    if rng.random() >= min(chance, 0.9):
        return None
    return {"text": _fill(a.persona, _situation(a, w, move, mood), params, rng, used), "replyTo": None}


def _reply_target(a: _Agent, w: _World, rng: random.Random) -> _Post | None:
    """Skeptics and snipers answer bullish posts; holders answer doubts (replies to them first);
    panic sellers answer scary posts; others answer anything."""
    others = [post for post in w.feed if post.by != a.id]
    if a.persona == "kol_follower":
        pool = [post for post in others if post.likes >= 1] or others
    elif a.persona in ("skeptic", "sniper"):
        pool = [post for post in others if post.tone >= 0.2]
    elif a.persona == "holder":
        mine = [w.posts[i] for i in a.replies_to_me if i in w.posts and w.posts[i].by != a.id]
        pool = [post for post in mine if post.tone < 0] or [post for post in others if post.tone <= -0.2]
    elif a.persona == "panic_seller":
        pool = [post for post in others if post.tone <= -0.2]
    else:
        pool = others
    return rng.choices(pool, weights=[1 + post.likes for post in pool])[0] if pool else None


def _likes(a: _Agent, w: _World, mood: float, rng: random.Random) -> list[str]:
    """Up to three feed posts by others whose tone matches the agent's mood, popular ones first."""
    count = rng.choices(range(MAX_LIKES + 1), weights=LIKE_WEIGHTS.get(a.persona, (0.5, 0.3, 0.15, 0.05)))[0]
    pool = [
        p
        for p in w.feed
        if p.by != a.id and p.id not in a.liked and (p.tone == 0 or (p.tone > 0) == (mood > 0))
    ]
    likes: list[str] = []
    while pool and len(likes) < count:
        pick = rng.choices(pool, weights=[1 + post.likes for post in pool])[0]
        likes.append(pick.id)
        pool.remove(pick)
    return likes


def _situation(a: _Agent, w: _World, move: _Move, mood: float) -> str:
    if move.kind in ("swap_buy", "swap_sell"):
        return move.why
    if move.kind == "check_market":
        return "checking"
    if a.checked:
        return "checked"
    if w.news >= NEWS:
        return "news_up"
    if w.news <= -NEWS:
        return "news_down"
    if mood >= 0.15:
        return "green" if w.momentum >= 1 else "bull"
    return "red" if w.momentum <= -1 else "bear"


def _fill(persona: str, key: str, params: Mapping[str, Any], rng: random.Random, used: set[str]) -> str:
    """Fill a template for ``key``, preferring ones not used yet in this batch."""
    table = POSTS.get(persona, DEFAULT)
    options = table.get(key) or table.get(FALLBACK.get(key, "")) or DEFAULT[FALLBACK.get(key, key)]
    usable = [template for template in options if _usable(template, params)] or list(options)
    fresh = [template for template in usable if template not in used] or usable
    template = rng.choice(fresh)
    used.add(template)
    return template.format(**params)


_ZERO_VALUES = {"chg": "+0.0%", "start": "+0.0%", "pnl": "0 ETH", "buys": 0, "sells": 0}


def _usable(template: str, params: Mapping[str, Any]) -> bool:
    """False when the template would quote a number that is zero this round."""
    return not any(
        "{" + name + "}" in template and params[name] == zero for name, zero in _ZERO_VALUES.items()
    )


def _reason(move: _Move, mood: float, params: Mapping[str, Any], rng: random.Random) -> str:
    key = move.why if move.why in REASONS else ("hold_bull" if mood >= 0.15 else "hold_bear")
    return rng.choice(REASONS[key]).format(**params)


def _params(a: _Agent, w: _World, move: _Move) -> dict[str, Any]:
    return {
        "round": w.round,
        "rounds": w.rounds,
        "chg": pct(w.momentum),
        "start": pct(w.runup),
        "drop": f"{abs(w.momentum):.1f}%",
        "rise": f"{abs(w.momentum):.1f}%",
        "holders": w.holders,
        "price": sig(w.price, 4),
        "pool": eth(w.pool, 2),
        "buys": w.buys,
        "sells": w.sells,
        "amt": eth(move.amount, 3) if move.amount is not None else "",
        "pct": f"{int(move.fraction * 100)}%" if move.fraction is not None else "",
        "pnl": f"{signed_eth(a.pnl)} ETH",
    }


def _clamp(value: float, limit: float) -> float:
    return max(-limit, min(limit, value))
