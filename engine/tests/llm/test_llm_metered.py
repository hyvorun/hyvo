from __future__ import annotations

import json

import pytest

from hyvo.llm.budget import BudgetMeter
from hyvo.llm.log import LLMLog
from hyvo.llm.metered import MeteredClient
from hyvo.llm.types import (
    BudgetExceeded,
    LLMClient,
    LLMRequestError,
    LLMResponseError,
    Prices,
)

from .llm_fakes import API_KEY, FakeClient, FakeProvider, completion, messages, result


def lines(log: LLMLog) -> list[dict]:
    return [json.loads(line) for line in log.path.read_text(encoding="utf-8").splitlines()]


def call(client, purpose="agents", max_tokens=100):
    return client.complete(
        messages(), temperature=0.5, max_tokens=max_tokens, json_mode=True, purpose=purpose
    )


@pytest.fixture
def log(tmp_path) -> LLMLog:
    return LLMLog(tmp_path / "run" / "llm-log.jsonl")


def test_refused_call_sends_nothing_and_is_logged(log):
    provider = FakeProvider(completion())
    meter = BudgetMeter(max_cost_usd=1.0, max_llm_calls=2, report_reserve_calls=2)
    client = MeteredClient(provider.client(), meter, log)
    with pytest.raises(BudgetExceeded) as refused:
        call(client)
    assert refused.value.reason == "max_llm_calls"
    assert provider.requests == []
    [line] = lines(log)
    assert line["error"] == "budget_exceeded: max_llm_calls"
    assert line["response_text"] is None and line["input_tokens"] == 0
    assert line["messages"] == [m.to_dict() for m in messages()]
    assert meter.usage()["llmCalls"] == 0


def test_cost_refusal_uses_the_client_prices_before_sending(log):
    provider = FakeProvider(completion())
    meter = BudgetMeter(max_cost_usd=0.001, max_llm_calls=10)
    client = MeteredClient(provider.client(prices=Prices(1.0, 10.0)), meter, log)
    with pytest.raises(BudgetExceeded, match="max_cost_usd"):
        call(client, max_tokens=1_000)  # worst case 1000 output tokens = $0.01
    assert provider.requests == []


def test_success_is_recorded_and_logged(log):
    provider = FakeProvider(completion('{"a": 1}', usage=(1_000, 100)))
    meter = BudgetMeter(max_cost_usd=1.0, max_llm_calls=10)
    client = MeteredClient(provider.client(prices=Prices(0.5, 2.0)), meter, log)
    out = call(client)
    assert out.text == '{"a": 1}'
    assert meter.usage() == {
        "llmCalls": 1,
        "inputTokens": 1_000,
        "outputTokens": 100,
        "costUsd": 0.0007,
    }
    [line] = lines(log)
    assert line["purpose"] == "agents"
    assert line["model"] == "deepseek/deepseek-chat"
    assert line["response_text"] == '{"a": 1}'
    assert (line["input_tokens"], line["output_tokens"]) == (1_000, 100)
    assert line["cost_usd"] == pytest.approx(0.0007)
    assert line["finish_reason"] == "stop" and line["error"] is None
    assert (line["temperature"], line["max_tokens"], line["json_mode"]) == (0.5, 100, True)


def test_truncated_call_still_counts_and_logs_its_usage(log):
    provider = FakeProvider(completion('{"x": [', finish_reason="length", usage=(10, 100)))
    meter = BudgetMeter(max_cost_usd=1.0, max_llm_calls=10)
    client = MeteredClient(provider.client(), meter, log)
    with pytest.raises(LLMResponseError):
        call(client)
    assert meter.usage()["outputTokens"] == 100
    [line] = lines(log)
    assert line["finish_reason"] == "length"
    assert line["response_text"] == '{"x": ['
    assert line["error"].startswith("LLMResponseError: ")


def test_timeout_counts_as_a_call_with_possible_spend(log):
    error = LLMRequestError("LLM request timed out (ReadTimeout)", maybe_billed=True)
    meter = BudgetMeter(max_cost_usd=1.0, max_llm_calls=10)
    client = MeteredClient(FakeClient(error), meter, log)
    with pytest.raises(LLMRequestError):
        call(client, max_tokens=1_000)
    assert meter.usage()["llmCalls"] == 1
    assert meter.unaccounted_usd > 0
    assert lines(log)[0]["error"] == "LLMRequestError: LLM request timed out (ReadTimeout)"


def test_unexpected_errors_log_only_their_type(log):
    meter = BudgetMeter(max_cost_usd=1.0, max_llm_calls=10)
    client = MeteredClient(FakeClient(RuntimeError(f"boom {API_KEY}")), meter, log)
    with pytest.raises(RuntimeError):
        call(client)
    assert lines(log)[0]["error"] == "RuntimeError"
    assert meter.usage()["llmCalls"] == 1


def test_agents_and_report_share_one_meter(log):
    meter = BudgetMeter(max_cost_usd=1.0, max_llm_calls=3, report_reserve_calls=1)
    agents = MeteredClient(FakeClient(result(), result(), result()), meter, log)
    report = MeteredClient(FakeClient(result()), meter, log)
    call(agents)
    call(agents)
    with pytest.raises(BudgetExceeded):
        call(agents)
    call(report, purpose="report")
    assert meter.usage()["llmCalls"] == 3
    assert [line["purpose"] for line in lines(log)] == ["agents", "agents", "agents", "report"]


def test_metered_client_is_an_llm_client_and_validates_max_tokens(log):
    client = MeteredClient(FakeClient(), BudgetMeter(1.0, 10), log)
    assert isinstance(client, LLMClient)
    assert client.model_label == "fake/model"
    with pytest.raises(ValueError, match="max_tokens"):
        call(client, max_tokens=0)


@pytest.mark.parametrize("temperature", [float("nan"), float("inf"), -0.1, True, "0.5"])
def test_bad_temperature_is_rejected_before_anything_is_sent_or_counted(log, temperature):
    fake = FakeClient(result())
    meter = BudgetMeter(1.0, 10)
    with pytest.raises(ValueError, match="temperature"):
        MeteredClient(fake, meter, log).complete(
            messages(), temperature=temperature, max_tokens=10, json_mode=True, purpose="agents"
        )
    assert fake.calls == [] and meter.usage()["llmCalls"] == 0
    assert not log.path.exists()


def test_api_key_never_reaches_the_log(log):
    provider = FakeProvider(completion(), (401, {"error": {"message": f"bad key {API_KEY}"}}))
    meter = BudgetMeter(max_cost_usd=1.0, max_llm_calls=10)
    client = MeteredClient(provider.client(), meter, log)
    call(client)
    with pytest.raises(LLMRequestError):
        call(client)
    assert API_KEY not in log.path.read_text(encoding="utf-8")
