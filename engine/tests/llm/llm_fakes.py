"""Test doubles for the LLM layer. No test reaches the network: the OpenAI SDK talks to an
``httpx.MockTransport`` through its ``http_client`` parameter, and retry waits are recorded
instead of slept."""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from typing import Any

import httpx

from hyvo.llm.openai_compat import OpenAICompatClient
from hyvo.llm.types import ChatMessage, LLMResult, Prices

API_KEY = "sk-test-SECRET-0123456789"
BASE_URL = "https://api.deepseek.com/v1"
PROVIDER_PRICES = Prices(0.5, 2.0)
FAKE_PRICES = Prices(1.0, 2.0)

# (status, json body) or (status, json body, headers), or a function of the request.
Reply = (
    tuple[int, Any] | tuple[int, Any, dict[str, str]] | Callable[[httpx.Request], httpx.Response]
)


def completion(
    content: Any = '{"ok": true}',
    *,
    finish_reason: str | None = "stop",
    usage: tuple[int, int] | None = (120, 30),
) -> tuple[int, dict[str, Any]]:
    body: dict[str, Any] = {
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "created": 0,
        "model": "served-model",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": finish_reason,
            }
        ],
    }
    if usage is not None:
        body["usage"] = {
            "prompt_tokens": usage[0],
            "completion_tokens": usage[1],
            "total_tokens": usage[0] + usage[1],
        }
    return 200, body


def provider_error(
    status: int,
    *,
    param: str | None = None,
    code: str | None = None,
    message: str = "error",
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, Any], dict[str, str]]:
    error = {"message": message, "type": "invalid_request_error", "param": param, "code": code}
    return status, {"error": error}, headers or {}


def raises(error_type: type[httpx.TransportError]) -> Callable[[httpx.Request], httpx.Response]:
    """A reply that fails at the transport level with ``error_type``."""

    def reply(request: httpx.Request) -> httpx.Response:
        raise error_type("scripted transport failure", request=request)

    return reply


class FakeProvider:
    """Scripted OpenAI-compatible endpoint. Records every request body and header set, and every
    retry wait of the clients it builds."""

    def __init__(self, *replies: Reply) -> None:
        self.replies = list(replies)
        self.requests: list[dict[str, Any]] = []
        self.headers: list[httpx.Headers] = []
        self.sleeps: list[float] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(json.loads(request.content))
        self.headers.append(request.headers)
        reply = self.replies.pop(0)
        if callable(reply):
            return reply(request)
        status, body, *headers = reply
        return httpx.Response(status, json=body, headers=headers[0] if headers else None)

    def client(
        self,
        *,
        model: str = "deepseek-chat",
        prices: Prices = PROVIDER_PRICES,
        base_url: str = BASE_URL,
        max_retries: int = 0,
    ) -> OpenAICompatClient:
        return OpenAICompatClient(
            API_KEY,
            base_url,
            model,
            *prices,
            max_retries=max_retries,
            http_client=httpx.Client(transport=httpx.MockTransport(self)),
            sleep=self.sleeps.append,
        )


class FakeClient:
    """Minimal in-memory LLMClient: returns scripted results or raises scripted errors."""

    model_label = "fake/model"

    def __init__(self, *outcomes: LLMResult | BaseException, prices: Prices = FAKE_PRICES):
        self.outcomes = list(outcomes)
        self.prices = prices
        self.calls: list[Sequence[ChatMessage]] = []

    def complete(self, messages, *, temperature, max_tokens, json_mode, purpose) -> LLMResult:
        self.calls.append(messages)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def result(
    text: str = '{"ok": true}', *, cost: float = 0.01, tokens: tuple[int, int] = (100, 20)
) -> LLMResult:
    return LLMResult(
        text=text,
        input_tokens=tokens[0],
        output_tokens=tokens[1],
        model="fake/model",
        finish_reason="stop",
        latency_ms=5,
        cost_usd=cost,
        estimated_tokens=False,
    )


def messages(
    system: str = "You return JSON.", user: str = "Return a JSON object."
) -> list[ChatMessage]:
    return [ChatMessage("system", system), ChatMessage("user", user)]
