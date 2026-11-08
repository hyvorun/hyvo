from __future__ import annotations

import pytest

from hyvo.decisions import Decision, FeedPost, PostIntent

from . import samples


def test_valid_inputs_build():
    ctx = samples.context()
    assert ctx.round_n == 3 and len(ctx.feed) == 15
    assert samples.card(0).detailed_market is None


@pytest.mark.parametrize(
    "post_id, reply_to",
    [("x12", None), ("p", None), ("p1", "q2"), ("c1", None), ("p1", "p0")],
)
def test_feed_post_ids_follow_run_json(post_id, reply_to):
    with pytest.raises(ValueError):
        FeedPost(post_id, "a01", "@quietferret42", "text", reply_to, 0, 0, 1)


def test_feed_post_counts_are_whole_numbers():
    with pytest.raises(ValueError, match="likes"):
        FeedPost("p1", "a01", "@quietferret42", "text", None, -1, 0, 1)
    with pytest.raises(ValueError, match="round"):
        FeedPost("p1", "a01", "@quietferret42", "text", None, 0, 0, True)


@pytest.mark.parametrize(
    "field, value",
    [("price", "abc"), ("price", 0.5), ("reserve_eth", "-1"), ("change_pct_last_round", float("nan")),
     ("holders", -1), ("recent_swaps", [{"kind": "swap_buy"}])],
)  # fmt: skip
def test_market_view_rejects_malformed_values(field, value):
    with pytest.raises(ValueError):
        samples.market(**{field: value})


@pytest.mark.parametrize(
    "field, value",
    [("eth_balance", "-0.1"), ("token_balance", "1e"), ("cap_eth", None), ("pnl_eth", "NaN")],
)
def test_agent_card_rejects_malformed_amounts(field, value):
    with pytest.raises(ValueError):
        samples.card(0, **{field: value})


def test_agent_card_allows_negative_pnl():
    assert samples.card(0, pnl_eth="-1.5").pnl_eth == "-1.5"


@pytest.mark.parametrize("round_n, total", [(0, 10), (11, 10), (1, 0)])
def test_round_context_round_bounds(round_n, total):
    with pytest.raises(ValueError):
        samples.context(round_n=round_n, total_rounds=total)


def test_decision_sentiment_range_and_dict_form():
    with pytest.raises(ValueError):
        Decision("a01", None, [], None, 1.5, "")
    decision = Decision("a01", PostIntent("gm", "p3"), ["p1"], {"action": "hold"}, -0.25, "why", ["note"])
    assert decision.to_dict() == {
        "agentId": "a01",
        "post": {"text": "gm", "replyTo": "p3"},
        "likes": ["p1"],
        "market": {"action": "hold"},
        "sentiment": -0.25,
        "reason": "why",
        "notes": ["note"],
    }
