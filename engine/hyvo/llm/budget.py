"""Per-run LLM budget: ``maxCostUsd`` and ``maxLlmCalls`` with a reserve for the report.

Every call is checked *before* it is sent against an estimate of its cost:
``ceil(prompt_chars / 4)`` input tokens plus ``max_tokens`` output tokens (the most the call can
produce) at the client's prices. ``check`` reserves that estimate (so concurrent calls cannot
jointly overshoot) and returns a ``Reservation`` that is settled by ``record`` (actual usage) or
``record_failure`` (no usage known). The estimate bounds the call's cost when ``max_tokens``
bounds every billed output token (true for the chat models Hyvo targets) and the prompt is not
far denser than 4 characters per token; otherwise one call can overshoot by the difference, and
the next check then refuses.

Agent calls may not dip into the report reserve; report calls may use everything left. The
reserves are capped at the limits, so a job with ``maxLlmCalls = 1`` keeps its only call for the
report. The first refused agents call stops the simulation for good (``stop_reason``); later
agents calls are refused with the same reason, so a run stops cleanly at one point. Report
refusals do not set it.
"""

from __future__ import annotations

import math
import threading
from collections.abc import Sequence
from typing import cast

from .pricing import cost_usd, estimate_tokens
from .types import (
    PURPOSES,
    BudgetExceeded,
    ChatMessage,
    LLMResult,
    Prices,
    Purpose,
    StopReason,
    prompt_chars,
)

_EPS = 1e-12  # float slack so a call that lands exactly on a limit is allowed


def estimate_call_cost_usd(
    messages: Sequence[ChatMessage], max_tokens: int, prices: Prices
) -> float:
    """Pre-call cost estimate of one call (see the module docstring)."""
    return cost_usd(prices, estimate_tokens(prompt_chars(messages)), max_tokens)


class Reservation:
    """A checked, not yet settled call. Settle it exactly once."""

    __slots__ = ("_settled", "est_cost_usd", "purpose")

    def __init__(self, purpose: Purpose, est_cost_usd: float) -> None:
        self.purpose = purpose
        self.est_cost_usd = est_cost_usd
        self._settled = False


