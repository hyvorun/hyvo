from __future__ import annotations

import json
import sys
from typing import Any

import pytest

from hyvo.decisions import (
    Decision,
    DecisionBatch,
    PostIntent,
    hold_decisions,
    parse_decisions,
)
from hyvo.llm.types import LLMResponseError

AGENTS = ["a01", "a02", "a03"]
AUTHORS = {"p1": "a01", "p2": "a02", "c3": "a03", "p4": "a02", "p5": "a03"}


def parse(answer: Any, agents: list[str] = AGENTS) -> DecisionBatch:
    text = answer if isinstance(answer, str) else json.dumps(answer)
    return parse_decisions(text, agents, AUTHORS.keys(), AUTHORS)


def item(agent: Any = "a01", **overrides: Any) -> dict[str, Any]:
    base = {"agentId": agent, "post": {"text": "Holding steady.", "replyTo": None}, "likes": [],
            "market": {"action": "hold"}, "sentiment": 0.2, "reason": "calm"}  # fmt: skip
    return base | overrides


def one(**overrides: Any) -> Decision:
    """Parse a single decision for a01."""
    return parse({"decisions": [item(**overrides)]}, ["a01"])["a01"]


def test_clean_answer_parses_without_notes():
    batch = parse({"decisions": [item("a01"), item("a02"), item("a03")]})
    assert isinstance(batch, DecisionBatch) and list(batch) == AGENTS and batch.notes == []
    assert batch["a02"] == Decision("a02", PostIntent("Holding steady.", None), [], {"action": "hold"}, 0.2, "calm", [])


UNUSABLE = {
    "empty": "", "blank": "   ", "prose": "not json", "array": "[1, 2]", "no-list": '{"foo": 1}',
    "string-list": '{"decisions": "x"}', "number-list": '{"decisions": 5}', "truncated": '{"decisions": [',
    "lists-of-scalars": '{"a": [1], "b": [2]}', "nan": '{"sentiment": NaN, "decisions": []}', "none": None,
    "huge-int": '{"decisions": [], "x": ' + "1" * 5000 + "}",  # Python refuses ints over 4,300 digits
    "too-many-brackets": '{"decisions": [' + "{}, " * 1000 + "{}]}",
}  # fmt: skip
# Nesting deep enough to overflow the C stack of the JSON decoder once py_ecc (imported by web3)
# has raised the recursion limit to 100,000; the second one hides from naive depth scanners.
DEEP = {
    "deep": '{"decisions": ' + "[" * 100_000 + "]" * 100_000 + "}",
    "deep-trailing": '{"decisions": []} "' + '[ "]" ' * 30_000 + "]" * 30_000,
}


@pytest.mark.parametrize("text", [*UNUSABLE.values(), *DEEP.values()], ids=[*UNUSABLE, *DEEP])
def test_unusable_top_level_raises_for_a_retry(text):
    with pytest.raises(LLMResponseError):
        parse_decisions(text, AGENTS, AUTHORS.keys(), AUTHORS)


def test_deep_nesting_is_refused_before_decoding_even_with_a_high_recursion_limit():
    limit = sys.getrecursionlimit()
    sys.setrecursionlimit(max(100_000, limit))  # what importing web3 does
    try:
        for text in DEEP.values():
            with pytest.raises(LLMResponseError, match="too many brackets"):
                parse_decisions(text, AGENTS, AUTHORS.keys(), AUTHORS)
    finally:
        sys.setrecursionlimit(limit)


def test_a_large_batch_stays_under_the_bracket_cap():
    agents = [f"a{n:02d}" for n in range(1, 51)]
    answer = {"decisions": [item(agent, likes=["p2", "c3"]) for agent in agents[3:]]}
    batch = parse(answer, agents[3:])
    assert json.dumps(answer).count("[") + json.dumps(answer).count("{") > 150
    assert len(batch) == 47 and batch.notes == [] and all(d.notes == [] for d in batch.values())


def test_think_block_fence_and_trailing_prose_are_tolerated():
    body = json.dumps({"decisions": [item()]})
    batch = parse(f"<think>let me see</think>\n```json\n{body}\n```", ["a01"])
    assert batch["a01"].notes == []
    assert parse(body + "\nThose are my decisions.", ["a01"])["a01"].notes == []


@pytest.mark.parametrize(
    "answer",
    [
        {"decisions": {"a01": {k: v for k, v in item().items() if k != "agentId"}}},  # map by agent id
        {"decisions": item()},  # one decision object
        item(),  # a lone decision at top level
        {"agents": [item()]},  # the only list of objects
    ],
)
def test_alternative_shapes_are_accepted(answer):
    assert parse(answer, ["a01"])["a01"].notes == []


