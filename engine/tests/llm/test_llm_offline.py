from __future__ import annotations

import json
import random
from concurrent.futures import ThreadPoolExecutor

import pytest

from hyvo.llm import offline
from hyvo.llm.budget import BudgetMeter
from hyvo.llm.log import LLMLog
from hyvo.llm.metered import MeteredClient
from hyvo.llm.offline import OfflineClient, register_responder
from hyvo.llm.protocol import find_protocol, protocol_tag
from hyvo.llm.types import (
    OFFLINE_MODEL_LABEL,
    BudgetExceeded,
    ChatMessage,
    LLMClient,
    LLMResponseError,
)


def draw(messages, rng: random.Random) -> str:
    return json.dumps({"value": rng.random()})


def echo_user(messages, rng: random.Random) -> str:
    return json.dumps({"user": messages[-1].content})


RESPONDERS = {"draw/v1": draw, "echo/v1": echo_user}


def prompt(tag: str, user: str = "round 1") -> list[ChatMessage]:
    system = f"You are an agent.\n{tag}\nReturn JSON."
    return [ChatMessage("system", system), ChatMessage("user", user)]


def ask(client, msgs, max_tokens=200):
    return client.complete(
        msgs, temperature=0.8, max_tokens=max_tokens, json_mode=True, purpose="agents"
    )


@pytest.fixture(autouse=True)
def isolated_registry(monkeypatch):
    monkeypatch.setattr(offline, "_REGISTRY", {})


def test_same_seed_and_messages_give_the_same_answer():
    msgs = prompt(protocol_tag("draw", 1))
    first = ask(OfflineClient(7, RESPONDERS), msgs).text
    assert ask(OfflineClient(7, RESPONDERS), msgs).text == first
    assert ask(OfflineClient(8, RESPONDERS), msgs).text != first
    other_round = prompt(protocol_tag("draw", 1), "round 2")
    assert ask(OfflineClient(7, RESPONDERS), other_round).text != first


def test_answers_do_not_depend_on_call_order_or_threads():
    client = OfflineClient(3, RESPONDERS)
    prompts = [prompt(protocol_tag("draw", 1), f"round {n}") for n in range(40)]
    sequential = [ask(client, p).text for p in prompts]
    with ThreadPoolExecutor(max_workers=8) as pool:
        threaded = list(pool.map(lambda p: ask(client, p).text, reversed(prompts)))
    assert threaded[::-1] == sequential


def test_dispatches_on_the_protocol_tag():
    client = OfflineClient(0, RESPONDERS)
    assert json.loads(ask(client, prompt(protocol_tag("echo", 1), "hi")).text) == {"user": "hi"}
    assert "value" in json.loads(ask(client, prompt(protocol_tag("draw", 1))).text)


def test_unknown_version_or_protocol_is_an_error():
    client = OfflineClient(0, RESPONDERS)
    with pytest.raises(LLMResponseError, match="no responder"):
        ask(client, prompt(protocol_tag("draw", 2)))
    with pytest.raises(LLMResponseError, match="no responder"):
        ask(client, prompt(protocol_tag("report", 1)))


def test_missing_tag_is_an_error_and_user_messages_cannot_carry_one():
    client = OfflineClient(0, RESPONDERS)
    msgs = [ChatMessage("system", "No tag here."), ChatMessage("user", protocol_tag("echo", 1))]
    with pytest.raises(LLMResponseError, match="HYVO_PROTOCOL"):
        ask(client, msgs)


def test_conflicting_or_malformed_tags_are_errors():
    two = [
        ChatMessage("system", protocol_tag("draw", 1)),
        ChatMessage("system", protocol_tag("echo", 1)),
    ]
    with pytest.raises(LLMResponseError, match="more than one"):
        find_protocol(two)
    with pytest.raises(LLMResponseError, match="malformed"):
        find_protocol([ChatMessage("system", "HYVO_PROTOCOL: Draw-V1")])
    assert find_protocol([ChatMessage("system", "a\nHYVO_PROTOCOL:  draw/v1  \nb")]) == "draw/v1"


def test_tokens_are_estimated_and_cost_is_zero():
    msgs = prompt(protocol_tag("echo", 1), "x" * 100)
    out = ask(OfflineClient(0, RESPONDERS), msgs)
    chars = sum(len(m.content) for m in msgs)
    assert out.input_tokens == -(-chars // 4)
    assert out.output_tokens == -(-len(out.text) // 4)
    assert out.estimated_tokens is True
    assert out.cost_usd == 0.0
    assert out.model == OFFLINE_MODEL_LABEL == "offline/rules-v1"
    assert out.finish_reason == "stop"


def test_output_beyond_max_tokens_is_truncated_like_a_provider():
    client = OfflineClient(0, {"long/v1": lambda m, r: "y" * 100})
    with pytest.raises(LLMResponseError) as captured:
        ask(client, prompt(protocol_tag("long", 1)), max_tokens=10)
    assert captured.value.finish_reason == "length"
    assert captured.value.result.text == "y" * 40
    assert captured.value.result.output_tokens == 10


def test_global_registry_and_explicit_precedence():
    register_responder("echo/v1", echo_user)
    register_responder("echo/v1", echo_user)  # same function again: fine
    with pytest.raises(ValueError, match="already registered"):
        register_responder("echo/v1", draw)
    msgs = prompt(protocol_tag("echo", 1), "hello")
    assert json.loads(ask(OfflineClient(0), msgs).text) == {"user": "hello"}
    override = OfflineClient(0, {"echo/v1": lambda m, r: '{"override": true}'})
    assert json.loads(ask(override, msgs).text) == {"override": True}


@pytest.mark.parametrize("bad", ["echo", "Echo/v1", "echo/v0", "echo/1", "/v1"])
def test_protocol_ids_are_validated(bad):
    with pytest.raises(ValueError, match="protocol id"):
        register_responder(bad, echo_user)


def test_responder_must_return_text():
    client = OfflineClient(0, {"bad/v1": lambda m, r: {"not": "text"}})
    with pytest.raises(TypeError):
        ask(client, prompt(protocol_tag("bad", 1)))


def test_budget_logic_is_exercised_offline(tmp_path):
    meter = BudgetMeter(max_cost_usd=0.0, max_llm_calls=3, report_reserve_calls=1)
    client = MeteredClient(OfflineClient(0, RESPONDERS), meter, LLMLog(tmp_path / "llm-log.jsonl"))
    assert isinstance(client, LLMClient)
    ask(client, prompt(protocol_tag("draw", 1)))
    ask(client, prompt(protocol_tag("draw", 1)))
    with pytest.raises(BudgetExceeded, match="max_llm_calls"):
        ask(client, prompt(protocol_tag("draw", 1)))
    usage = meter.usage()
    assert usage["llmCalls"] == 2 and usage["inputTokens"] > 0 and usage["costUsd"] == 0.0