class BudgetMeter:
    """Thread-safe call and cost accounting for one run."""

    def __init__(
        self,
        max_cost_usd: float,
        max_llm_calls: int,
        report_reserve_calls: int = 2,
        report_reserve_usd: float | None = None,
    ) -> None:
        if not math.isfinite(max_cost_usd) or max_cost_usd < 0:
            raise ValueError("max_cost_usd must be a finite number >= 0")
        if not _is_int(max_llm_calls) or max_llm_calls < 0:
            raise ValueError("max_llm_calls must be an integer >= 0")
        if not _is_int(report_reserve_calls) or report_reserve_calls < 0:
            raise ValueError("report_reserve_calls must be an integer >= 0")
        reserve_usd = 0.1 * max_cost_usd if report_reserve_usd is None else report_reserve_usd
        if not math.isfinite(reserve_usd) or reserve_usd < 0:
            raise ValueError("report_reserve_usd must be a finite number >= 0")
        self.max_cost_usd = float(max_cost_usd)
        self.max_llm_calls = max_llm_calls
        self.report_reserve_calls = min(report_reserve_calls, max_llm_calls)
        self.report_reserve_usd = float(min(reserve_usd, max_cost_usd))
        self._lock = threading.Lock()
        self._calls = 0
        self._input_tokens = 0
        self._output_tokens = 0
        self._cost = 0.0
        self._unaccounted = 0.0
        self._pending_calls = 0
        self._pending_cost = 0.0
        self._stop_reason: StopReason | None = None

    def check(self, purpose: str, est_cost_usd: float) -> Reservation:
        """Reserve one call, or raise ``BudgetExceeded`` if it could exceed a limit.

        ``purpose`` is ``"agents"`` or ``"report"``.
        """
        if purpose not in PURPOSES:
            raise ValueError(f"unknown purpose {purpose!r}; expected 'agents' or 'report'")
        if not math.isfinite(est_cost_usd) or est_cost_usd < 0:
            raise ValueError("est_cost_usd must be a finite number >= 0")
        checked = cast(Purpose, purpose)
        with self._lock:
            reason = self._refusal(checked, est_cost_usd)
            if reason is not None:
                if checked == "agents":
                    self._stop_reason = reason
                raise BudgetExceeded(reason, checked)
            self._pending_calls += 1
            self._pending_cost += est_cost_usd
            return Reservation(checked, est_cost_usd)

    def record(self, result: LLMResult, reservation: Reservation) -> None:
        """Settle a reservation with the call's actual usage."""
        with self._lock:
            self._settle(reservation)
            self._calls += 1
            self._input_tokens += result.input_tokens
            self._output_tokens += result.output_tokens
            self._cost += result.cost_usd

    def record_failure(self, reservation: Reservation, *, maybe_billed: bool) -> None:
        """Settle a reservation for a call that was sent but returned no usage.

        The call counts toward ``maxLlmCalls``. If the provider may have billed it, its
        estimate counts toward ``maxCostUsd`` checks (``unaccounted_usd``) but not toward the
        reported ``costUsd``, which only holds known spend.
        """
        with self._lock:
            self._settle(reservation)
            self._calls += 1
            if maybe_billed:
                self._unaccounted += reservation.est_cost_usd

    def usage(self) -> dict[str, int | float]:
        """The run.json ``usage`` object."""
        with self._lock:
            return {
                "llmCalls": self._calls,
                "inputTokens": self._input_tokens,
                "outputTokens": self._output_tokens,
                "costUsd": round(self._cost, 6),
            }

    def would_refuse(
        self, purpose: str, est_cost_usd: float = 0.0, calls: int = 1
    ) -> StopReason | None:
        """Why ``check`` would refuse ``calls`` more calls costing ``est_cost_usd`` in total right
        now, or None. Reserves nothing and never sets ``stop_reason``."""
        if purpose not in PURPOSES:
            raise ValueError(f"unknown purpose {purpose!r}; expected 'agents' or 'report'")
        if not _is_int(calls) or calls < 1:
            raise ValueError("calls must be an integer >= 1")
        if not math.isfinite(est_cost_usd) or est_cost_usd < 0:
            raise ValueError("est_cost_usd must be a finite number >= 0")
        with self._lock:
            return self._refusal(cast(Purpose, purpose), est_cost_usd, calls)

    @property
    def stop_reason(self) -> StopReason | None:
        """Why agent calls stopped (run.json ``stopReason``), or None while they may run."""
        with self._lock:
            return self._stop_reason

    @property
    def unaccounted_usd(self) -> float:
        """Possible spend of failed calls with unknown usage (counted against the limit)."""
        with self._lock:
            return self._unaccounted

    def _refusal(self, purpose: Purpose, est_cost_usd: float, calls: int = 1) -> StopReason | None:
        if purpose == "agents":
            if self._stop_reason is not None:
                return self._stop_reason
            call_limit = self.max_llm_calls - self.report_reserve_calls
            cost_limit = self.max_cost_usd - self.report_reserve_usd
        else:
            call_limit = self.max_llm_calls
            cost_limit = self.max_cost_usd
        if self._calls + self._pending_calls + calls > call_limit:
            return "max_llm_calls"
        committed = self._cost + self._unaccounted + self._pending_cost
        if committed + est_cost_usd > cost_limit + _EPS:
            return "max_cost_usd"
        return None

    def _settle(self, reservation: Reservation) -> None:
        if reservation._settled:
            raise ValueError("this reservation was already settled")
        reservation._settled = True
        self._pending_calls -= 1
        # Reset at zero so float rounding of the running sum cannot build up across a run.
        self._pending_cost = (
            self._pending_cost - reservation.est_cost_usd if self._pending_calls else 0.0
        )


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)
