from __future__ import annotations

import threading

import pytest

from hyvo.llm.budget import BudgetMeter, estimate_call_cost_usd
from hyvo.llm.types import BudgetExceeded, ChatMessage, Prices

from .llm_fakes import result


def spend(meter: BudgetMeter, purpose: str, cost: float = 0.0, est: float = 0.0) -> None:
    meter.record(result(cost=cost), meter.check(purpose, est))


def test_stops_on_calls_and_keeps_the_report_reserve():
    meter = BudgetMeter(max_cost_usd=1.0, max_llm_calls=5, report_reserve_calls=2)
    for _ in range(3):
        spend(meter, "agents")
    with pytest.raises(BudgetExceeded) as refused:
        meter.check("agents", 0.0)
    assert (refused.value.reason, refused.value.purpose) == ("max_llm_calls", "agents")
    assert meter.stop_reason == "max_llm_calls"
    spend(meter, "report")
    spend(meter, "report")
    with pytest.raises(BudgetExceeded, match="max_llm_calls"):
        meter.check("report", 0.0)
    assert meter.usage()["llmCalls"] == 5


def test_stops_on_cost_with_the_default_ten_percent_report_reserve():
    meter = BudgetMeter(max_cost_usd=1.0, max_llm_calls=100)
    assert meter.report_reserve_usd == pytest.approx(0.1)
    for _ in range(3):
        spend(meter, "agents", cost=0.3)
    with pytest.raises(BudgetExceeded) as refused:
        meter.check("agents", 0.01)
    assert refused.value.reason == "max_cost_usd"
    spend(meter, "report", cost=0.1, est=0.1)  # lands exactly on the limit
    with pytest.raises(BudgetExceeded, match="max_cost_usd"):
        meter.check("report", 0.001)
    assert meter.usage()["costUsd"] == pytest.approx(1.0)


def test_pre_call_estimate_blocks_a_call_that_could_exceed_the_limit():
    meter = BudgetMeter(max_cost_usd=1.0, max_llm_calls=10)
    with pytest.raises(BudgetExceeded, match="max_cost_usd"):
        meter.check("agents", 0.95)  # agents may use 0.9
    assert meter.usage()["llmCalls"] == 0


def test_estimate_is_prompt_chars_over_four_plus_max_tokens_at_list_prices():
    msgs = [ChatMessage("system", "x" * 3_001), ChatMessage("user", "y" * 999)]
    estimate = estimate_call_cost_usd(msgs, 1_000, Prices(1.0, 2.0))
    assert estimate == pytest.approx((1_000 * 1.0 + 1_000 * 2.0) / 1_000_000)


def test_agent_stop_is_sticky_but_report_calls_continue():
    meter = BudgetMeter(max_cost_usd=1.0, max_llm_calls=100)
    with pytest.raises(BudgetExceeded):
        meter.check("agents", 0.95)
    with pytest.raises(BudgetExceeded, match="max_cost_usd"):
        meter.check("agents", 0.0)  # would fit, but the simulation already stopped
    spend(meter, "report", est=0.5)
    assert meter.stop_reason == "max_cost_usd"


def test_report_refusal_does_not_set_stop_reason():
    meter = BudgetMeter(max_cost_usd=0.0, max_llm_calls=10, report_reserve_usd=0.0)
    with pytest.raises(BudgetExceeded):
        meter.check("report", 0.01)
    assert meter.stop_reason is None


def test_in_flight_reservations_count_against_limits():
    meter = BudgetMeter(max_cost_usd=1.0, max_llm_calls=3, report_reserve_calls=0)
    pending = [meter.check("agents", 0.1) for _ in range(3)]
    with pytest.raises(BudgetExceeded, match="max_llm_calls"):
        meter.check("agents", 0.1)
    for reservation in pending:
        meter.record(result(cost=0.05), reservation)
    assert meter.usage()["llmCalls"] == 3


def test_in_flight_estimates_count_against_cost():
    meter = BudgetMeter(max_cost_usd=1.0, max_llm_calls=100, report_reserve_usd=0.0)
    first = meter.check("agents", 0.6)
    with pytest.raises(BudgetExceeded, match="max_cost_usd"):
        meter.check("agents", 0.6)
    meter.record(result(cost=0.2), first)


