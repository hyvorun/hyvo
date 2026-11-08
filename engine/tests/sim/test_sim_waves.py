"""A large crowd plays each round in waves: each decides from what the one before it left, and nothing else about a run changes."""

from __future__ import annotations

from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from simkit import call_lines, check_written_run, decision_data, events, offline_settings, sim_config, write_scenario

from hyvo.sim import run_simulation
from hyvo.sim.config import DEFAULT_WAVE_SIZE, SimConfigError

pytestmark = [pytest.mark.anvil, pytest.mark.oasis, pytest.mark.slow]

AGENTS, WAVE, BATCH = 12, 4, 2


@pytest.fixture(autouse=True)
def _oasis_logs_in_tmp(oasis_module: ModuleType) -> None:
    """Import OASIS through the session fixture, so its log file lands in a temp dir."""


def play(tmp_path: Path, **overrides: Any):
    scenario = write_scenario(tmp_path)
    config = sim_config(scenario, tmp_path / "runs", agents=AGENTS, rounds=3, batch_size=BATCH, **overrides)
    return run_simulation(config, settings=offline_settings())


def calls_by_round(run_dir: Path) -> dict[int, list[dict[str, Any]]]:
    rounds: dict[int, list[dict[str, Any]]] = {}
    for line in call_lines(run_dir):
        if line.get("purpose") == "agents":
            data = decision_data(line)
            rounds.setdefault(data["round"], []).append(data)
    return rounds


def test_later_waves_see_what_earlier_ones_did(tmp_path: Path) -> None:
    outcome = play(tmp_path, wave_size=WAVE)
    doc = check_written_run(outcome.path, agents=AGENTS)
    for round_ in doc["rounds"]:
        assert sorted(action["agentId"] for action in round_["actions"]) == sorted(agent["agentId"] for agent in doc["crowd"]["agents"])
    rounds = calls_by_round(outcome.run_dir)
    assert all(len(calls) == AGENTS // BATCH for calls in rounds.values())
    seen = {data["market"]["price"] for calls in rounds.values() for data in calls}
    first_round = {data["market"]["price"] for data in rounds[1]}
    assert len(first_round) > 1, "the price moved within round 1, and a later wave saw it"
    assert len(seen) > len(doc["rounds"])


def test_a_crowd_up_to_one_wave_plays_as_it_always_did(tmp_path: Path) -> None:
    outcome = play(tmp_path, wave_size=AGENTS)
    rounds = calls_by_round(outcome.run_dir)
    for calls in rounds.values():
        assert len({data["market"]["price"] for data in calls}) == 1, "one round, one snapshot"
    assert AGENTS <= DEFAULT_WAVE_SIZE


def test_the_same_seed_plays_the_same_waves(tmp_path: Path) -> None:
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    one = check_written_run(play(tmp_path / "a", wave_size=WAVE).path, agents=AGENTS)
    two = check_written_run(play(tmp_path / "b", wave_size=WAVE).path, agents=AGENTS)
    orders = [[[action["agentId"] for action in round_["actions"]] for round_ in doc["rounds"]] for doc in (one, two)]
    assert orders[0] == orders[1]
    assert orders[0][0] != orders[0][1], "who moves first changes from round to round"


def test_a_budget_that_runs_out_mid_round_leaves_the_other_waves_holding(tmp_path: Path) -> None:
    outcome = play(tmp_path, wave_size=WAVE, max_llm_calls=AGENTS // BATCH + 3)
    assert outcome.status == "partial"
    doc = check_written_run(outcome.path, agents=AGENTS)
    last = doc["rounds"][-1]
    assert len(last["actions"]) == AGENTS
    held = [action for action in last["actions"] if action["note"] == "budget_exhausted"]
    assert len(held) >= WAVE, [event["event"] for event in events(outcome.run_dir)][-8:]


def test_a_wave_needs_someone_in_it() -> None:
    with pytest.raises(SimConfigError, match="wave_size"):
        sim_config(Path("x.md"), Path("y"), wave_size=0)
