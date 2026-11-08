"""The runner against a fake API over real HTTP, with real child runs (offline model, real anvil).

Covers the Phase 3 runner DoD: a job is played and delivered with its hash; the runner survives
an API restart while idle and while a job runs; a lost lease stops the run; the hard timeout
kills the run; refusals and unreadable jobs are reported with ``fail``.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import psutil
import pytest
from typer.testing import CliRunner

from hyvo import health
from hyvo.cli import app
from hyvo.runfile import hash_run, scenario_hash, summarize_run
from hyvo.runner import JobsApi, Runner, RunnerOptions, RunnerStopped
from hyvo.runner import child as child_module
from tests.runner.fake_api import TOKEN, FakeJobsApi, small_spec

pytestmark = [pytest.mark.anvil, pytest.mark.slow]


@pytest.fixture
def fake() -> Iterator[FakeJobsApi]:
    api = FakeJobsApi().start()
    yield api
    api.stop()


def _runner(fake: FakeJobsApi, tmp_path: Path, lines: list[str], **options: float) -> Runner:
    client = JobsApi(fake.url, TOKEN)
    settings = {"poll_interval_s": 0.2, "max_backoff_s": 1.0, **options}
    return Runner(
        client,
        RunnerOptions(work_dir=tmp_path / "work", offline=True, fork=False, **settings),
        log=lines.append,
    )


def _anvils_started_after(moment: float) -> list[psutil.Process]:
    found = []
    for process in psutil.process_iter(["name", "create_time"]):
        name = (process.info["name"] or "").lower()
        if name in {"anvil", "anvil.exe"} and (process.info["create_time"] or 0) >= moment - 1:
            found.append(process)
    return found


def _wait_gone(processes: list[psutil.Process], timeout_s: float = 15) -> list[psutil.Process]:
    _, alive = psutil.wait_procs(processes, timeout=timeout_s)
    return alive


def test_a_job_is_played_delivered_and_hashed(fake: FakeJobsApi, tmp_path: Path) -> None:
    run_id = fake.add_job()
    lines: list[str] = []
    [result] = _runner(fake, tmp_path, lines).serve(max_jobs=1)

    assert result.outcome == "completed", lines
    assert fake.completed[run_id] == result.hash
    doc = json.loads(fake.uploads[run_id])
    assert doc["runId"] == run_id and hash_run(doc) == doc["hash"] == result.hash
    # What the API is told comes from the run as uploaded.
    [meta] = fake.completes
    assert meta["summary"] == summarize_run(doc) and meta["usage"]["llmCalls"] == doc["usage"]["llmCalls"]
    assert meta["scenarioHash"] == scenario_hash(doc["scenario"])
    assert meta["eventRounds"] == [2]
    assert doc["crowd"]["size"] == 6 and len(doc["rounds"]) == 2
    assert doc["scenario"]["title"].startswith("Runner test")
    # Heartbeats carried the lease and, once rounds were played, the latest round.
    assert fake.heartbeats and all(body["leaseId"].startswith("lease_") for _, body in fake.heartbeats)
    assert any(body.get("progress", {}).get("rounds") == 2 for _, body in fake.heartbeats), fake.heartbeats
    # The signed upload never carries the runner token.
    assert all("Authorization" not in headers for headers in fake.upload_headers)
    # Everything for the job is kept in its attempt folder.
    folder = tmp_path / "work" / run_id / "attempt-1"
    assert (folder / "job.json").is_file() and (folder / "runs" / run_id / "run.json").is_file()
    assert any("complete and published" in line for line in lines)


def test_the_runner_waits_out_an_api_that_is_down(fake: FakeJobsApi, tmp_path: Path) -> None:
    fake.stop()
    lines: list[str] = []
    runner = _runner(fake, tmp_path, lines)
    worker = threading.Thread(target=lambda: lines.append(repr(runner.serve(max_jobs=1))))
    worker.start()
    # A few failed polls; on Windows a refused localhost connect takes about 2 s to fail.
    time.sleep(5)
    fake.add_job()
    fake.start()
    worker.join(timeout=180)
    assert not worker.is_alive()
    assert any("API unavailable" in line for line in lines)
    assert len(fake.completed) == 1, lines


def test_the_runner_keeps_its_health_file_fresh_while_it_plays(fake: FakeJobsApi, tmp_path: Path) -> None:
    fake.add_job()
    health_file = tmp_path / "runner.health"
    options = RunnerOptions(work_dir=tmp_path / "work", offline=True, fork=False, poll_interval_s=0.05, health_file=health_file)
    with JobsApi(fake.url, TOKEN) as client:
        Runner(client, options, log=lambda _: None).serve(max_jobs=1)
    healthy, text = health.check(health_file, 300)
    assert healthy, text


def test_a_job_survives_an_api_restart_while_it_runs(fake: FakeJobsApi, tmp_path: Path) -> None:
    run_id = fake.add_job()
    restarted: list[threading.Thread] = []
    fake.on_claim = lambda _: restarted.append(fake.restart_after(4.0))
    lines: list[str] = []
    [result] = _runner(fake, tmp_path, lines).serve(max_jobs=1)
    restarted[0].join()
    assert result.outcome == "completed", lines
    assert fake.completed[run_id] == result.hash
    assert any("heartbeat failed" in line for line in lines), lines


def test_a_lost_lease_stops_the_run(fake: FakeJobsApi, tmp_path: Path) -> None:
    started = time.time()
    run_id = fake.add_job(heartbeat_s=0.3)
    fake.lose_lease_after = 1
    lines: list[str] = []
    [result] = _runner(fake, tmp_path, lines).serve(max_jobs=1)
    assert result.outcome == "abandoned"
    assert run_id not in fake.completed and not fake.uploads
    assert not _wait_gone(_anvils_started_after(started)), "anvil outlived the killed run"


def test_the_hard_timeout_kills_the_run(fake: FakeJobsApi, tmp_path: Path) -> None:
    started = time.time()
    run_id = fake.add_job(timeout_s=2.0)
    lines: list[str] = []
    [result] = _runner(fake, tmp_path, lines).serve(max_jobs=1)
    assert result.outcome == "failed" and "timed out" in result.detail
    [failure] = fake.failures
    assert failure["runId"] == run_id and failure["retryable"] is True
    assert not _wait_gone(_anvils_started_after(started)), "anvil outlived the killed run"


def test_an_unreadable_job_is_reported(fake: FakeJobsApi, tmp_path: Path) -> None:
    run_id = fake.add_job(small_spec(version=2))
    [result] = _runner(fake, tmp_path, []).serve(max_jobs=1)
    assert result.outcome == "failed"
    [failure] = fake.failures
    assert failure["runId"] == run_id and "cannot read this job" in failure["reason"]


def test_a_refused_token_stops_the_runner(fake: FakeJobsApi, tmp_path: Path) -> None:
    runner = Runner(JobsApi(fake.url, "wrong"), RunnerOptions(work_dir=tmp_path), log=lambda _: None)
    with pytest.raises(RunnerStopped, match="runner token"):
        runner.serve(max_jobs=1)


def test_a_server_error_on_next_is_retried(fake: FakeJobsApi, tmp_path: Path) -> None:
    fake.add_job()
    fake.next_status = 503
    lines: list[str] = []
    [result] = _runner(fake, tmp_path, lines).serve(max_jobs=1)
    assert result.outcome == "completed"
    assert any("API unavailable" in line for line in lines)


def test_the_child_refuses_a_bad_job_with_exit_code_2(tmp_path: Path) -> None:
    job = tmp_path / "job.json"
    job.write_text(json.dumps({"runId": "run_x", "leaseId": "lease_x"}), encoding="utf-8")
    code = child_module.main(
        [str(job), str(tmp_path / "result.json"), "--runs-dir", str(tmp_path), "--timeout-s", "60"]
    )
    assert code == child_module.EXIT_BAD_JOB
    assert not (tmp_path / "result.json").exists()


def test_cli_runner_needs_a_token_and_an_api(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("RUNNER_TOKEN", raising=False)
    monkeypatch.delenv("HYVO_API_URL", raising=False)
    cli = CliRunner()
    result = cli.invoke(app, ["runner", "--work-dir", str(tmp_path)])
    assert result.exit_code == 2 and "no API URL" in result.output
    result = cli.invoke(app, ["runner", "--api", "http://127.0.0.1:9", "--work-dir", str(tmp_path)])
    assert result.exit_code == 2 and "RUNNER_TOKEN" in result.output


def test_cli_runner_once_plays_one_job(
    fake: FakeJobsApi, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    run_id = fake.add_job()
    monkeypatch.setenv("RUNNER_TOKEN", TOKEN)
    result = CliRunner().invoke(
        app,
        ["runner", "--api", fake.url, "--once", "--offline", "--no-fork", "--poll-interval", "0.2",
         "--work-dir", str(tmp_path)],
    )
    assert result.exit_code == 0, result.output
    assert run_id in fake.completed
    assert "complete and published" in result.output
    assert TOKEN not in result.output
