"""OpenAICompatClient against a scripted endpoint (httpx.MockTransport, no network).

Request-shape and response_format patterns ported from MiroFish
backend/tests/test_openai_chat_compat.py and test_llm_json_responses.py (AGPL-3.0)."""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

from hyvo.llm.openai_compat import (
    OpenAICompatClient,
    extract_chat_completion_text,
    is_gpt5_family,
    model_label,
    provider_slug,
    retry_delay_s,
)
from hyvo.llm.types import LLMClient, LLMRequestError, LLMResponseError, Prices

from .llm_fakes import (
    API_KEY,
    FakeProvider,
    completion,
    messages,
    provider_error,
    raises,
)


def call(client, *, json_mode=True, max_tokens=256, temperature=0.7, msgs=None):
    return client.complete(
        msgs or messages(),
        temperature=temperature,
        max_tokens=max_tokens,
        json_mode=json_mode,
        purpose="agents",
    )


# --- request shape -----------------------------------------------------------------------------


def test_legacy_model_keeps_request_shape():
    provider = FakeProvider(completion())
    call(provider.client(model="deepseek-chat"), temperature=0.8, max_tokens=456)
    body = provider.requests[0]
    assert body["model"] == "deepseek-chat"
    assert body["messages"] == [m.to_dict() for m in messages()]
    assert body["temperature"] == 0.8
    assert body["max_tokens"] == 456
    assert body["response_format"] == {"type": "json_object"}
    assert "max_completion_tokens" not in body


def test_deepseek_requests_disable_thinking_mode():
    provider = FakeProvider(completion())
    call(provider.client(base_url="https://api.deepseek.com"))
    assert provider.requests[0]["thinking"] == {"type": "disabled"}


def test_other_providers_get_no_extra_body():
    provider = FakeProvider(completion())
    call(provider.client(base_url="https://api.groq.com/openai/v1"))
    assert "thinking" not in provider.requests[0]
    assert "provider" not in provider.requests[0]


def test_openrouter_caps_the_price_at_the_budgeted_one_and_turns_reasoning_off():
    provider = FakeProvider(completion())
    client = OpenAICompatClient(
        API_KEY,
        "https://openrouter.ai/api/v1",
        "deepseek/deepseek-v4-flash",
        0.15,
        0.3,
        max_retries=0,
        http_client=httpx.Client(transport=httpx.MockTransport(provider)),
    )
    call(client)
    body = provider.requests[0]
    assert body["provider"] == {"max_price": {"prompt": 0.15, "completion": 0.3}}
    assert body["reasoning"] == {"enabled": False}
    assert "thinking" not in body
    assert client.model_label == "openrouter/deepseek/deepseek-v4-flash"


def test_explicit_extra_body_replaces_the_provider_default():
    provider = FakeProvider(completion())
    client = OpenAICompatClient(
        API_KEY,
        "https://api.deepseek.com",
        "deepseek-flash",
        0.3,
        1.2,
        max_retries=0,
        http_client=httpx.Client(transport=httpx.MockTransport(provider)),
        extra_body={},
    )
    call(client)
    assert "thinking" not in provider.requests[0]


def test_gpt5_uses_completion_token_limit_without_temperature():
    provider = FakeProvider(completion())
    call(provider.client(model="gpt-5-mini"), temperature=0.2, max_tokens=123)
    body = provider.requests[0]
    assert body["max_completion_tokens"] == 123
    assert "max_tokens" not in body
    assert "temperature" not in body


def test_plain_mode_sends_no_response_format():
    provider = FakeProvider(completion("hello"))
    assert call(provider.client(), json_mode=False).text == "hello"
    assert "response_format" not in provider.requests[0]


def test_api_key_is_sent_as_bearer_token_only():
    provider = FakeProvider(completion())
    call(provider.client())
    assert provider.headers[0]["authorization"] == f"Bearer {API_KEY}"
    assert API_KEY not in str(provider.requests[0])


# --- response_format fallback ------------------------------------------------------------------