def test_missing_agents_hold_with_a_note():
    batch = parse({"decisions": [item("a02")]})
    assert batch["a02"].notes == []
    for agent in ("a01", "a03"):
        assert batch[agent] == Decision(agent, None, [], {"action": "hold"}, 0.0, "", ["missing_decision"])
    assert parse({"decisions": []})["a01"].notes == ["missing_decision"]


def test_unknown_agents_and_junk_items_become_batch_notes():
    batch = parse({"decisions": [item("a99"), "junk", 7, item("@quietferret42"), item("a01")]})
    assert batch.notes == ["unknown_agent", "item_invalid"]
    assert batch["a01"].notes == [] and batch["a02"].notes == ["missing_decision"]


@pytest.mark.parametrize("agent_id", ["A01", " a01 ", "a1", "a001", "01", 1])
def test_agent_id_variants_resolve(agent_id):
    assert parse({"decisions": [item(agent_id)]})["a01"].notes == []


@pytest.mark.parametrize(
    "agent_id", ["a" + "1" * 5000, 10**30, -1, None, 1.0, ["a01"]], ids=["long", "big", "neg", "none", "float", "list"]
)
def test_junk_agent_ids_are_unknown(agent_id):
    assert parse({"decisions": [item(agent_id)]}).notes == ["unknown_agent"]


def test_duplicate_decisions_keep_the_first():
    batch = parse({"decisions": [item(reason="first"), item(reason="second")]}, ["a01"])
    assert batch["a01"].reason == "first" and batch["a01"].notes == ["duplicate_decision"]


def test_extra_keys_are_ignored():
    decision = one(mood="great", post={"text": "gm", "replyTo": None, "emoji": "x"}, extra={"k": 1})
    assert decision.post == PostIntent("gm", None) and decision.notes == []


@pytest.mark.parametrize(
    "post, expected, notes",
    [
        (None, None, []),
        ("", None, []),
        ({"text": None, "replyTo": None}, None, []),
        ("Just a string post.", PostIntent("Just a string post.", None), []),
        ({"text": "agree", "replyTo": "p2"}, PostIntent("agree", "p2"), []),
        ({"text": "agree", "reply_to": "c3"}, PostIntent("agree", "c3"), []),
        ({"text": "agree", "replyTo": "p999"}, PostIntent("agree", None), ["reply_to_unknown"]),
        ({"text": "agree", "replyTo": 2}, PostIntent("agree", None), ["reply_to_unknown"]),
        ({"text": "   \n\t "}, None, ["post_empty"]),
        ({"text": "null"}, None, ["post_placeholder"]),
        ({"text": "..."}, None, ["post_placeholder"]),
        ({"text": "<listed post id>"}, None, ["post_placeholder"]),
        ("None", None, ["post_placeholder"]),
        ({"text": "None of this adds up."}, PostIntent("None of this adds up.", None), []),
        ({"text": 42}, None, ["post_invalid"]),
        (["a", "list"], None, ["post_invalid"]),
        ({"text": "a\u200bb\x00 c \n\n  d"}, PostIntent("ab c d", None), []),
        ({"text": "Chart at https://evil.example/x?ref=1 now"}, PostIntent("Chart at evil.example/x now", None),
         ["post_urls_stripped"]),
    ],
)  # fmt: skip
def test_post_rules(post, expected, notes):
    decision = one(post=post)
    assert decision.post == expected and decision.notes == notes


def test_long_posts_are_clipped_to_280_chars():
    decision = one(post={"text": "word " * 100})
    assert len(decision.post.text) <= 280 and decision.post.text.endswith("…")
    assert decision.notes == ["post_clipped"]


def test_copy_guard_redacts_offending_sentences():
    decision = one(post={"text": "Holding my bag. This is guaranteed to pump.", "replyTo": "p2"})
    assert decision.post == PostIntent("Holding my bag.", "p2")
    assert decision.notes == ["post_redacted:guaranteed"]


def test_copy_guard_drops_a_post_with_nothing_left():
    decision = one(post={"text": "Guaranteed 10x. It will moon!"})
    assert decision.post is None
    assert decision.notes == ["post_redacted:guaranteed", "post_redacted:will_pump", "post_dropped"]


def test_copy_guard_catches_advice_and_predictions():
    decision = one(post={"text": "I sold half. Buy the dip. The price will recover."})
    assert decision.post == PostIntent("I sold half.", None)
    assert decision.notes == ["post_redacted:advice_imperative", "post_redacted:price_prediction"]