def test_concurrent_checks_never_exceed_the_call_limit():
    meter = BudgetMeter(max_cost_usd=10.0, max_llm_calls=100, report_reserve_calls=0)
    granted = []
    lock = threading.Lock()

    def worker():
        for _ in range(50):
            try:
                reservation = meter.check("agents", 0.001)
            except BudgetExceeded:
                continue
            with lock:
                granted.append(reservation)
            meter.record(result(cost=0.001), reservation)

    threads = [threading.Thread(target=worker) for _ in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(granted) == 100
    assert meter.usage()["llmCalls"] == 100


def test_failure_counts_a_call_and_possible_spend_but_not_reported_cost():
    meter = BudgetMeter(max_cost_usd=1.0, max_llm_calls=10, report_reserve_usd=0.0)
    meter.record_failure(meter.check("agents", 0.7), maybe_billed=True)
    meter.record_failure(meter.check("agents", 0.2), maybe_billed=False)
    assert meter.unaccounted_usd == pytest.approx(0.7)
    assert meter.usage() == {"llmCalls": 2, "inputTokens": 0, "outputTokens": 0, "costUsd": 0.0}
    with pytest.raises(BudgetExceeded, match="max_cost_usd"):
        meter.check("agents", 0.4)


def test_usage_is_the_run_json_object_with_cost_rounded():
    meter = BudgetMeter(max_cost_usd=1.0, max_llm_calls=10)
    meter.record(result(cost=0.0001234567, tokens=(1_000, 200)), meter.check("agents", 0.0))
    meter.record(result(cost=0.0000000004, tokens=(10, 2)), meter.check("report", 0.0))
    assert meter.usage() == {
        "llmCalls": 2,
        "inputTokens": 1_010,
        "outputTokens": 202,
        "costUsd": 0.000123,
    }


def test_a_reservation_settles_once():
    meter = BudgetMeter(max_cost_usd=1.0, max_llm_calls=10)
    reservation = meter.check("agents", 0.0)
    meter.record(result(), reservation)
    with pytest.raises(ValueError, match="already settled"):
        meter.record_failure(reservation, maybe_billed=False)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"max_cost_usd": -1, "max_llm_calls": 10},
        {"max_cost_usd": float("nan"), "max_llm_calls": 10},
        {"max_cost_usd": 1, "max_llm_calls": -1},
        {"max_cost_usd": 1, "max_llm_calls": True},
        {"max_cost_usd": 1, "max_llm_calls": 10, "report_reserve_calls": -1},
        {"max_cost_usd": 1, "max_llm_calls": 10, "report_reserve_calls": 1.5},
        {"max_cost_usd": 1, "max_llm_calls": 10, "report_reserve_usd": -0.1},
        {"max_cost_usd": 1, "max_llm_calls": 10, "report_reserve_usd": float("inf")},
    ],
)
def test_invalid_limits_are_rejected(kwargs):
    with pytest.raises(ValueError):
        BudgetMeter(**kwargs)


def test_reserves_are_capped_so_a_tiny_job_keeps_its_one_call_for_the_report():
    meter = BudgetMeter(max_cost_usd=0.2, max_llm_calls=1, report_reserve_usd=5.0)
    assert (meter.report_reserve_calls, meter.report_reserve_usd) == (1, 0.2)
    with pytest.raises(BudgetExceeded, match="max_llm_calls"):
        meter.check("agents", 0.0)
    spend(meter, "report", cost=0.1, est=0.2)
    assert meter.usage()["llmCalls"] == 1
    assert BudgetMeter(max_cost_usd=1.0, max_llm_calls=0).report_reserve_calls == 0


def test_unknown_purpose_and_bad_estimates_are_rejected():
    meter = BudgetMeter(max_cost_usd=1.0, max_llm_calls=10)
    with pytest.raises(ValueError, match="purpose"):
        meter.check("sim", 0.0)
    with pytest.raises(ValueError):
        meter.check("agents", -0.1)
