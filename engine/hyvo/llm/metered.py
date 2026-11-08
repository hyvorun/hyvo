"""``MeteredClient``: the only way engine code should call a model.

Order per call: budget check (worst-case estimate) -> client call -> record usage -> log line.
A refused call is logged and raises ``BudgetExceeded``; nothing is sent. A failed call is still
counted and logged before its exception propagates.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

from .budget import BudgetMeter, estimate_call_cost_usd
from .log import LLMLog
from .types import (
    BudgetExceeded,
    ChatMessage,
    LLMClient,
    LLMRequestError,
    LLMResponseError,
    LLMResult,
)

_SAFE_ERRORS = (BudgetExceeded, LLMRequestError, LLMResponseError)


class MeteredClient:
    """Wraps an ``LLMClient`` with a shared ``BudgetMeter`` and ``LLMLog``; itself an
    ``LLMClient``. Wrap the agents and the report client around the same meter and log."""

    def __init__(self, client: LLMClient, budget: BudgetMeter, log: LLMLog) -> None:
        self.client = client
        self.budget = budget
        self.log = log
        self.model_label = client.model_label
        self.prices = client.prices

    def __repr__(self) -> str:
        return f"MeteredClient({self.client!r})"

    def complete(
        self,
        messages: Sequence[ChatMessage],
        *,
        temperature: float,
        max_tokens: int,
        json_mode: bool,
        purpose: str,
    ) -> LLMResult:
        """Same contract as ``LLMClient.complete``; ``purpose`` is ``"agents"`` or ``"report"``."""
        messages = tuple(messages)
        if isinstance(max_tokens, bool) or not isinstance(max_tokens, int) or max_tokens < 1:
            raise ValueError("max_tokens must be an integer >= 1")
        if (
            isinstance(temperature, bool)
            or not isinstance(temperature, (int, float))
            or not math.isfinite(temperature)
            or temperature < 0
        ):
            raise ValueError("temperature must be a finite number >= 0")
        request = {
            "purpose": purpose,
            "model": self.model_label,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "json_mode": json_mode,
        }
        estimate = estimate_call_cost_usd(messages, max_tokens, self.prices)
        try:
            reservation = self.budget.check(purpose, estimate)
        except BudgetExceeded as refused:
            self.log.write(**request, error=f"budget_exceeded: {refused.reason}")
            raise
        try:
            result = self.client.complete(
                messages,
                temperature=temperature,
                max_tokens=max_tokens,
                json_mode=json_mode,
                purpose=purpose,
            )
        except LLMResponseError as error:
            if error.result is not None:
                self.budget.record(error.result, reservation)
            else:
                self.budget.record_failure(reservation, maybe_billed=False)
            self.log.write(**request, result=error.result, error=_describe(error))
            raise
        except BaseException as error:
            maybe_billed = error.maybe_billed if isinstance(error, LLMRequestError) else True
            self.budget.record_failure(reservation, maybe_billed=maybe_billed)
            self.log.write(**request, error=_describe(error))
            raise
        self.budget.record(result, reservation)
        self.log.write(**request, result=result)
        return result


def _describe(error: BaseException) -> str:
    """Log text for an error: Hyvo's own messages are safe; others log only their type."""
    if isinstance(error, _SAFE_ERRORS):
        return f"{type(error).__name__}: {error}"
    return type(error).__name__
