"""The runner: pulls jobs from the Hyvo API and plays each one in a child process (SPEC 6.6).

For every job: write it to ``<work_dir>/<runId>/attempt-<n>/job.json``, start
``hyvo.runner.child``, heartbeat every ``heartbeatIntervalS`` (15 s) with the latest round, then
verify run.json, upload it through the signed URL and call ``complete`` with its hash, summary
and SHA-256, or call ``fail``. The Worker cannot re-check a run within the Workers Free CPU limit,
so this verification is the one before the hash goes on-chain (docs/OPEN_ITEMS.md item 21).

The API is the source of truth. A heartbeat answered with ``lease_lost`` means the job went back
to the queue (or finished elsewhere): the child is killed and its result dropped.

Deadlines: the child's soft limit is the job's timeout minus ``upload_reserve_s``; at that point
the run stops at a round boundary and is written as a partial run. The child is killed at the
job's timeout. The API itself returns a job whose runner went quiet to the queue once, then
fails it with a refund due.

API outages: polling backs off up to ``max_backoff_s``; a failed heartbeat is retried at the next
beat; the upload and ``complete`` are retried with backoff, heartbeating in between, until they
succeed, the lease is lost, or ``delivery_deadline_s`` passes. run.json stays on disk.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from hyvo import health
from hyvo.dryrun.document import dry_run_meta, dry_run_problems
from hyvo.publish import local_problems
from hyvo.runfile import load_run, run_meta

from . import child
from .api import (
    ApiRejected,
    ApiUnavailable,
    JobsApi,
    LeaseLost,
    Progress,
    RunnerAuthError,
)
from .models import Job, JobError

Outcome = Literal["completed", "failed", "abandoned"]
_KILL_WAIT_S = 30.0
_STOP_WAIT_S = 10.0
_MIN_SOFT_TIMEOUT_S = 30.0


class RunnerStopped(RuntimeError):
    """The runner cannot go on: its token was refused or its settings are broken."""


@dataclass(frozen=True)
class RunnerOptions:
    work_dir: Path
    offline: bool = False
    fork: bool | None = None  # None: fork when RH_RPC_URL is set (the engine default)
    # Every poll is a Worker request, and the Free plan's 100,000 a day are shared by the account.
    poll_interval_s: float = 15.0
    max_backoff_s: float = 60.0
    upload_reserve_s: float = 120.0
    delivery_deadline_s: float = 900.0
    python: str = sys.executable
    health_file: Path | None = None  # touched as the runner goes, for ``hyvo health``


@dataclass(frozen=True)
class JobResult:
    run_id: str
    outcome: Outcome
    detail: str
    hash: str | None = None


class Runner:
    def __init__(
        self,
        api: JobsApi,
        options: RunnerOptions,
        *,
        log: Callable[[str], None] | None = None,
        stop: threading.Event | None = None,
    ) -> None:
        self.api = api
        self.options = options
        self.stop = stop or threading.Event()
        self._log = log or (lambda line: print(line, file=sys.stderr, flush=True))

    # --- the loop ---------------------------------------------------------------------------

    def serve(self, *, max_jobs: int | None = None) -> list[JobResult]:
        """Poll and play jobs until ``stop`` is set or ``max_jobs`` jobs were handled."""
        results: list[JobResult] = []
        backoff = self.options.poll_interval_s
        while not self.stop.is_set() and (max_jobs is None or len(results) < max_jobs):
            self._alive("polling")
            try:
                result = self.poll_once()
            except ApiUnavailable as error:
                self._log(f"API unavailable ({error}); retrying in {backoff:.0f} s")
                self.stop.wait(backoff)
                backoff = min(backoff * 2, self.options.max_backoff_s)
                continue
            backoff = self.options.poll_interval_s
            if result is None:
                self.stop.wait(self.options.poll_interval_s)
                continue
            results.append(result)
        return results

    def _alive(self, state: str) -> None:
        if self.options.health_file is not None:
            health.touch(self.options.health_file, state)

    def poll_once(self) -> JobResult | None:
        """Claim and play one job; ``None`` when the queue is empty or paused."""
        try:
            job = self.api.next_job()
        except RunnerAuthError as error:
            raise RunnerStopped(f"the API refused the runner token ({error})") from None
        except JobError as error:
            return self._unreadable(error)
        if job is None:
            return None
        spec = job.spec
        if job.kind == "clone":  # its log line does not name the wallet
            self._log(f"job {job.run_id}: claimed (attempt {job.attempt}, a wallet clone)")
        else:
            self._log(
                f"job {job.run_id}: claimed (attempt {job.attempt}, {spec.agents} agents x "
                f"{spec.rounds} rounds, budget ${spec.max_cost_usd:g} / {spec.max_llm_calls} calls)"
            )
        return self.play(job)

    # --- one job ----------------------------------------------------------------------------

    def play(self, job: Job) -> JobResult:
        folder = self.options.work_dir / job.run_id / f"attempt-{job.attempt}"
        folder.mkdir(parents=True, exist_ok=True)
        job_file = folder / "job.json"
        job_file.write_text(json.dumps(_wire(job)), encoding="utf-8")
        result_file = folder / "result.json"
        soft_timeout = max(job.timeout_s - self.options.upload_reserve_s, _MIN_SOFT_TIMEOUT_S)
        command = [
            self.options.python,
            "-m",
            "hyvo.runner.child",
            str(job_file),
            str(result_file),
            "--runs-dir",
            str(folder / "runs"),
            "--timeout-s",
            f"{soft_timeout:g}",
        ]
        if self.options.offline:
            command.append("--offline")
        if self.options.fork is not None:
            command.append("--fork" if self.options.fork else "--no-fork")

        tracker = _ProgressTracker()
        with (folder / "child.log").open("w", encoding="utf-8", errors="replace") as log_file:
            try:
                process = subprocess.Popen(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=log_file,
                    stdin=subprocess.DEVNULL,
                    env=_child_env(),
                    cwd=str(folder),
                )
            except OSError as error:
                reason = f"the runner could not start a run process: {error}"
                self._try_fail(job, reason, retryable=True)
                raise RunnerStopped(reason) from None
            reader = threading.Thread(
                target=tracker.read, args=(process, log_file), name="runner-child-stdout", daemon=True
            )
            reader.start()
            try:
                ended = self._supervise(job, process, tracker)
            except BaseException:
                _stop(process)
                self._try_fail(job, "the runner stopped while the job was running", retryable=True)
                raise
            finally:
                reader.join(timeout=5)
        if ended is not None:
            return ended

        code = process.returncode
        outcome = _read_result(result_file) if code == child.EXIT_OK else None
        if outcome is not None:
            self._log(
                f"job {job.run_id}: run written ({outcome['status']}"
                + (f", {outcome['stopReason']}" if outcome.get("stopReason") else "")
                + f"), hash {outcome['hash']}"
            )
            delivered = self._deliver(job, Path(str(outcome["path"])))
            _forget_clone_job(job, folder)
            return delivered
        reason = _child_error(folder / "child.log") or f"the run process exited with code {code}"
        if code == child.EXIT_RUNNER_CONFIG:
            self._try_fail(job, reason, retryable=True)
            raise RunnerStopped(reason)
        retryable = code != child.EXIT_BAD_JOB
        status = self._try_fail(job, reason, retryable=retryable)
        self._log(f"job {job.run_id}: failed ({reason}); the job is now {status}")
        _forget_clone_job(job, folder)
        return JobResult(job.run_id, "failed", reason)

    def _supervise(
        self, job: Job, process: subprocess.Popen[bytes], tracker: _ProgressTracker
    ) -> JobResult | None:
        """Heartbeat until the child exits; a ``JobResult`` when the job ended early."""
        deadline = time.monotonic() + job.timeout_s
        interval = job.heartbeat_interval_s
        while True:
            remaining = deadline - time.monotonic()
            try:
                process.wait(timeout=max(min(interval, remaining), 0.05))
                return None
            except subprocess.TimeoutExpired:
                pass
            self._alive(f"playing {job.run_id}")
            if time.monotonic() >= deadline:
                _kill(process)
                reason = f"timed out after {job.timeout_s:g} s"
                status = self._try_fail(job, reason, retryable=True)
                self._log(f"job {job.run_id}: {reason}; the job is now {status}")
                return JobResult(job.run_id, "failed", reason)
            try:
                self.api.heartbeat(job.run_id, job.lease_id, tracker.latest)
            except LeaseLost:
                _kill(process)
                self._log(f"job {job.run_id}: lease lost; the run was stopped and dropped")
                return JobResult(job.run_id, "abandoned", "lease lost")
            except RunnerAuthError as error:
                _kill(process)
                raise RunnerStopped(f"the API refused the runner token ({error})") from None
            except (ApiUnavailable, ApiRejected) as error:
                self._log(f"job {job.run_id}: heartbeat failed ({error}); still running")
            if tracker.latest is not None and tracker.changed():
                self._log(f"job {job.run_id}: round {tracker.latest.round}/{tracker.latest.rounds}")

    def _deliver(self, job: Job, run_path: Path) -> JobResult:
        data = run_path.read_bytes()
        if job.kind == "clone":
            problems = []
        elif job.kind == "dryrun":
            document = json.loads(data)
            problems = dry_run_problems(document)
        else:
            problems = local_problems(run_path)
        if problems:
            reason = "the written run does not verify: " + "; ".join(problems[:3])
            status = self._try_fail(job, reason, retryable=True)
            self._log(f"job {job.run_id}: {reason}; the job is now {status}")
            return JobResult(job.run_id, "failed", reason)
        if job.kind == "clone":
            meta = {"profile": json.loads(data)["profile"]}
        elif job.kind == "dryrun":
            meta = dry_run_meta(document, data)
        else:
            meta = run_meta(load_run(run_path), data)
        run_hash = meta.get("hash", "")
        deadline = time.monotonic() + self.options.delivery_deadline_s
        backoff = self.options.poll_interval_s
        while True:
            self._alive(f"delivering {job.run_id}")
            try:
                if job.kind != "clone":  # a clone's numbers travel with `complete`: they are not a file anyone downloads
                    target = self.api.upload_url(job.run_id, job.lease_id)
                    if target.max_bytes and len(data) > target.max_bytes:
                        reason = f"run.json is {len(data)} bytes; the API accepts {target.max_bytes}"
                        self._try_fail(job, reason, retryable=False)
                        return JobResult(job.run_id, "failed", reason)
                    self.api.upload(target, data)
                self.api.complete(job.run_id, job.lease_id, meta)
            except LeaseLost:
                self._log(f"job {job.run_id}: lease lost before delivery; the result was dropped")
                return JobResult(job.run_id, "abandoned", "lease lost")
            except RunnerAuthError as error:
                raise RunnerStopped(f"the API refused the runner token ({error})") from None
            except ApiRejected as error:
                reason = f"the API refused the run: {error}"
                status = self._try_fail(job, reason, retryable=True)
                self._log(f"job {job.run_id}: {reason}; the job is now {status}")
                return JobResult(job.run_id, "failed", reason)
            except ApiUnavailable as error:
                if time.monotonic() >= deadline:
                    reason = f"could not deliver the run before the deadline ({error})"
                    self._log(f"job {job.run_id}: {reason}; run.json kept at {run_path}")
                    return JobResult(job.run_id, "failed", reason)
                self._log(f"job {job.run_id}: delivery failed ({error}); retrying in {backoff:.0f} s")
                if self.stop.wait(backoff):
                    return JobResult(job.run_id, "failed", "the runner stopped before delivery")
                backoff = min(backoff * 2, self.options.max_backoff_s)
                try:
                    self.api.heartbeat(job.run_id, job.lease_id)
                except LeaseLost:
                    self._log(f"job {job.run_id}: lease lost before delivery; the result was dropped")
                    return JobResult(job.run_id, "abandoned", "lease lost")
                except (ApiUnavailable, ApiRejected):
                    pass
                continue
            self._log(f"job {job.run_id}: complete and published")
            return JobResult(job.run_id, "completed", "published", hash=run_hash)

    # --- helpers ----------------------------------------------------------------------------

    def _unreadable(self, error: JobError) -> JobResult | None:
        if error.run_id is None or error.lease_id is None:
            self._log(f"the API sent a job this runner cannot read: {error}")
            raise ApiUnavailable(f"unreadable job: {error}")
        reason = f"the runner cannot read this job: {error}"
        try:
            status = self.api.fail(error.run_id, error.lease_id, reason, retryable=True)
        except (ApiUnavailable, ApiRejected):
            status = "unknown"
        self._log(f"job {error.run_id}: {reason}; the job is now {status}")
        return JobResult(error.run_id, "failed", reason)

    def _try_fail(self, job: Job, reason: str, *, retryable: bool) -> str:
        try:
            return self.api.fail(job.run_id, job.lease_id, reason, retryable=retryable)
        except LeaseLost:
            return "no longer held by this runner"
        except (ApiUnavailable, ApiRejected) as error:
            self._log(f"job {job.run_id}: could not report the failure ({error})")
            return "unknown (the API will time the job out)"


class _ProgressTracker:
    def __init__(self) -> None:
        self.latest: Progress | None = None
        self._reported: Progress | None = None
        self._lock = threading.Lock()

    def read(self, process: subprocess.Popen[bytes], log_file: object) -> None:
        assert process.stdout is not None
        for raw in process.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except ValueError:
                message = None
            if isinstance(message, dict) and message.get("hyvo") == "progress":
                with self._lock:
                    self.latest = Progress(int(message["round"]), int(message["rounds"]))
            else:
                try:
                    log_file.write(line + "\n")  # type: ignore[attr-defined]
                except (OSError, ValueError):
                    pass

    def changed(self) -> bool:
        with self._lock:
            if self.latest == self._reported:
                return False
            self._reported = self.latest
            return True


def _forget_clone_job(job: Job, folder: Path) -> None:
    """A clone job's folder names a wallet and holds its numbers, and a wallet can ask to have those deleted. The API keeps what the wallet asked for."""
    if job.kind == "clone":
        shutil.rmtree(folder, ignore_errors=True)


