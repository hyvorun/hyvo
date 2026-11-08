"""parse_job: the envelope first, then a strict spec that becomes the engine's SimConfig."""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from hyvo.personas import generate_crowd
from hyvo.runfile.canonical import new_run_id
from hyvo.runner import JobError, parse_job
from tests.runner.fake_api import small_spec

LEASE = "lease_0000000000000001"


def _job(**overrides: Any) -> dict[str, Any]:
    job: dict[str, Any] = {
        "runId": new_run_id(),
        "leaseId": LEASE,
        "attempt": 1,
        "heartbeatIntervalS": 15,
        "timeoutS": 1800,
        "spec": small_spec(),
    }
    job.update(overrides)
    return job


def test_a_valid_job_becomes_a_sim_config(tmp_path: Path) -> None:
    payload = _job()
    job = parse_job(payload)
    assert job.run_id == payload["runId"] and job.attempt == 1 and job.timeout_s == 1800.0
    config = job.spec.to_sim_config(
        run_id=job.run_id, runs_dir=tmp_path, offline=True, timeout_s=60, fork=False
    )
    assert config.run_id == job.run_id
    assert (config.agents, config.rounds, config.seed) == (6, 2, 11)
    assert (config.max_cost_usd, config.max_llm_calls, config.batch_size) == (0.5, 100, 10)
    assert config.fork is False and config.offline is True
    scenario = config.scenario
    assert scenario.title.startswith("Runner test")
    assert scenario.market.token_symbol == "FIZZ"
    assert scenario.market.liquidity_eth == Decimal(5)
    assert [(e.round, e.text) for e in scenario.injected_events] == [
        (2, "A large wallet posts that it entered early.")
    ]
    assert scenario.seed_sources[0].ref == "api"


def test_scenario_text_is_sanitized_like_any_scenario() -> None:
    spec = small_spec()
    spec["scenario"]["seedText"] = "Launch page https://pons.example/fizz?ref=x\u200b now"
    job = parse_job(_job(spec=spec))
    assert job.spec.to_scenario().seed_text == "Launch page pons.example/fizz now"


def test_the_token_name_is_sanitized_too() -> None:
    spec = small_spec()
    spec["scenario"]["market"] = {"tokenName": "Fizz\u200b https://x.example/a?b=1"}
    assert parse_job(_job(spec=spec)).spec.to_scenario().market.token_name == "Fizz x.example/a"
    spec["scenario"]["market"] = {"tokenName": "\u200b"}
    assert parse_job(_job(spec=spec)).spec.to_scenario().market.token_name is None


def test_a_partial_mix_makes_a_crowd(tmp_path: Path) -> None:
    job = parse_job(_job(spec=small_spec(mix={"sniper": 2, "skeptic": 4})))
    config = job.spec.to_sim_config(run_id=job.run_id, runs_dir=tmp_path, offline=True, timeout_s=60)
    crowd = generate_crowd(config.agents, config.mix, seed=1)
    assert sorted(agent.persona.id for agent in crowd) == ["skeptic"] * 4 + ["sniper"] * 2


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"agents": 0}, "spec.agents"),
        ({"rounds": "2"}, "spec.rounds"),
        ({"version": 2}, "spec.version"),
        ({"maxCostUsd": -1}, "spec.maxCostUsd"),
        ({"surprise": True}, "spec.surprise"),
        ({"mix": {"sniper": 3, "holder": 2}}, "add up|sum"),
        ({"mix": {"wizard": 6}}, "unknown persona"),
    ],
)
def test_a_bad_spec_is_refused_but_keeps_the_ids(change: dict[str, Any], message: str) -> None:
    payload = _job(spec=small_spec(**change))
    with pytest.raises(JobError, match=message) as caught:
        parse_job(payload)
    assert caught.value.run_id == payload["runId"] and caught.value.lease_id == LEASE


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"title": "\u200b"}, "title"),
        ({"events": [{"round": 5, "text": "late"}]}, "after the last round"),
        ({"market": {"liquidityEth": "1e3"}}, "decimal string"),
        ({"market": {"tokenSymbol": "fizz"}}, "token_symbol"),
        ({"market": {"feeBps": 5000}}, "fee_bps"),
    ],
)
def test_scenario_problems_are_refused(change: dict[str, Any], message: str) -> None:
    spec = small_spec()
    spec["scenario"].update(change)
    with pytest.raises(JobError, match=message):
        parse_job(_job(spec=spec))


@pytest.mark.parametrize(
    "change",
    [{"runId": "run_123"}, {"runId": None}, {"leaseId": "x"}, {"leaseId": 7}],
)
def test_a_job_without_valid_ids_cannot_be_reported(change: dict[str, Any]) -> None:
    with pytest.raises(JobError) as caught:
        parse_job(_job(**change))
    assert caught.value.lease_id is None or caught.value.run_id is None


@pytest.mark.parametrize(
    "change", [{"attempt": 0}, {"attempt": True}, {"timeoutS": 0}, {"heartbeatIntervalS": "15"}]
)
def test_envelope_numbers_are_checked(change: dict[str, Any]) -> None:
    with pytest.raises(JobError):
        parse_job(_job(**change))


def test_a_job_that_is_not_an_object_is_refused() -> None:
    with pytest.raises(JobError, match="not a JSON object"):
        parse_job(["job"])
