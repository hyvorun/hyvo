from __future__ import annotations

import json
import random
import re
from dataclasses import replace
from decimal import Decimal
from itertools import count
from typing import Any

import pytest

from hyvo.decisions import (
    MAX_POST_CHARS,
    MAX_REASON_CHARS,
    PROTOCOL,
    build_messages,
    max_buy_eth,
    parse_decisions,
    register_offline,
    visible_posts,
)
from hyvo.decisions import offline_policy
from hyvo.decisions.offline_policy import respond
from hyvo.decisions.offline_templates import DEFAULT, POSTS, REASONS
from hyvo.llm import offline
from hyvo.llm.offline import OfflineClient
from hyvo.personas import STAGE1
from hyvo.report.guard import find_violations

from . import samples
from .stub_world import StubWorld

RUMOR_ROUND, AUDIT_ROUND = 4, 7
EVENTS = {
    RUMOR_ROUND: ["Rumor: the dev wallet sold 20% of supply"],
    AUDIT_ROUND: ["Audit passed and a second listing was announced"],
}
EVENT_SCRIPTS = [
    EVENTS,
    {2: ["Partnership with a wallet app confirmed"], 5: ["Exploit drained the staking contract"]},
    {3: ["Team burned 10% of supply"], 6: ["Lawsuit filed against the founders"], 8: ["Liquidity locked for a year"]},
    {},
]
COMMON_SITUATIONS = ("bull", "bear", "news_up", "news_down", "checking", "checked", "reply_bull", "reply_bear")
CONDITIONAL = ("{chg}", "{start}", "{buys}", "{sells}", "{pnl}")
EXTREME = {
    "round": 9999, "rounds": 9999, "chg": "-100.0%", "start": "+12345.6%", "drop": "100.0%", "rise": "999.9%",
    "holders": 9999, "price": "0.000001235", "pool": "123456.78", "buys": 6, "sells": 6, "amt": "0.299",
    "pct": "100%", "pnl": "-12345.6789 ETH", "handle": "@cosmicnarwhal99",
}  # fmt: skip
FORBIDDEN_WORDS = re.compile(r"\b(?:buy|sell|will|should|must|guarantee\w*)\b", re.IGNORECASE)


def client(seed: int = 7) -> OfflineClient:
    return OfflineClient(seed, {PROTOCOL: respond})


def all_decisions(logs) -> list[dict]:
    return [decision.to_dict() for log in logs for decision in log.decisions.values()]


def persona_of(agent_id: str, world: StubWorld) -> str:
    return next(spec.persona.id for spec in world.agents if spec.agent_id == agent_id)


@pytest.fixture(scope="module")
def ten_rounds():
    world = StubWorld(seed=0, events=EVENTS)
    return world, world.run(client())


def test_register_offline_is_idempotent(monkeypatch):
    monkeypatch.setattr(offline, "_REGISTRY", {})
    register_offline()
    register_offline()
    assert offline._REGISTRY == {PROTOCOL: respond}
    ctx = samples.context()
    result = OfflineClient(1).complete(
        build_messages(ctx, samples.cards(2)), temperature=0.8, max_tokens=640, json_mode=True, purpose="agents"
    )
    assert [d["agentId"] for d in json.loads(result.text)["decisions"]] == ["a01", "a02"]


def test_same_prompt_same_answer():
    messages = build_messages(samples.context(), samples.cards(10, samples.context().feed))
    first = respond(messages, random.Random(3))
    assert respond(messages, random.Random(3)) == first
    assert respond(messages, random.Random(4)) != first
    ask = {"temperature": 0.8, "max_tokens": 2400, "json_mode": True, "purpose": "agents"}
    assert client(5).complete(messages, **ask).text == client(5).complete(messages, **ask).text


def test_whole_runs_are_deterministic(ten_rounds):
    _, logs = ten_rounds
    again = StubWorld(seed=0, events=EVENTS).run(client())
    assert all_decisions(again) == all_decisions(logs)
    other = StubWorld(seed=0, events=EVENTS).run(client(8))
    assert all_decisions(other) != all_decisions(logs)


def test_ten_rounds_of_fifty_agents_cover_every_behavior(ten_rounds):
    world, logs = ten_rounds
    assert len(world.agents) == 50 and len(logs) == 10
    assert all(log.posts for log in logs), "posts in every round"
    assert sum(log.count("swap_buy") for log in logs) > 0
    assert sum(log.count("swap_sell") for log in logs) > 0
    assert sum(log.count("check_market") for log in logs) > 0
    assert sum(len(log.replies) for log in logs) > 0
    assert sum(log.likes for log in logs) > 0
    assert [entry for log in logs for entry in log.invalid] == [], "amounts respect balance, cap and holdings"
    assert all(len(log.actions) == 50 for log in logs), "one market action per agent per round"


def test_every_offline_answer_parses_cleanly(ten_rounds):
    _, logs = ten_rounds
    assert [note for log in logs for note in log.batch_notes] == []
    assert [d["notes"] for d in all_decisions(logs) if d["notes"]] == []