@pytest.mark.parametrize(
    "likes, expected, notes",
    [
        (None, [], []),
        ("p2", ["p2"], []),
        (["p2", "p2", " c3 "], ["p2", "c3"], []),
        (["p2", "zz", 5], ["p2"], ["like_unknown"]),
        (["p1", "p2"], ["p2"], ["like_own"]),
        (["p2", "c3", "p4", "p5"], ["p2", "c3", "p4"], ["likes_capped"]),
        ({"p2": True}, [], ["likes_invalid"]),
    ],
)
def test_like_rules(likes, expected, notes):
    decision = one(likes=likes)
    assert decision.likes == expected and decision.notes == notes


def test_likes_without_an_author_map_only_check_known_ids():
    batch = parse_decisions(json.dumps({"decisions": [item(likes=["p1", "p9"])]}), ["a01"], AUTHORS.keys())
    assert batch["a01"].likes == ["p1"] and batch["a01"].notes == ["like_unknown"]


@pytest.mark.parametrize(
    "market, expected, notes",
    [
        ({"action": "swap_buy", "amountEth": "0.05"}, {"action": "swap_buy", "amountEth": "0.05"}, []),
        ({"action": "swap_sell", "fraction": 0.5, "slippage": 1}, {"action": "swap_sell", "fraction": 0.5, "slippage": 1},
         []),
        ({"action": "teleport"}, {"action": "teleport"}, []),  # kept raw; hyvo.actions validates
        (None, None, []),
        ({"action": 5}, None, ["market_invalid"]),
        ({"amountEth": "0.05"}, None, ["market_invalid"]),
        ("hold", None, ["market_invalid"]),
    ],
)  # fmt: skip
def test_market_is_kept_raw_when_it_names_an_action(market, expected, notes):
    decision = one(market=market)
    assert decision.market == expected and decision.notes == notes


def test_market_is_a_copy():
    answer = {"decisions": [item(market={"action": "hold"})]}
    decision = parse(answer, ["a01"])["a01"]
    decision.market["action"] = "changed"
    assert parse(answer, ["a01"])["a01"].market == {"action": "hold"}


@pytest.mark.parametrize(
    "sentiment, expected, notes",
    [
        (0.4, 0.4, []),
        (0, 0.0, []),
        ("-0.3", -0.3, []),
        (3, 1.0, ["sentiment_clamped"]),
        (-7.5, -1.0, ["sentiment_clamped"]),
        (None, 0.0, ["sentiment_missing"]),
        ("abc", 0.0, ["sentiment_invalid"]),
        ("nan", 0.0, ["sentiment_invalid"]),
        (True, 0.0, ["sentiment_invalid"]),
        ([0.5], 0.0, ["sentiment_invalid"]),
    ],
)
def test_sentiment_is_clamped_to_unit_range(sentiment, expected, notes):
    decision = one(sentiment=sentiment)
    assert decision.sentiment == expected and decision.notes == notes


@pytest.mark.parametrize(
    "reason, expected, notes",
    [
        (None, "", []),
        ("calm\x00\n  market", "calm market", []),
        (["x"], "", ["reason_invalid"]),
    ],
)
def test_reason_is_one_clean_line(reason, expected, notes):
    decision = one(reason=reason)
    assert decision.reason == expected and decision.notes == notes


def test_long_reasons_are_clipped_to_160_chars():
    decision = one(reason="because " * 40)
    assert len(decision.reason) <= 160 and decision.notes == ["reason_clipped"]


def test_notes_accumulate_per_agent_without_repeats():
    decision = one(post={"text": "x" * 300, "replyTo": "p0"}, likes=["zz", "yy", "p1"], sentiment=9)
    assert decision.notes == ["post_clipped", "reply_to_unknown", "like_unknown", "like_own", "sentiment_clamped"]


def test_hold_decisions():
    batch = hold_decisions(["a01", "a02"], "batch_failed")
    assert list(batch) == ["a01", "a02"] and batch.notes == []
    assert batch["a02"] == Decision("a02", None, [], {"action": "hold"}, 0.0, "", ["batch_failed"])


def test_a_like_the_agent_already_gave_is_dropped() -> None:
    answer = {
        "decisions": [
            {"agentId": "a01", "post": None, "likes": ["p1", "p2"], "market": {"action": "hold"},
             "sentiment": 0.1, "reason": "steady"},
        ]
    }  # fmt: skip
    batch = parse_decisions(
        json.dumps(answer), ["a01"], {"p1", "p2"}, {"p1": "a02", "p2": "a03"}, {"a01": {"p1"}}
    )
    assert batch["a01"].likes == ["p2"]
    assert "like_repeat" in batch["a01"].notes
