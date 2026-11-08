"""Shared types of the LLM layer. No third-party imports."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, NamedTuple, Protocol, get_args, runtime_checkable

Role = Literal["system", "user", "assistant"]
Purpose = Literal["agents", "report"]
StopReason = Literal["max_cost_usd", "max_llm_calls"]

PURPOSES: frozenset[str] = frozenset(get_args(Purpose))
OFFLINE_MODEL_LABEL = "offline/rules-v1"


@dataclass(frozen=True)
class ChatMessage:
    role: Role
    content: str

    def __post_init__(self) -> None:
        if self.role not in get_args(Role):
            raise ValueError(f"unknown chat role {self.role!r}")
        if not isinstance(self.content, str):
            raise TypeError("chat message content must be a string")

    def to_dict(self) -> dict[str, str]:
        return {"role": self.role, "content": self.content}


class Prices(NamedTuple):
    """USD per million tokens."""

    input_per_m: float
    output_per_m: float


@dataclass(frozen=True)
class LLMResult:
    """One completed call. ``text`` is the raw model text (``<think>`` blocks included);
    use ``json_utils.parse_json_object`` or ``clean_chat_text`` to read it.
    ``model`` is the client's model label. ``estimated_tokens`` is True when the provider
    reported no usage and the token counts are ``ceil(chars / 4)`` estimates."""

    text: str
    input_tokens: int
    output_tokens: int
    model: str
    finish_reason: str | None
    latency_ms: int
    cost_usd: float
    estimated_tokens: bool


class LLMResponseError(ValueError):
    """The model answered, but the answer is unusable (truncated, filtered, not JSON...).

    ``result`` carries the usage of the failed call when there was a response, so the budget
    can still count it. Messages never echo model output.
    """

    def __init__(
        self,
        message: str,
        *,
        finish_reason: str | None = None,
        result: LLMResult | None = None,
    ) -> None:
        super().__init__(message)
        self.finish_reason = finish_reason
        self.result = result


class LLMRequestError(Exception):
    """The provider request failed without a usable response (HTTP error, timeout, network).

    ``maybe_billed`` is True when the provider may have processed (and billed) the request,
    e.g. a read timeout; the budget then counts the pre-call estimate as possible spend.
    Messages never contain the API key.
    """

    def __init__(
        self, message: str, *, status_code: int | None = None, maybe_billed: bool = False
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.maybe_billed = maybe_billed


class BudgetExceeded(Exception):
    """A call was refused before sending because it could exceed a run limit."""

    def __init__(self, reason: StopReason, purpose: Purpose) -> None:
        super().__init__(reason, purpose)
        self.reason: StopReason = reason
        self.purpose: Purpose = purpose

    def __str__(self) -> str:
        return f"LLM budget exhausted ({self.reason}); {self.purpose} call refused"


@runtime_checkable
class LLMClient(Protocol):
    """A synchronous, thread-safe chat client.

    ``model_label`` is ``"<provider>/<model>"`` as written to run.json ``crowd.model``.
    ``prices`` feeds the budget's pre-call estimate.
    """

    model_label: str
    prices: Prices

    def complete(
        self,
        messages: Sequence[ChatMessage],
        *,
        temperature: float,
        max_tokens: int,
        json_mode: bool,
        purpose: str,
    ) -> LLMResult: ...


def prompt_chars(messages: Sequence[ChatMessage]) -> int:
    """Characters of message content, the basis of Hyvo's token estimates."""
    return sum(len(m.content) for m in messages)