def test_personas_act_in_character(ten_rounds):
    world, logs = ten_rounds

    def kinds(log, persona):
        return [kind for agent, kind in log.actions if persona_of(agent, world) == persona]

    assert "swap_buy" in kinds(logs[0], "sniper"), "snipers buy early"
    assert "swap_sell" in kinds(logs[RUMOR_ROUND - 1], "panic_seller"), "panic sellers sell on the rumor"
    holder = [kind for log in logs for kind in kinds(log, "holder")]
    assert holder.count("hold") > len(holder) / 2, "holders mostly hold"
    skeptic_replies = [p for log in logs for p in log.replies if persona_of(p.author, world) == "skeptic"]
    assert skeptic_replies, "skeptics reply"

    def mood(log):
        return sum(d.sentiment for d in log.decisions.values()) / len(log.decisions)

    assert mood(logs[RUMOR_ROUND - 1]) < mood(logs[RUMOR_ROUND - 2]) - 0.1, "the rumor sours the crowd"
    assert mood(logs[AUDIT_ROUND - 1]) > mood(logs[AUDIT_ROUND - 2]) + 0.1, "the audit lifts it"


def test_two_thousand_offline_posts_never_trip_the_copy_guard():
    posts, reasons = [], []
    for seed in count():
        world = StubWorld(seed=seed, events=EVENT_SCRIPTS[seed % len(EVENT_SCRIPTS)])
        for log in world.run(client(seed)):
            assert log.batch_notes == [] and all(d.notes == [] for d in log.decisions.values())
            posts += [post.text for post in log.posts]
            reasons += [d.reason for d in log.decisions.values()]
        if len(posts) >= 2000:
            break
    assert [text for text in posts if find_violations(text)] == []
    assert max(map(len, posts)) <= MAX_POST_CHARS and max(map(len, reasons)) <= MAX_REASON_CHARS
    assert [text for text in reasons if find_violations(text)] == []
    assert len(set(posts)) > 400, "varied voices"


@pytest.mark.parametrize("seed", range(12))
def test_buys_stay_within_max_buy_and_sells_need_tokens(seed):
    snipers = [i for i, spec in enumerate(samples.CROWD) if spec.persona.id == "sniper"][:3]
    holders = [i for i, spec in enumerate(samples.CROWD) if spec.persona.id == "holder"][:3]
    balances = ("0.004", "0.02", "2")  # max buy 0, then below the cap, then the cap
    cards = [
        samples.card(i, eth_balance=eth, token_balance="0", token_value_eth="0", pnl_eth="0")
        for group in (snipers, holders)
        for i, eth in zip(group, balances, strict=True)
    ]
    ctx = samples.context(round_n=1, events_now=[], events_earlier=[], feed=[])
    decisions = json.loads(respond(build_messages(ctx, cards), random.Random(seed)))["decisions"]
    actions = []
    for card, decision in zip(cards, decisions, strict=True):
        market = decision["market"]
        actions.append(market["action"])
        if market["action"] == "swap_buy":
            assert Decimal("0.001") <= Decimal(market["amountEth"]) <= max_buy_eth(card)
        assert market["action"] != "swap_sell", "no tokens, no sell"
    assert actions[0] != "swap_buy" and actions[3] != "swap_buy", "nothing to spend"


def test_answers_with_tight_inputs_still_parse_cleanly():
    reply = samples.post("c9", 30, reply_to="p8", text="Is this a rug?? Scared.")
    cards = [
        samples.card(0, replies_to_me=[reply], detailed_market={"reserveEth": "10"}),
        samples.card(1, persona_id="wizard", profile="Archetype: Wizard\nGoal: move markets"),
        samples.card(2, eth_balance="0"),
    ]
    for round_n, feed in ((1, []), (5, samples.feed(15, round_n=4))):
        ctx = samples.context(round_n=round_n, feed=feed)
        posts = visible_posts(ctx, cards)
        for seed in range(30):
            text = respond(build_messages(ctx, cards), random.Random(seed))
            batch = parse_decisions(text, [c.agent_id for c in cards], posts, {k: p.author_agent_id for k, p in posts.items()})
            assert batch.notes == [] and all(d.notes == [] for d in batch.values())
            raw = {d["agentId"]: d for d in json.loads(text)["decisions"]}
            for agent_id, decision in batch.items():
                assert decision.to_dict() | {"notes": []} == raw[agent_id] | {"notes": []}, "parsing changed nothing"
            assert batch["a02"].market["action"] in ("hold", "check_market"), "unknown personas do not trade"


def test_each_persona_has_enough_post_templates():
    for persona, table in POSTS.items():
        assert sum(len(options) for options in table.values()) >= (20 if persona in STAGE1 else 10), persona


def _world(**changes: Any) -> offline_policy._World:
    values: dict[str, Any] = {
        "round": 4,
        "rounds": 10,
        "momentum": 0.0,
        "runup": 0.0,
        "news": 0.0,
        "events": 0.0,
        "social": 0.0,
        "buys": 2,
        "sells": 2,
        "holders": 20,
        "price": "0.0001",
        "pool": "10",
        "feed": (),
        "posts": {},
    }
    return offline_policy._World(**{**values, **changes})


