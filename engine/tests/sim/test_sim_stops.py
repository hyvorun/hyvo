"""A run stops cleanly when its budget (calls or cost) runs out or its timeout passes.

Each stop gives status ``partial`` with the right ``stopReason``, a valid hashed run.json whose
last round still has one action per agent, a report, and a clean teardown.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from types import ModuleType

import pytest
from simkit import (
    PricedOfflineClient,
    actions,
    anvil_pids,
    call_lines,
    check_written_run,
    events,
    llm_lines,
    offline_settings,
    sim_config,
    write_scenario,
)

from hyvo.llm.types import Prices
from hyvo.sim import SimulationError, run_simulation

pytestmark = [pytest.mark.anvil, pytest.mark.oasis, pytest.mark.slow]

AGENTS, BATCH = 12, 4  # three decision calls per round


@pytest.fixture(autouse=True)
def _oasis_logs_in_tmp(oasis_module: ModuleType) -> None:
    """Import OASIS through the session fixture, so its log file lands in a temp dir."""


def _assert_clean_partial(outcome, reason: str, before: set[int]) -> dict:
    assert outcome.status == "partial"
    assert outcome.stop_reason == reason
    doc = check_written_run(outcome.path, agents=AGENTS)
    assert doc["status"] == "partial" and doc["stopReason"] == reason
    assert len(doc["rounds"]) == outcome.rounds
    log = events(outcome.run_dir)
    [stopped] = [e for e in log if e["event"] == "stopped"]
    assert stopped["reason"] == reason and stopped["afterRound"] == outcome.rounds
    assert log[-1]["event"] == "teardown" and log[-1]["ok"] is True
    assert not (anvil_pids() - before)
    shutil.rmtree(outcome.run_dir)  # nothing is left open in the run directory
    return doc


def test_budget_stop_by_llm_calls(tmp_path: Path) -> None:
    # 2 calls are reserved for the report, so the agents get 4: round 1 uses 3, and in round 2
    # one batch is decided and the other two are refused.
    before = anvil_pids()
    outcome = run_simulation(
        sim_config(write_scenario(tmp_path), tmp_path / "runs", agents=AGENTS, batch_size=BATCH,
                   rounds=5, max_llm_calls=6),
        offline_settings(),
    )  # fmt: skip
    assert outcome.rounds == 2
    lines = llm_lines(outcome.run_dir)
    refused = [line for line in lines if line["error"] == "budget_exceeded: max_llm_calls"]
    assert len(refused) >= 1
    assert [line["purpose"] for line in call_lines(outcome.run_dir)].count("agents") == 4
    assert any(line["purpose"] == "report" for line in call_lines(outcome.run_dir))
    doc = _assert_clean_partial(outcome, "max_llm_calls", before)

    last = doc["rounds"][-1]["actions"]
    exhausted = [a for a in last if a["note"] == "budget_exhausted"]
    assert len(exhausted) == 2 * BATCH  # the two refused batches hold
    assert all(a["kind"] == "hold" and a["status"] == "ok" for a in exhausted)
    assert not any(a["note"] == "budget_exhausted" for a in doc["rounds"][0]["actions"])
    assert doc["usage"]["llmCalls"] <= 6
    # Placeholder sentiments of the held agents are left out of the round's mean.
    assert -1 <= doc["report"]["sentimentByRound"][-1] <= 1


def test_budget_stop_by_cost(tmp_path: Path) -> None:
    # $10 per million tokens: an agents call is estimated at about $0.02-0.04 before it is sent
    # (prompt plus max_tokens) and costs about $0.015-0.03; one call at a time.
    before = anvil_pids()
    client = PricedOfflineClient(5, Prices(10.0, 10.0))
    outcome = run_simulation(
        sim_config(write_scenario(tmp_path), tmp_path / "runs", agents=AGENTS, batch_size=BATCH,
                   rounds=6, max_cost_usd=0.15, max_concurrency=1),
        offline_settings(),
        clients=(client, client),
    )  # fmt: skip
    assert 2 <= outcome.rounds <= 4
    doc = _assert_clean_partial(outcome, "max_cost_usd", before)
    assert 0 < doc["usage"]["costUsd"] <= 0.15
    assert doc["crowd"]["model"]["agents"] == "test/priced-offline"
    # The run ends mid-round (some batches held) or at a round boundary; never on a round in
    # which every agent was held.
    for rnd in doc["rounds"]:
        assert not all(a["note"] == "budget_exhausted" for a in rnd["actions"])
    assert sum(1 for a in actions(doc) if a["note"] == "budget_exhausted") % BATCH == 0


def test_timeout_stops_at_a_round_boundary(tmp_path: Path) -> None:
    before = anvil_pids()
    outcome = run_simulation(
        sim_config(write_scenario(tmp_path), tmp_path / "runs", agents=AGENTS, batch_size=BATCH,
                   rounds=4, timeout_s=0.001),
        offline_settings(),
    )  # fmt: skip
    assert outcome.rounds == 1  # the first round always completes
    doc = _assert_clean_partial(outcome, "timeout", before)
    assert not any(a["note"] for a in actions(doc) if a["status"] == "ok" and a["kind"] == "hold")
    assert doc["report"]["summary"]


def test_a_budget_too_small_for_one_round_fails_without_a_run(tmp_path: Path) -> None:
    # With 2 calls in total both are reserved for the report: no agent can decide anything,
    # so there is no round to record and no run.json is written.
    before = anvil_pids()
    runs = tmp_path / "runs"
    with pytest.raises(SimulationError, match="too small for one round"):
        run_simulation(
            sim_config(write_scenario(tmp_path), runs, agents=AGENTS, batch_size=BATCH,
                       rounds=3, max_llm_calls=2),
            offline_settings(),
        )  # fmt: skip
    assert not list(runs.rglob("run*.json"))
    assert anvil_pids() <= before


def test_a_budget_spent_exactly_at_a_round_boundary_records_no_phantom_round(
    tmp_path: Path,
) -> None:
    # 3 agent calls per round and 2 report calls: 8 calls pay for exactly 2 rounds. Round 3
    # would get no decision at all, so the run ends after round 2 without recording it.
    before = anvil_pids()
    outcome = run_simulation(
        sim_config(write_scenario(tmp_path), tmp_path / "runs", agents=AGENTS, batch_size=BATCH,
                   rounds=5, max_llm_calls=8),
        offline_settings(),
    )  # fmt: skip
    assert outcome.rounds == 2
    doc = _assert_clean_partial(outcome, "max_llm_calls", before)
    assert not any(a["note"] == "budget_exhausted" for a in actions(doc))
    assert len(doc["report"]["sentimentByRound"]) == 2
    assert all(rnd["posts"] for rnd in doc["rounds"])


def test_the_round_where_the_budget_runs_out_is_deterministic(tmp_path: Path) -> None:
    # 10 calls: 2 full rounds (6), then round 3 can pay for 2 of its 3 batches. The batch that
    # is refused must be the same one every time, whatever the thread timing.
    def play(tag: str) -> dict:
        home = tmp_path / tag
        home.mkdir()
        outcome = run_simulation(
            sim_config(write_scenario(home), home / "runs", agents=AGENTS, batch_size=BATCH,
                       rounds=5, max_llm_calls=10, seed=7, max_concurrency=4),
            offline_settings(),
        )  # fmt: skip
        return check_written_run(outcome.path, agents=AGENTS)

    first, second = play("a"), play("b")
    assert first["stopReason"] == second["stopReason"] == "max_llm_calls"
    held = [[a["agentId"] for a in rnd["actions"] if a["note"] == "budget_exhausted"]
            for rnd in first["rounds"]]  # fmt: skip
    assert held[-1] and held[-1] == [
        a["agentId"] for a in second["rounds"][-1]["actions"] if a["note"] == "budget_exhausted"
    ]
    for one, two in zip(first["rounds"], second["rounds"], strict=True):
        assert [a["agentId"] + a["kind"] + a["status"] for a in one["actions"]] == [
            a["agentId"] + a["kind"] + a["status"] for a in two["actions"]
        ]
