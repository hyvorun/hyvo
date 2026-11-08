"""Client for any OpenAI-compatible Chat Completions endpoint, with usage capture.

Adapted from MiroFish (AGPL-3.0):
- backend/app/utils/openai_chat_compat.py: GPT-5 request shape (``is_gpt5_family``,
  ``create_chat_completion``) and content extraction (``extract_chat_completion_text``);
- backend/app/utils/llm_client.py: JSON mode via ``response_format`` with a fallback only when the
  provider explicitly rejects it (``_is_response_format_unsupported``), and the rule that an answer
  whose generation did not stop naturally is unusable (``LLMClient._parse_json_response``).

Hyvo changes:
- Token usage, latency and cost are captured on every call. ``finish_reason`` is checked in every
  mode, not only for JSON: truncation, a content filter or any other unnatural stop raises
  ``LLMResponseError`` with the call's usage attached, so the budget still counts it.
- No content retries inside the client: a retry is a new call that the budget must see.
- Transport retries are Hyvo's, not the OpenAI SDK's (the SDK client runs with ``max_retries=0``).
  The SDK would also retry a read timeout, whose first attempt the provider may already have
  billed, and that spend would never reach the budget. Hyvo retries only failures that never ran
  the model: connection failures before the request was sent, and HTTP 408, 409, 429 and 5xx
  answers (an HTTP error carries no completion, so Hyvo treats it as unbilled). A failure after
  the request was sent (read timeout, dropped connection) is raised at once as
  ``LLMRequestError(maybe_billed=True)``, and ``MeteredClient`` counts its worst-case estimate.
- Provider errors become ``LLMRequestError`` with the API key redacted.
- After an explicit rejection, ``response_format`` is no longer sent to that provider.
"""

from __future__ import annotations

import copy
import math
import random
import re
import time
from collections.abc import Callable, Mapping, Sequence
from typing import Any
from urllib.parse import urlsplit

import httpx
import openai

from .pricing import cost_usd, estimate_tokens
from .types import (
    ChatMessage,
    LLMRequestError,
    LLMResponseError,
    LLMResult,
    Prices,
    prompt_chars,
)

DEFAULT_BASE_URL = "https://api.openai.com/v1"

# Host (or parent domain) -> provider slug used in model labels. Other hosts use the host.
_PROVIDER_SLUGS = (
    ("deepseek.com", "deepseek"),
    ("openrouter.ai", "openrouter"),
    ("groq.com", "groq"),
    ("googleapis.com", "google"),
    ("openai.com", "openai"),
    ("azure.com", "azure"),
    ("cerebras.ai", "cerebras"),
    ("together.xyz", "together"),
    ("together.ai", "together"),
    ("mistral.ai", "mistral"),
    ("fireworks.ai", "fireworks"),
    ("deepinfra.com", "deepinfra"),
    ("sambanova.ai", "sambanova"),
    ("x.ai", "xai"),
    ("anthropic.com", "anthropic"),
    ("aliyuncs.com", "alibaba"),
    ("moonshot.ai", "moonshot"),
    ("moonshot.cn", "moonshot"),
    ("bigmodel.cn", "zhipu"),
    ("siliconflow.com", "siliconflow"),
    ("siliconflow.cn", "siliconflow"),
    ("nvidia.com", "nvidia"),
)

_JSON_OBJECT = {"type": "json_object"}
_UNSUPPORTED_CODES = frozenset(
    {"unsupported_parameter", "unsupported_value", "unknown_parameter", "invalid_parameter"}
)
_UNSUPPORTED_PHRASES = ("not support", "unsupported", "unknown parameter", "unrecognized parameter")

# finish_reason: only a natural stop gives a usable answer. Besides "stop" (and no reason at all),
# the sets hold other spellings of the same outcomes.
_NATURAL_STOP = frozenset({"stop", "eos", "end_turn", "stop_sequence"})
_TRUNCATED = frozenset({"length", "max_tokens"})
_SAFE_REASON_RE = re.compile(r"^[a-z0-9_.\-]{1,40}$", re.IGNORECASE)