def _wire(job: Job) -> dict[str, object]:
    if job.kind == "dryrun":
        spec: dict[str, object] = {"kind": "dryrun", "spec": job.raw_spec}
    elif job.kind == "clone":
        spec = {"kind": "clone", "spec": job.spec.model_dump(mode="json", by_alias=True)}
    else:
        spec = {"spec": job.spec.model_dump(mode="json", by_alias=True, exclude_none=False)}
    return {
        "runId": job.run_id,
        "leaseId": job.lease_id,
        "attempt": job.attempt,
        "heartbeatIntervalS": job.heartbeat_interval_s,
        "timeoutS": job.timeout_s,
        **spec,
    }


def _child_env() -> dict[str, str]:
    env = dict(os.environ)
    env.pop("RUNNER_TOKEN", None)  # the child never talks to the API
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env


def _kill(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.kill()
    try:
        process.wait(timeout=_KILL_WAIT_S)
    except subprocess.TimeoutExpired:  # pragma: no cover (kill is not ignorable)
        pass


def _stop(process: subprocess.Popen[bytes]) -> None:
    """On Ctrl+C the child got the signal too: give it a moment to tear its world down."""
    try:
        process.wait(timeout=_STOP_WAIT_S)
    except subprocess.TimeoutExpired:
        _kill(process)


def _read_result(path: Path) -> dict[str, object] | None:
    try:
        outcome = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(outcome, dict) or not {"path", "hash", "status"} <= outcome.keys():
        return None
    return outcome


def _child_error(log_path: Path) -> str | None:
    """The child's own one-line error, if it wrote one."""
    try:
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        if line.startswith("hyvo-runner-error: "):
            return line.removeprefix("hyvo-runner-error: ").strip()[:500]
    return None