@pytest.mark.parametrize(
    "rejection",
    [
        provider_error(400, param="response_format", code="unsupported_parameter",
                       message="response_format is not supported by this model"),
        provider_error(422, message="Unrecognized parameter: response_format"),
        (400, {"error": "response_format is not supported"}),
    ],
)  # fmt: skip
def test_response_format_falls_back_only_on_explicit_rejection(rejection):
    provider = FakeProvider(rejection, completion(), completion())
    client = provider.client()  # max_retries=0: the fallback is not a retry
    assert call(client).text == '{"ok": true}'
    assert provider.requests[0]["response_format"] == {"type": "json_object"}
    assert "response_format" not in provider.requests[1]
    call(client)  # the provider rejected JSON mode once: it is not sent again
    assert "response_format" not in provider.requests[2]
    assert len(provider.requests) == 3 and provider.sleeps == []


@pytest.mark.parametrize("status", [400, 401, 422, 429, 500])
def test_unrelated_provider_errors_do_not_trigger_the_fallback(status):
    provider = FakeProvider(
        provider_error(status, param="messages", code="invalid_request",
                       message="request failed for an unrelated reason"),
        completion(),
    )  # fmt: skip
    with pytest.raises(LLMRequestError) as captured:
        call(provider.client())
    assert captured.value.status_code == status
    assert captured.value.maybe_billed is False
    assert "unrelated reason" in str(captured.value)
    assert len(provider.requests) == 1


def test_openai_json_word_requirement_is_not_mistaken_for_a_rejection():
    provider = FakeProvider(
        provider_error(
            400,
            param="messages",
            message="'messages' must contain the word 'json' in some form, to use "
            "'response_format' of type 'json_object'.",
        )
    )
    with pytest.raises(LLMRequestError):
        call(provider.client())
    assert len(provider.requests) == 1


# --- usage -------------------------------------------------------------------------------------


def test_usage_is_captured_and_priced():
    provider = FakeProvider(completion(usage=(1_000, 500)))
    result = call(provider.client(prices=Prices(0.5, 2.0)))
    assert (result.input_tokens, result.output_tokens) == (1_000, 500)
    assert result.estimated_tokens is False
    assert result.cost_usd == pytest.approx((1_000 * 0.5 + 500 * 2.0) / 1_000_000)
    assert result.model == "deepseek/deepseek-chat"
    assert result.finish_reason == "stop"
    assert result.latency_ms >= 0


