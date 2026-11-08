"""Deterministic offline "rules model": no network, zero cost, clearly labeled in run.json.

The system message carries a ``HYVO_PROTOCOL: <name>/v<k>`` line (see ``protocol``). The client
dispatches the call to the responder registered for that protocol id. A responder is
``fn(messages, rng) -> str`` and returns what a model would answer (e.g. a JSON object as text).

``rng`` is seeded from the client seed, the protocol id and the exact messages, so the answer
depends only on the input, never on call order or thread scheduling. Token counts are estimated
as ``ceil(chars / 4)`` so budget logic is exercised offline; output longer than ``max_tokens``
is truncated and raises like a real provider would.
"""

from __future__ import annotations

import hashlib
import json
import random
import threading
import time
from collections.abc import Callable, Mapping, Sequence

from .pricing import FREE, estimate_tokens
from .protocol import check_protocol_id, find_protocol
from .types import (
    OFFLINE_MODEL_LABEL,
    ChatMessage,
    LLMResponseError,
    LLMResult,
    prompt_chars,
)

Responder = Callable[[Sequence[ChatMessage], random.Random], str]

_REGISTRY: dict[str, Responder] = {}
_REGISTRY_LOCK = threading.Lock()


def register_responder(protocol: str, fn: Responder) -> None:
    """Register ``fn`` globally for a protocol id such as ``"agent_decisions/v1"``.

    Registering the same function again is a no-op; a different function for a taken id raises.
    """
    check_protocol_id(protocol)
    with _REGISTRY_LOCK:
        existing = _REGISTRY.get(protocol)
        if existing is not None and existing is not fn:
            raise ValueError(f"a different responder is already registered for {protocol!r}")
        _REGISTRY[protocol] = fn


class OfflineClient:
    """``LLMClient`` that answers from registered responders. Explicit ``responders`` take
    precedence over the global registry."""

    model_label = OFFLINE_MODEL_LABEL
    prices = FREE

    def __init__(self, seed: int, responders: Mapping[str, Responder] | None = None) -> None:
        self.seed = seed
        self._responders = {check_protocol_id(k): v for k, v in (responders or {}).items()}

    def __repr__(self) -> str:
        return f"OfflineClient(seed={self.seed!r})"

    def complete(
        self,
        messages: Sequence[ChatMessage],
        *,
        temperature: float,
        max_tokens: int,
        json_mode: bool,
        purpose: str,
    ) -> LLMResult:
        """Answer deterministically. ``temperature``, ``json_mode`` and ``purpose`` are part of
        the protocol and do not change the answer."""
        messages = tuple(messages)
        started = time.perf_counter()
        protocol = find_protocol(messages)
        if protocol is None:
            raise LLMResponseError(
                "the offline model needs a 'HYVO_PROTOCOL: <name>/v<k>' line in a system message"
            )
        responder = self._responders.get(protocol) or _REGISTRY.get(protocol)
        if responder is None:
            raise LLMResponseError(f"the offline model has no responder for {protocol!r}")
        text = responder(messages, self._rng(protocol, messages))
        if not isinstance(text, str):
            raise TypeError(f"offline responder for {protocol!r} must return str")
        truncated = estimate_tokens(len(text)) > max_tokens
        if truncated:
            text = text[: max_tokens * 4]
        result = LLMResult(
            text=text,
            input_tokens=estimate_tokens(prompt_chars(messages)),
            output_tokens=estimate_tokens(len(text)),
            model=self.model_label,
            finish_reason="length" if truncated else "stop",
            latency_ms=round((time.perf_counter() - started) * 1000),
            cost_usd=0.0,
            estimated_tokens=True,
        )
        if truncated:
            raise LLMResponseError(
                "offline output exceeds max_tokens (estimated as ceil(chars / 4))",
                finish_reason="length",
                result=result,
            )
        return result

    def _rng(self, protocol: str, messages: Sequence[ChatMessage]) -> random.Random:
        material = json.dumps(
            [self.seed, protocol, [m.to_dict() for m in messages]],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        digest = hashlib.sha256(material.encode("utf-8")).digest()
        return random.Random(int.from_bytes(digest[:8], "big"))
