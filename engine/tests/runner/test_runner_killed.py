"""A runner killed in the middle of a job loses nothing (SPEC §14 Phase 4).

The API's half is in ``apps/api/test/jobs.test.ts``: "takes a job back from a runner that went quiet" and
"forgets an upload when the job goes back to the queue". This is the runner's half, with a real process killed
without warning: the run it left behind stops by itself, so it does not spend the model allowance on a result
nobody will read, and the next runner plays the job and delivers it.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path

import psutil
import pytest

from hyvo.runfile import hash_run
from tests.runner.fake_api import TOKEN, FakeJobsApi, small_spec

pytestmark = [pytest.mark.anvil, pytest.mark.slow]


@pytest.fixture
def fake() -> Iterator[FakeJobsApi]:
    api = FakeJobsApi().start()
    yield api
    api.stop()


def start_runner(fake: FakeJobsApi, work_dir: Path) -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        [
            sys.executable, "-m", "hyvo", "runner",
            "--api", fake.url,
            "--once", "--offline", "--no-fork",
            "--poll-interval", "0.2",
            "--work-dir", str(work_dir),
        ],  # fmt: skip
        env={**os.environ, "RUNNER_TOKEN": TOKEN, "HYVO_NO_DOTENV": "1", "PYTHONUTF8": "1"},
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def wait_for(condition: object, timeout_s: float, what: str) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if condition():  # type: ignore[operator]
            return
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


def test_a_job_outlives_the_runner_that_was_killed_playing_it(fake: FakeJobsApi, tmp_path: Path) -> None:
    run_id = fake.add_job(small_spec(agents=20, rounds=6), heartbeat_s=0.2)
    work_dir = tmp_path / "work"
    first = start_runner(fake, work_dir)
    try:
        wait_for(lambda: fake.heartbeats, 120, "the first heartbeat")
        supervisor = psutil.Process(first.pid)
        left_behind = supervisor.children(recursive=True)
        assert left_behind, "the runner has no run process to leave behind"
        first.kill()
        first.wait(timeout=30)
    finally:
        if first.poll() is None:
            first.kill()

    # The run has nobody to report to, so it stops by itself, anvil with it.
    _, alive = psutil.wait_procs(left_behind, timeout=120)
    assert not alive, f"still running after the runner died: {alive}"
    attempt_1 = work_dir / run_id / "attempt-1"
    assert not (attempt_1 / "result.json").exists(), "the orphaned run played to the end"
    assert run_id not in fake.completed and fake.attempts[run_id] == 1

    # The Worker takes the job back, and the next runner plays it from the start.
    fake.take_back(run_id)
    second = start_runner(fake, work_dir)
    try:
        assert second.wait(timeout=240) == 0
    finally:
        if second.poll() is None:
            second.kill()

    assert fake.attempts[run_id] == 2
    assert list(fake.completed) == [run_id] and len(fake.completes) == 1
    doc = json.loads(fake.uploads[run_id])
    assert doc["runId"] == run_id and doc["status"] == "complete" and len(doc["rounds"]) == 6
    assert hash_run(doc) == doc["hash"] == fake.completed[run_id]
    assert (work_dir / run_id / "attempt-2" / "result.json").is_file()