# Transport failures that happen before the request reaches the provider: nothing was billed.
_NOT_SENT = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.PoolTimeout,
    httpx.ProxyError,
    httpx.UnsupportedProtocol,
    httpx.LocalProtocolError,
)
# Extra request fields a provider needs on every call, keyed by provider slug. DeepSeek V4.x
# turns "thinking" on by default, which bills reasoning tokens and ignores temperature
# (https://api-docs.deepseek.com/guides/thinking_mode, checked 2026-11-02).
PROVIDER_EXTRA_BODY: Mapping[str, Mapping[str, Any]] = {
    "deepseek": {"thinking": {"type": "disabled"}},
}

_RETRYABLE_NOT_SENT = (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout)
_RETRYABLE_STATUSES = frozenset({408, 409, 429})
_INITIAL_RETRY_DELAY_S = 0.5
_MAX_RETRY_DELAY_S = 8.0
_MAX_RETRY_AFTER_S = 60.0


def provider_slug(base_url: str | None) -> str:
    try:
        host = (urlsplit(base_url or DEFAULT_BASE_URL).hostname or "").lower()
    except ValueError:
        host = ""
    for domain, slug in _PROVIDER_SLUGS:
        if host == domain or host.endswith("." + domain):
            return slug
    return host or "unknown"


def model_label(base_url: str | None, model: str) -> str:
    """``"<provider slug>/<model>"``, e.g. ``"deepseek/deepseek-chat"``. A Workers AI id
    (``@cf/...``) names its own provider, whichever host proxies it."""
    return model if model.startswith("@cf/") else f"{provider_slug(base_url)}/{model}"


def is_gpt5_family(model: str | None) -> bool:
    """Return True when the model belongs to the GPT-5 family aliases/snapshots."""
    if not model:
        return False
    return model.strip().lower().startswith("gpt-5")


def create_chat_completion(
    client: Any,
    *,
    model: str,
    messages: list[dict[str, Any]],
    temperature: float | None = None,
    max_tokens: int | None = None,
    response_format: dict[str, Any] | None = None,
    extra_body: Mapping[str, Any] | None = None,
) -> Any:
    """Create a chat completion with model-specific request parameters.

    GPT-5 models get no ``temperature`` and ``max_completion_tokens`` instead of ``max_tokens``;
    every other model keeps the legacy request shape. ``extra_body`` fields are merged into the
    JSON body. Provider errors propagate unchanged.
    """
    kwargs: dict[str, Any] = {"model": model, "messages": messages}
    if response_format is not None:
        kwargs["response_format"] = response_format
    if extra_body:
        kwargs["extra_body"] = copy.deepcopy(dict(extra_body))
    gpt5_family = is_gpt5_family(model)
    if temperature is not None and not gpt5_family:
        kwargs["temperature"] = temperature
    if max_tokens is not None:
        kwargs["max_completion_tokens" if gpt5_family else "max_tokens"] = max_tokens
    return client.chat.completions.create(**kwargs)


def extract_chat_completion_text(response: Any) -> str:
    """Extract plain text from a chat completion across SDK content shapes."""
    choices = getattr(response, "choices", None) or []
    if not choices:
        return ""
    message = getattr(choices[0], "message", None)
    if message is None:
        return ""
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks: list[str] = []
        for item in content:
            if isinstance(item, dict):
                text_obj = item.get("text")
                if isinstance(text_obj, dict):
                    text_obj = text_obj.get("value")
                if isinstance(text_obj, str):
                    chunks.append(text_obj)
                elif isinstance(item.get("content"), str):
                    chunks.append(item["content"])
                continue
            text_obj = getattr(item, "text", None)
            if isinstance(text_obj, dict):
                text_obj = text_obj.get("value")
            if isinstance(text_obj, str):
                chunks.append(text_obj)
                continue
            content_obj = getattr(item, "content", None)
            if isinstance(content_obj, str):
                chunks.append(content_obj)
        return "".join(chunks).strip()
    return str(content or "")


def is_response_format_unsupported(error: Exception) -> bool:
    """Detect an explicit provider rejection of ``response_format`` (HTTP 400 or 422).

    Accepts the SDK error body (the inner ``error`` object, or a plain string) and the raw
    ``{"error": {...}}`` envelope.
    """
    if getattr(error, "status_code", None) not in {400, 422}:
        return False
    body = getattr(error, "body", None)
    details = body.get("error", body) if isinstance(body, dict) else body
    if isinstance(details, str):
        details = {"message": details}
    if not isinstance(details, dict):
        return False
    param = str(details.get("param") or "").strip().lower()
    if param == "response_format" or param.startswith("response_format."):
        return True
    message = str(details.get("message") or "").lower()
    if "response_format" not in message:
        return False
    code = str(details.get("code") or "").lower()
    return code in _UNSUPPORTED_CODES or any(p in message for p in _UNSUPPORTED_PHRASES)