def test_missing_usage_is_estimated_from_characters():
    text = '{"decision": "hold", "reason": "watching"}'
    msgs = messages(system="s" * 401, user="u" * 99)
    provider = FakeProvider(completion(text, usage=None))
    result = call(provider.client(), msgs=msgs)
    assert result.input_tokens == 125  # ceil(500 / 4)
    assert result.output_tokens == -(-len(text) // 4)
    assert result.estimated_tokens is True


def test_partial_usage_is_completed_by_estimate():
    def reply(request):
        status, body = completion("abcd" * 10)
        body["usage"] = {"prompt_tokens": 77}
        return httpx.Response(status, json=body)

    result = call(FakeProvider(reply).client())
    assert (result.input_tokens, result.output_tokens, result.estimated_tokens) == (77, 10, True)


# --- finish_reason -----------------------------------------------------------------------------


def test_truncated_output_raises_with_usage_attached():
    provider = FakeProvider(completion('{"items": [', finish_reason="length", usage=(50, 256)))
    with pytest.raises(LLMResponseError) as captured:
        call(provider.client())
    error = captured.value
    assert error.finish_reason == "length"
    assert error.result is not None and error.result.output_tokens == 256
    assert '{"items"' not in str(error)


def test_max_tokens_spelling_also_counts_as_truncation():
    provider = FakeProvider(completion('{"a": 1}', finish_reason="max_tokens"))
    with pytest.raises(LLMResponseError, match="truncated"):
        call(provider.client(), json_mode=False)


def test_content_filter_raises():
    provider = FakeProvider(completion("", finish_reason="content_filter"))
    with pytest.raises(LLMResponseError, match="content filter"):
        call(provider.client())


@pytest.mark.parametrize("reason", ["insufficient_system_resource", "tool_calls", "error"])
@pytest.mark.parametrize("json_mode", [True, False])
def test_any_other_unnatural_stop_raises_in_every_mode(reason, json_mode):
    provider = FakeProvider(completion('{"ok": true}', finish_reason=reason, usage=(40, 8)))
    expected = rf"stopped unexpectedly \(finish_reason {reason}\)"
    with pytest.raises(LLMResponseError, match=expected) as captured:
        call(provider.client(), json_mode=json_mode)
    assert captured.value.finish_reason == reason
    assert captured.value.result.output_tokens == 8


def test_an_unreadable_finish_reason_is_not_echoed():
    weird = "<b>" + "x" * 60
    provider = FakeProvider(completion("{}", finish_reason=weird))
    with pytest.raises(LLMResponseError, match="finish_reason unrecognized") as captured:
        call(provider.client())
    assert weird not in str(captured.value)


@pytest.mark.parametrize("reason", ["stop", "STOP", "eos", "end_turn", "stop_sequence", None])
def test_natural_stop_spellings_are_accepted(reason):
    provider = FakeProvider(completion('{"ok": true}', finish_reason=reason))
    assert call(provider.client()).finish_reason == reason


def test_missing_choices_raise_with_usage_attached():
    def reply(request):
        status, body = completion()
        body["choices"] = []
        return httpx.Response(status, json=body)

    with pytest.raises(LLMResponseError, match="no choices") as captured:
        call(FakeProvider(reply).client())
    assert captured.value.result.input_tokens == 120


# --- retries and billing -----------------------------------------------------------------------


def test_transient_rejections_are_retried_with_backoff():
    provider = FakeProvider(provider_error(429), provider_error(503), completion())
    result = call(provider.client(max_retries=2))
    assert result.text == '{"ok": true}'
    assert len(provider.requests) == 3
    first, second = provider.sleeps
    assert 0.375 <= first <= 0.5 and 0.75 <= second <= 1.0


@pytest.mark.parametrize(
    ("headers", "wait"), [({"retry-after": "3"}, 3.0), ({"retry-after-ms": "250"}, 0.25)]
)
def test_retry_after_headers_are_honored(headers, wait):
    provider = FakeProvider(provider_error(429, headers=headers), completion())
    call(provider.client(max_retries=1))
    assert provider.sleeps == [wait]


def test_retries_stop_after_max_retries():
    provider = FakeProvider(*[provider_error(503, message="overloaded")] * 3)
    with pytest.raises(LLMRequestError, match="HTTP 503: overloaded") as captured:
        call(provider.client(max_retries=2))
    assert (captured.value.status_code, captured.value.maybe_billed) == (503, False)
    assert len(provider.requests) == 3 and len(provider.sleeps) == 2


def test_x_should_retry_header_wins_over_the_status_rule():
    no = FakeProvider(provider_error(500, headers={"x-should-retry": "false"}), completion())
    with pytest.raises(LLMRequestError):
        call(no.client(max_retries=2))
    assert len(no.requests) == 1
    yes = FakeProvider(provider_error(400, headers={"x-should-retry": "true"}), completion())
    call(yes.client(max_retries=2))
    assert len(yes.requests) == 2


@pytest.mark.parametrize("error", [httpx.ReadTimeout, httpx.ReadError, httpx.RemoteProtocolError])
def test_failures_after_sending_are_never_retried_and_may_have_been_billed(error):
    provider = FakeProvider(raises(error), completion())
    with pytest.raises(LLMRequestError, match=error.__name__) as captured:
        call(provider.client(max_retries=2))
    assert captured.value.maybe_billed is True
    assert len(provider.requests) == 1 and provider.sleeps == []


def test_read_timeout_is_reported_as_a_timeout():
    with pytest.raises(LLMRequestError, match="timed out"):
        call(FakeProvider(raises(httpx.ReadTimeout)).client())


def test_connection_failures_before_sending_are_retried():
    provider = FakeProvider(raises(httpx.ConnectError), raises(httpx.ConnectTimeout), completion())
    assert call(provider.client(max_retries=2)).text == '{"ok": true}'
    assert len(provider.requests) == 3 and len(provider.sleeps) == 2


def test_connection_failures_that_outlast_the_retries_were_not_billed():
    provider = FakeProvider(*[raises(httpx.ConnectError)] * 2)
    with pytest.raises(LLMRequestError, match="failed") as captured:
        call(provider.client(max_retries=1))
    assert captured.value.maybe_billed is False
    assert len(provider.requests) == 2


def test_retry_delay_schedule():
    assert 0.375 <= retry_delay_s(1) <= 0.5
    assert 6.0 <= retry_delay_s(5) <= 8.0
    assert retry_delay_s(40) <= 8.0
    for nonsense in ("soon", "-1", "0", "120", "nan", "inf"):
        assert retry_delay_s(1, httpx.Headers({"retry-after": nonsense})) <= 0.5
    assert retry_delay_s(1, httpx.Headers({"retry-after": "1.5"})) == 1.5


# --- secrets and construction ------------------------------------------------------------------


def test_api_key_never_appears_in_errors_or_repr():
    provider = FakeProvider(provider_error(401, message=f"Incorrect API key provided: {API_KEY}"))
    client = provider.client()
    with pytest.raises(LLMRequestError) as captured:
        call(client)
    assert API_KEY not in str(captured.value)
    assert captured.value.__cause__ is None and captured.value.__suppress_context__
    assert API_KEY not in repr(client)
    assert repr(client) == "OpenAICompatClient(model_label='deepseek/deepseek-chat')"


def test_client_satisfies_the_protocol():
    assert isinstance(FakeProvider().client(), LLMClient)


@pytest.mark.parametrize(
    ("args", "kwargs"),
    [
        (("", None, "m", 0, 0), {}),
        (("k", None, "", 0, 0), {}),
        (("k", None, "m", -0.1, 0), {}),
        (("k", None, "m", 0, float("nan")), {}),
        (("k", None, "m", 0, 0), {"timeout_s": 0}),
        (("k", None, "m", 0, 0), {"max_retries": -1}),
        (("k", None, "m", 0, 0), {"max_retries": True}),
    ],
)
def test_constructor_validates_its_arguments(args, kwargs):
    with pytest.raises(ValueError):
        OpenAICompatClient(*args, **kwargs)


# --- labels and content shapes -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("base_url", "slug"),
    [
        ("https://api.deepseek.com/v1", "deepseek"),
        ("https://api.deepseek.com", "deepseek"),
        ("https://openrouter.ai/api/v1", "openrouter"),
        ("https://api.groq.com/openai/v1", "groq"),
        ("https://generativelanguage.googleapis.com/v1beta/openai/", "google"),
        ("https://api.openai.com/v1", "openai"),
        ("https://api.cerebras.ai/v1", "cerebras"),
        ("https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "alibaba"),
        ("http://localhost:11434/v1", "localhost"),
        ("https://llm.internal.example:8443/v1", "llm.internal.example"),
        (None, "openai"),
    ],
)
def test_provider_slug_from_base_url(base_url, slug):
    assert provider_slug(base_url) == slug


def test_a_workers_ai_model_names_its_own_provider():
    label = "@cf/qwen/qwen3-30b-a3b-fp8"
    assert model_label("https://hyvo-api.example.workers.dev/internal/llm/v1", label) == label
    assert model_label("http://127.0.0.1:8787/internal/llm/v1", label) == label


def test_model_label_keeps_nested_model_names():
    assert model_label("https://openrouter.ai/api/v1", "deepseek/deepseek-chat") == (
        "openrouter/deepseek/deepseek-chat"
    )


@pytest.mark.parametrize(
    ("model", "expected"),
    [("gpt-5", True), (" GPT-5.1-mini ", True), ("gpt-4.1", False), ("my-gpt-5-proxy", False),
     (None, False)],
)  # fmt: skip
def test_gpt5_family_detection(model, expected):
    assert is_gpt5_family(model) is expected


def test_extracts_text_from_supported_content_shapes():
    response = SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(
                    content=[
                        {"text": {"value": "first"}},
                        {"content": " second"},
                        SimpleNamespace(text=" third"),
                    ]
                )
            )
        ]
    )
    assert extract_chat_completion_text(response) == "first second third"
    assert extract_chat_completion_text(SimpleNamespace(choices=[])) == ""
    assert extract_chat_completion_text(
        SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=None))])
    ) == ""