def _agent(persona: str, *, holding: bool = True, pnl: str = "0") -> offline_policy._Agent:
    tokens = Decimal("1000") if holding else Decimal(0)
    value = Decimal("0.2") if holding else Decimal(0)
    return offline_policy._Agent(
        id="a01", persona=persona, eth=Decimal("1"), tokens=tokens, value=value, pnl=Decimal(pnl), max_buy=Decimal("1"), replies_to_me=(), checked=False, liked=frozenset()
    )


def _moves(persona: str, world: offline_policy._World, **agent: Any) -> set[str]:
    policy = offline_policy.POLICIES[persona]
    return {policy(_agent(persona, **agent), world, random.Random(seed)).kind for seed in range(60)}


LOUD_POST = offline_policy._Post("p1", "a09", "@loud", 5, 0.8)


@pytest.mark.parametrize(
    ("persona", "world", "agent", "expected"),
    [
        ("swing_trader", {"momentum": -4.0}, {"holding": False}, "swap_buy"),
        ("swing_trader", {"runup": 20.0, "momentum": 0.0}, {}, "swap_sell"),
        ("whale", {"round": 2}, {"holding": False}, "swap_buy"),
        ("whale", {"runup": 25.0}, {}, "swap_sell"),
        ("kol_follower", {"social": 0.5, "feed": (LOUD_POST,)}, {"holding": False}, "swap_buy"),
        ("kol_follower", {"social": -0.5}, {}, "swap_sell"),
        ("market_maker_bot", {"momentum": 3.0}, {}, "swap_sell"),
        ("market_maker_bot", {"momentum": -3.0}, {}, "swap_buy"),
        ("stock_token_holder", {"news": 0.5}, {"holding": False}, "swap_buy"),
        ("stock_token_holder", {"news": -0.5}, {}, "swap_sell"),
        ("newcomer", {"runup": 12.0}, {"holding": False}, "swap_buy"),
        ("newcomer", {"momentum": -8.0}, {}, "swap_sell"),
    ],
)
def test_a_later_persona_acts_on_what_its_profile_says(persona: str, world: dict[str, Any], agent: dict[str, Any], expected: str) -> None:
    assert expected in _moves(persona, _world(**world), **agent)


@pytest.mark.parametrize(
    ("persona", "world", "agent", "absent"),
    [
        ("whale", {"round": 2, "pool": "1"}, {"holding": False}, "swap_buy"),  # the pool is too thin for its size
        ("market_maker_bot", {"momentum": 0.2}, {}, "swap_sell"),  # no clear move
        ("market_maker_bot", {"momentum": 0.2}, {}, "swap_buy"),
        ("stock_token_holder", {"news": 0.5, "round": 1}, {"holding": False}, "swap_buy"),  # not in the first round
        ("newcomer", {"runup": 0.0}, {"holding": False}, "swap_buy"),  # nothing to join yet
    ],
)
def test_a_later_persona_stays_out_when_its_profile_says_so(persona: str, world: dict[str, Any], agent: dict[str, Any], absent: str) -> None:
    assert absent not in _moves(persona, _world(**world), **agent)


def test_a_bot_barely_talks() -> None:
    assert offline_policy.POST_P["market_maker_bot"] < offline_policy.POST_P["whale"] < offline_policy.POST_P["holder"]
    assert offline_policy.REPLY_P["market_maker_bot"] == 0


def test_every_situation_has_a_template_that_needs_no_conditional_number():
    for table in (*POSTS.values(), DEFAULT):
        for situation in COMMON_SITUATIONS:
            if situation in table:
                assert any(not any(p in t for p in CONDITIONAL) for t in table[situation]), situation
    assert set(COMMON_SITUATIONS) <= set(DEFAULT)


def test_templates_fill_short_clean_and_without_advice_words():
    for table in (*POSTS.values(), DEFAULT, REASONS):
        for situation, options in table.items():
            for template in options:
                text = template.format(**EXTREME)
                limit = MAX_REASON_CHARS if table is REASONS else MAX_POST_CHARS
                assert len(text) <= limit and find_violations(text) == [], (situation, text)
                assert not FORBIDDEN_WORDS.search(template), template
                assert text == " ".join(text.split()) and "http" not in text, template


def test_offline_agents_never_like_a_post_twice() -> None:
    feed = [
        samples.post(f"p{i}", author=40 + i, text="Momentum looks strong here, nice volume")
        for i in range(1, 6)
    ]
    batch_cards = [replace(c, liked=[p.id for p in feed]) for c in samples.cards(10, feed)]
    result = client().complete(
        build_messages(samples.context(feed=feed), batch_cards),
        temperature=0.8, max_tokens=4000, json_mode=True, purpose="agents",
    )  # fmt: skip
    decisions = json.loads(result.text)["decisions"]
    assert all(d["likes"] == [] for d in decisions)