def retry_delay_s(retry: int, headers: httpx.Headers | None = None) -> float:
    """Seconds to wait before retry number ``retry`` (1, 2, ...).

    A ``retry-after-ms`` or ``retry-after`` (seconds) header of at most 60 s is honored. Otherwise
    the OpenAI SDK's schedule applies: 0.5 s, doubling up to 8 s, minus up to 25% jitter.
    """
    if headers is not None:
        for name, scale in (("retry-after-ms", 0.001), ("retry-after", 1.0)):
            try:
                hinted = float(headers.get(name, "")) * scale
            except ValueError:
                continue
            if 0 < hinted <= _MAX_RETRY_AFTER_S:
                return hinted
    delay = min(_INITIAL_RETRY_DELAY_S * 2 ** (retry - 1), _MAX_RETRY_DELAY_S)
    return delay * (1 - 0.25 * random.random())


class OpenAICompatClient:
    """Synchronous, thread-safe client for one model on an OpenAI-compatible endpoint.

    ``timeout_s`` bounds each HTTP request. ``max_retries`` is the number of extra attempts after
    a failure that never ran the model (see the module docstring); one ``complete`` call is one
    logical LLM call for the budget. ``http_client`` lets tests inject an ``httpx.Client`` with a
    ``MockTransport``; ``sleep`` replaces ``time.sleep`` between retries.
    """

    def __init__(
        self,
        api_key: str,
        base_url: str | None,
        model: str,
        input_price_per_m: float,
        output_price_per_m: float,
        timeout_s: float = 60,
        max_retries: int = 2,
        *,
        http_client: httpx.Client | None = None,
        sleep: Callable[[float], None] = time.sleep,
        extra_body: Mapping[str, Any] | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("api_key is required")
        if not model:
            raise ValueError("model is required")
        prices = Prices(float(input_price_per_m), float(output_price_per_m))
        if not all(math.isfinite(p) and p >= 0 for p in prices):
            raise ValueError("prices must be finite numbers >= 0")
        if not timeout_s > 0:
            raise ValueError("timeout_s must be > 0")
        if isinstance(max_retries, bool) or not isinstance(max_retries, int) or max_retries < 0:
            raise ValueError("max_retries must be an integer >= 0")
        self.model = model
        self.base_url = base_url or DEFAULT_BASE_URL
        self.model_label = model_label(self.base_url, model)
        self.prices = prices
        self.max_retries = max_retries
        self._api_key = api_key
        self._sleep = sleep
        self._client = openai.OpenAI(
            api_key=api_key,
            base_url=self.base_url,
            timeout=timeout_s,
            max_retries=0,
            http_client=http_client,
        )
        self._send_response_format = True
        if extra_body is None:
            extra_body = PROVIDER_EXTRA_BODY.get(provider_slug(self.base_url), {})
        self._extra_body = copy.deepcopy(dict(extra_body))

    def __repr__(self) -> str:
        return f"OpenAICompatClient(model_label={self.model_label!r})"

    def complete(
        self,
        messages: Sequence[ChatMessage],
        *,
        temperature: float,
        max_tokens: int,
        json_mode: bool,
        purpose: str,
    ) -> LLMResult:
        """Send one chat completion and return its text, usage and cost.

        ``purpose`` is part of the ``LLMClient`` protocol; budgets and logs are applied by
        ``MeteredClient``. In JSON mode the prompt itself must ask for a JSON object: OpenAI
        requires the word "JSON" in the messages, and providers that reject
        ``response_format`` rely on the prompt alone. ``latency_ms`` covers retries.

        Raises ``LLMRequestError`` when the request fails and ``LLMResponseError`` (with
        ``.result``) when the answer has no choices or did not stop naturally.
        """
        messages = tuple(messages)
        started = time.perf_counter()
        response = self._send(messages, temperature, max_tokens, json_mode)
        latency_ms = round((time.perf_counter() - started) * 1000)
        result = self._result(response, messages, latency_ms)
        if not getattr(response, "choices", None):
            raise LLMResponseError("LLM returned no choices", result=result)
        _check_finish(result)
        return result

    def _send(
        self,
        messages: Sequence[ChatMessage],
        temperature: float,
        max_tokens: int,
        json_mode: bool,
    ) -> Any:
        payload = [m.to_dict() for m in messages]
        response_format = _JSON_OBJECT if json_mode and self._send_response_format else None
        retries = 0
        while True:
            try:
                return create_chat_completion(
                    self._client,
                    model=self.model,
                    messages=payload,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    response_format=response_format,
                    extra_body=self._extra_body,
                )
            except openai.APIStatusError as error:
                if response_format is not None and is_response_format_unsupported(error):
                    # The provider explicitly rejected JSON mode: resend without it (not a
                    # retry) and stop sending it to this provider. Still one logical call.
                    self._send_response_format = False
                    response_format = None
                    continue
                if retries < self.max_retries and _should_retry_status(error):
                    retries += 1
                    self._sleep(retry_delay_s(retries, error.response.headers))
                    continue
                raise LLMRequestError(
                    self._status_message(error), status_code=error.status_code
                ) from None
            except openai.APIConnectionError as error:  # includes APITimeoutError
                cause = error.__cause__
                if isinstance(cause, _RETRYABLE_NOT_SENT) and retries < self.max_retries:
                    retries += 1
                    self._sleep(retry_delay_s(retries))
                    continue
                kind = "timed out" if isinstance(error, openai.APITimeoutError) else "failed"
                raise LLMRequestError(
                    f"LLM request {kind} ({type(cause or error).__name__})",
                    maybe_billed=not isinstance(cause, _NOT_SENT),
                ) from None
            except openai.APIError as error:  # e.g. a success response the SDK could not read
                raise LLMRequestError(
                    f"LLM response could not be read ({type(error).__name__})", maybe_billed=True
                ) from None

    def _status_message(self, error: openai.APIStatusError) -> str:
        body = error.body
        details = body.get("error", body) if isinstance(body, dict) else body
        message = details.get("message") if isinstance(details, dict) else details
        text = f"LLM provider returned HTTP {error.status_code}"
        if isinstance(message, str) and message.strip():
            cleaned = " ".join(message.replace(self._api_key, "***").split())
            text += f": {cleaned[:300]}"
        return text

    def _result(
        self, response: Any, messages: Sequence[ChatMessage], latency_ms: int
    ) -> LLMResult:
        text = extract_chat_completion_text(response)
        choices = getattr(response, "choices", None) or []
        finish_reason = getattr(choices[0], "finish_reason", None) if choices else None
        usage = getattr(response, "usage", None)
        input_tokens = _token_count(getattr(usage, "prompt_tokens", None))
        output_tokens = _token_count(getattr(usage, "completion_tokens", None))
        estimated = input_tokens is None or output_tokens is None
        if input_tokens is None:
            input_tokens = estimate_tokens(prompt_chars(messages))
        if output_tokens is None:
            output_tokens = estimate_tokens(len(text))
        return LLMResult(
            text=text,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            model=self.model_label,
            finish_reason=None if finish_reason is None else str(finish_reason),
            latency_ms=latency_ms,
            cost_usd=cost_usd(self.prices, input_tokens, output_tokens),
            estimated_tokens=estimated,
        )


def _should_retry_status(error: openai.APIStatusError) -> bool:
    """The OpenAI SDK's rule: an ``x-should-retry`` header wins, else 408, 409, 429 and 5xx."""
    hint = error.response.headers.get("x-should-retry")
    if hint in ("true", "false"):
        return hint == "true"
    return error.status_code in _RETRYABLE_STATUSES or error.status_code >= 500


def _check_finish(result: LLMResult) -> None:
    """Raise ``LLMResponseError`` (usage attached) unless the generation stopped naturally."""
    reason = result.finish_reason
    if reason is None or reason.lower() in _NATURAL_STOP:
        return
    if reason.lower() in _TRUNCATED:
        message = "LLM output was truncated at the token limit"
    elif reason.lower() == "content_filter":
        message = "LLM output was blocked by the provider's content filter"
    else:
        shown = reason if _SAFE_REASON_RE.match(reason) else "unrecognized"
        message = f"LLM generation stopped unexpectedly (finish_reason {shown})"
    raise LLMResponseError(message, finish_reason=reason, result=result)


def _token_count(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None
