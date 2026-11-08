from __future__ import annotations

import json

import pytest

from hyvo.decisions import PROTOCOL, build_messages, request_decisions
from hyvo.decisions.offline_policy import respond
from hyvo.llm.offline import OfflineClient
from hyvo.llm.types import BudgetExceeded, LLMRequestError, LLMResponseError

from . import samples


def valid_answer(cards) -> str:
    return json.dumps({"decisions": [{"agentId": c.agent_id, "post": None, "likes": [], "market": {"action": "hold"},
                                      "sentiment": 0.1, "reason": "ok"} for c in cards]})  # fmt: skip


def raise_(error: BaseException):
    def step() -> str:
        raise error

    return step


def test_one_call_per_batch_with_the_protocol_parameters():
    ctx, cards = samples.context(), samples.cards(4)
    client = samples.ScriptedClient([valid_answer(cards)])
    batch = request_decisions(client, ctx, cards, temperature=0.8)
    assert list(batch) == [c.agent_id for c in cards] and batch.notes == []
    (call,) = client.calls
    assert call["messages"] == build_messages(ctx, cards)
    assert (call["temperature"], call["max_tokens"], call["json_mode"], call["purpose"]) == (0.8, 1080, True, "agents")


def test_likes_and_replies_are_checked_against_the_posts_shown():
    ctx, cards = samples.context(), samples.cards(2, samples.context().feed)
    own_post = cards[0].own_recent_posts[0].id
    answer = {"decisions": [{"agentId": cards[0].agent_id, "post": {"text": "hm", "replyTo": "p999"},
                             "likes": [own_post, "p101", "p999"], "market": {"action": "hold"},
                             "sentiment": 0, "reason": ""}]}  # fmt: skip
    batch = request_decisions(samples.ScriptedClient([json.dumps(answer)]), ctx, cards, temperature=0.5)
    first = batch[cards[0].agent_id]
    assert first.likes == ["p101"] and first.post.reply_to is None
    assert first.notes == ["reply_to_unknown", "like_own", "like_unknown"]
    assert batch[cards[1].agent_id].notes == ["missing_decision"]


@pytest.mark.parametrize(
    "first", ["not json at all", raise_(LLMResponseError("output truncated", finish_reason="length"))]
)
def test_an_unusable_answer_is_retried_once(first):
    ctx, cards = samples.context(), samples.cards(3)
    client = samples.ScriptedClient([first, valid_answer(cards)])
    batch = request_decisions(client, ctx, cards, temperature=0.8)
    assert len(client.calls) == 2 and batch.notes == ["retried"]
    assert all(decision.notes == [] for decision in batch.values())


def test_two_unusable_answers_make_every_agent_hold():
    ctx, cards = samples.context(), samples.cards(3)
    client = samples.ScriptedClient(["{}", "[]"])
    batch = request_decisions(client, ctx, cards, temperature=0.8)
    assert len(client.calls) == 2 and batch.notes == ["batch_failed"]
    for decision in batch.values():
        assert decision.market == {"action": "hold"} and decision.post is None
        assert decision.notes == ["batch_failed"]


@pytest.mark.parametrize(
    "error", [BudgetExceeded("max_llm_calls", "agents"), LLMRequestError("HTTP 503", status_code=503)]
)
def test_budget_and_provider_errors_propagate(error):
    client = samples.ScriptedClient([raise_(error), valid_answer(samples.cards(2))])
    with pytest.raises(type(error)):
        request_decisions(client, samples.context(), samples.cards(2), temperature=0.8)
    assert len(client.calls) == 1


def test_offline_client_answers_a_batch_cleanly():
    ctx = samples.context()
    cards = samples.cards(10, ctx.feed)
    batch = request_decisions(OfflineClient(11, {PROTOCOL: respond}), ctx, cards, temperature=0.8)
    assert batch.notes == [] and all(decision.notes == [] for decision in batch.values())
