"""A Dry Run as a runner job: claimed from the API, played in a child process, delivered with its hash."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from hyvo.dryrun.document import hash_dry_run
from hyvo.runner import JobsApi, Runner, RunnerOptions
from hyvo.runner.models import JobError, parse_job
from tests.runner.fake_api import TOKEN, FakeJobsApi

ARTIFACT = json.loads((Path(__file__).resolve().parents[3] / "chain" / "artifacts" / "SampleVault.json").read_text(encoding="utf-8"))
FIXTURE = Path(__file__).resolve().parents[3] / "fixtures" / "dryrun-sample.json"


def spec(**changes: Any) -> dict[str, Any]:
    return {
        "description": "A savings vault.",
        "abi": ARTIFACT["abi"],
        "bytecode": ARTIFACT["bytecode"],
        "invariants": ["isSolvent"],
        "agents": 8,
        "rounds": 3,
        "seed": 5,
        "maxCostUsd": 0.5,
        "maxLlmCalls": 20,
        **changes,
    }


def envelope(spec_: dict[str, Any], **changes: Any) -> dict[str, Any]:
    return {
        "runId": "run_01M6PSDFCY6AK9WZ3H9XX9GB9J",
        "leaseId": "lease_" + "a" * 24,
        "attempt": 1,
        "heartbeatIntervalS": 15,
        "timeoutS": 600,
        "kind": "dryrun",
        "spec": spec_,
        **changes,
    }


@pytest.fixture
def fake() -> Iterator[FakeJobsApi]:
    api = FakeJobsApi().start()
    yield api
    api.stop()


def test_a_dry_run_job_is_read_as_one() -> None:
    job = parse_job(envelope(spec()))
    assert job.kind == "dryrun" and job.spec.agents == 8 and job.spec.max_llm_calls == 20
    assert job.spec.invariants == ("isSolvent",)


def test_a_job_with_no_kind_is_a_run_as_it_always_was() -> None:
    with pytest.raises(JobError) as caught:
        parse_job({**envelope(spec()), "kind": None})
    assert caught.value.lease_id == "lease_" + "a" * 24


@pytest.mark.parametrize("bad", [{"evil": 1}, {"agents": 2}, {"description": ""}, {"bytecode": None}])
def test_an_unreadable_dry_run_can_still_be_reported_back(bad: dict[str, Any]) -> None:
    with pytest.raises(JobError) as caught:
        parse_job(envelope(spec(**bad)))
    assert caught.value.run_id and caught.value.lease_id


def test_an_unknown_kind_is_refused_and_can_be_reported_back() -> None:
    with pytest.raises(JobError, match="kind") as caught:
        parse_job(envelope(spec(), kind="surprise"))
    assert caught.value.lease_id


@pytest.mark.anvil
@pytest.mark.slow
def test_a_runner_plays_a_dry_run_and_delivers_its_report(fake: FakeJobsApi, tmp_path: Path) -> None:
    run_id = fake.add_job(spec(), kind="dryrun")
    lines: list[str] = []
    runner = Runner(JobsApi(fake.url, TOKEN), RunnerOptions(work_dir=tmp_path / "work", offline=True, fork=False, poll_interval_s=0.2), log=lines.append)
    [result] = runner.serve(max_jobs=1)
    assert result.outcome == "completed", lines
    report = json.loads(fake.uploads[run_id])
    assert report["kind"] == "dryrun" and report["runId"] == run_id and hash_dry_run(report) == report["hash"] == result.hash
    [meta] = fake.completes
    assert meta["summary"]["calls"] == len(report["calls"]) and meta["usage"]["llmCalls"] == report["usage"]["llmCalls"]
    assert set(meta) == {"leaseId", "hash", "sha256", "summary", "usage"}
    assert any(body.get("progress", {}).get("rounds") == 3 for _, body in fake.heartbeats) or fake.heartbeats == []


@pytest.mark.anvil
@pytest.mark.slow
def test_a_contract_that_cannot_deploy_fails_for_good_instead_of_being_retried(fake: FakeJobsApi, tmp_path: Path) -> None:
    run_id = fake.add_job(spec(bytecode="0xfe"), kind="dryrun")
    runner = Runner(JobsApi(fake.url, TOKEN), RunnerOptions(work_dir=tmp_path / "work", offline=True, fork=False, poll_interval_s=0.2), log=lambda _: None)
    [result] = runner.serve(max_jobs=1)
    assert result.outcome == "failed"
    [failure] = fake.failures
    assert failure["runId"] == run_id and failure["retryable"] is False


def test_the_committed_report_matches_the_format_and_its_hash() -> None:
    report = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert report["kind"] == "dryrun" and hash_dry_run(report) == report["hash"]
    assert {finding["kind"] for finding in report["findings"]} >= {"invariant_violation", "access_control", "unusual_balance"}
