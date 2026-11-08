"""Plays one runner job in its own process.

``python -m hyvo.runner.child JOB_JSON RESULT_JSON --runs-dir DIR --timeout-s S [--offline]
[--fork | --no-fork]``

The supervisor (``hyvo.runner.supervisor``) starts one of these per job, reads progress from its
stdout and kills it at the job's hard deadline; anvil is bound to this process and dies with it.

- JOB_JSON is the ``job`` object exactly as ``GET /internal/jobs/next`` returned it.
- stdout gets one JSON line per round: ``{"hyvo": "progress", "round": n, "rounds": m}``. Other
  output (engine logs) goes to stderr.
- RESULT_JSON is written once run.json is written and verified:
  ``{"runId", "status", "stopReason", "hash", "path", "usage"}``.

Exit codes: 0 when the run was written (complete or partial), 2 when the job itself is invalid
(it would fail again anywhere), 3 when this runner is misconfigured (settings, prices), 1 when
the run failed.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Any

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_BAD_JOB = 2
EXIT_RUNNER_CONFIG = 3

_ROUND_RE = re.compile(r"^round (\d+)/(\d+):")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m hyvo.runner.child")
    parser.add_argument("job", type=Path)
    parser.add_argument("result", type=Path)
    parser.add_argument("--runs-dir", type=Path, required=True)
    parser.add_argument("--timeout-s", type=float, required=True)
    parser.add_argument("--offline", action="store_true")
    fork = parser.add_mutually_exclusive_group()
    fork.add_argument("--fork", dest="fork", action="store_true", default=None)
    fork.add_argument("--no-fork", dest="fork", action="store_false")
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s", stream=sys.stderr
    )

    from hyvo.config import ConfigError, load_settings
    from hyvo.llm.pricing import PricingUnknown
    from hyvo.personas import PersonaMixError
    from hyvo.scenarios import ScenarioError
    from hyvo.sim.config import SimConfigError

    from .models import JobError, parse_job

    try:
        job = parse_job(json.loads(args.job.read_text(encoding="utf-8")))
        if job.kind == "dryrun":
            return _play_dry_run(job, args)
        if job.kind == "clone":
            return _build_clone(job, args)
        config = job.spec.to_sim_config(
            run_id=job.run_id,
            runs_dir=args.runs_dir,
            offline=args.offline,
            timeout_s=args.timeout_s,
            fork=args.fork,
        )
    except (JobError, ScenarioError, PersonaMixError, SimConfigError, ValueError) as error:
        return _error(EXIT_BAD_JOB, f"invalid job: {error}")
    try:
        settings = load_settings()
    except ConfigError as error:
        return _error(EXIT_RUNNER_CONFIG, f"runner settings: {error}")

    if job.spec.rewind is not None:
        planned = _plan_rewind(job, config, settings)
        if isinstance(planned, int):
            return planned
        config = planned

    from hyvo.sim.loop import run_simulation

    try:
        outcome = run_simulation(config, settings, progress=_progress)
    except (ConfigError, PricingUnknown) as error:
        return _error(EXIT_RUNNER_CONFIG, f"runner settings: {error}")
    except (ScenarioError, PersonaMixError, SimConfigError) as error:
        return _error(EXIT_BAD_JOB, f"invalid job: {error}")
    except Exception as error:  # any other failure is a failed run
        logging.getLogger("hyvo.runner").exception("run failed")
        return _error(EXIT_FAILED, f"run failed: {type(error).__name__}: {error}")

    _write_json(
        args.result,
        {
            "runId": outcome.run_id,
            "status": outcome.status,
            "stopReason": outcome.stop_reason,
            "hash": outcome.hash,
            "path": str(outcome.path),
            "usage": outcome.usage,
        },
    )
    return EXIT_OK


def _plan_rewind(job: Any, config: Any, settings: Any) -> Any:
    """The run's config with the pool's past in it, or an exit code. A rewind cannot be played without a chain to fork."""
    from dataclasses import replace

    from hyvo.rewind import Chain, ChainUnreachable, RewindError, RewindRequest, plan_rewind

    if not settings.rh_rpc_url or config.fork is False:
        return _error(EXIT_BAD_JOB, "invalid job: a rewind needs a fork, and this runner has none")
    rewind = job.spec.rewind
    try:
        plan = plan_rewind(RewindRequest(rewind.pool, rewind.block, float(rewind.hours)), config.scenario, config.rounds, Chain(settings.rh_rpc_url))
    except RewindError as error:
        return _error(EXIT_BAD_JOB, f"invalid job: {error}")
    except ChainUnreachable as error:
        return _error(EXIT_FAILED, f"the rewind could not read the chain: {error}")
    return replace(config, scenario=plan.scenario, fork=True, fork_block=plan.block, rewind=plan.section)


def _build_clone(job: Any, args: argparse.Namespace) -> int:
    from hyvo.clone import BlockscoutSource, HistoryError, NotEnoughHistory, build_profile, tokens_to_date
    from hyvo.clone.history import DEFAULT_API
    from hyvo.config import ConfigError, load_settings

    try:
        settings = load_settings()
    except ConfigError as error:
        return _error(EXIT_RUNNER_CONFIG, f"runner settings: {error}")
    if not settings.blockscout_api_key:
        return _error(EXIT_BAD_JOB, "this runner has no BLOCKSCOUT_API_KEY, so it cannot read a wallet's history")
    source = BlockscoutSource(settings.blockscout_api_key, settings.blockscout_api_url or DEFAULT_API)
    try:
        trades = source.trades(job.spec.address)
        created = {token: source.token_created_at(token) for token in tokens_to_date(trades)}
        profile = build_profile(trades, created)
    except NotEnoughHistory as error:
        return _error(EXIT_BAD_JOB, str(error))
    except HistoryError as error:
        return _error(EXIT_FAILED, f"the wallet's history could not be read: {error}")
    path = args.runs_dir / job.run_id / "clone.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"profile": profile.to_dict()}), encoding="utf-8")
    _write_json(args.result, {"runId": job.run_id, "status": "complete", "stopReason": None, "hash": "none", "path": str(path), "usage": {}})
    return EXIT_OK


def _play_dry_run(job: Any, args: argparse.Namespace) -> int:
    from hyvo.config import ConfigError, load_settings
    from hyvo.dryrun.play import play_dry_run
    from hyvo.dryrun.spec import DryRunError
    from hyvo.llm.pricing import PricingUnknown

    try:
        settings = load_settings()
    except ConfigError as error:
        return _error(EXIT_RUNNER_CONFIG, f"runner settings: {error}")
    try:
        outcome = play_dry_run(
            job.spec, settings, runs_dir=args.runs_dir, run_id=job.run_id, offline=args.offline, timeout_s=args.timeout_s, progress=_progress
        )
    except DryRunError as error:
        return _error(EXIT_BAD_JOB, f"invalid job: {error}")
    except (ConfigError, PricingUnknown) as error:
        return _error(EXIT_RUNNER_CONFIG, f"runner settings: {error}")
    except Exception as error:  # any other failure is a failed run
        logging.getLogger("hyvo.runner").exception("the Dry Run failed")
        return _error(EXIT_FAILED, f"the Dry Run failed: {type(error).__name__}: {error}")
    _write_json(
        args.result,
        {
            "runId": outcome.run_id,
            "status": outcome.status,
            "stopReason": outcome.stop_reason,
            "hash": outcome.hash,
            "path": str(outcome.path),
            "usage": outcome.usage,
        },
    )
    return EXIT_OK


def _progress(line: str) -> None:
    match = _ROUND_RE.match(line)
    if match:
        message = {"hyvo": "progress", "round": int(match[1]), "rounds": int(match[2])}
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def _error(code: int, message: str) -> int:
    sys.stderr.write(f"hyvo-runner-error: {message}\n")
    sys.stderr.flush()
    return code


def _write_json(path: Path, value: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value), encoding="utf-8")
    os.replace(temporary, path)


if __name__ == "__main__":
    sys.exit(main())
