"""Phase 1 definition of done (docs/SPEC.md section 14): ``hyvo run`` with 50 agents x 10 rounds
produces a valid run.json in which agents post and swap and the recorded price matches the swaps.

Run offline (rules model) on a local anvil without a fork, once through ``run_simulation`` and
once through the real ``hyvo`` console script in a subprocess.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from simkit import (
    EXAMPLE_SCENARIO,
    actions,
    anvil_alive,
    anvil_pids,
    check_written_run,
    events,
    offline_settings,
    posts,
)

from hyvo.sim import SimConfig, run_simulation

pytestmark = [pytest.mark.anvil, pytest.mark.oasis, pytest.mark.slow]

AGENTS, ROUNDS = 50, 10


@pytest.fixture(autouse=True)
def _oasis_logs_in_tmp(oasis_module: ModuleType) -> None:
    """Import OASIS through the session fixture, so its log file lands in a temp dir."""


def hyvo_command() -> list[str]:
    script = Path(sys.executable).with_name("hyvo.exe" if os.name == "nt" else "hyvo")
    return [str(script)] if script.is_file() else [sys.executable, "-m", "hyvo.cli"]


def cli_env() -> dict[str, str]:
    """The test's environment without model keys or a fork URL; the console streams use cp1252,
    as on a Windows console with a legacy code page."""
    env = {k: v for k, v in os.environ.items() if k not in ("LLM_API_KEY", "RH_RPC_URL")}
    env.update({"PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0"})
    return env


def run_api(tmp_path: Path) -> tuple[Path, dict[str, Any]]:
    outcome = run_simulation(
        SimConfig(
            scenario=EXAMPLE_SCENARIO,
            agents=AGENTS,
            rounds=ROUNDS,
            offline=True,
            fork=False,
            seed=1,
            runs_dir=tmp_path / "runs",
        ),
        offline_settings(),
    )
    assert outcome.status == "complete" and outcome.stop_reason is None
    assert outcome.mismatches == [] and outcome.rounds == ROUNDS
    return outcome.path, {"hash": outcome.hash, "usage": outcome.usage}


def run_cli(tmp_path: Path) -> tuple[Path, dict[str, Any]]:
    out = tmp_path / "runs-ñ-走"  # non-ASCII path: printed through a cp1252 pipe
    proc = subprocess.run(
        [*hyvo_command(), "run", "--scenario", str(EXAMPLE_SCENARIO), "--agents", str(AGENTS),
         "--rounds", str(ROUNDS), "--offline", "--no-fork", "--seed", "2", "--out", str(out)],
        capture_output=True,
        env=cli_env(),
        timeout=900,
        check=False,
    )  # fmt: skip
    stdout = proc.stdout.decode("utf-8")
    stderr = proc.stderr.decode("utf-8", errors="replace")
    assert proc.returncode == 0, stderr[-3000:]
    assert "Traceback" not in stderr
    fields = dict(re.findall(r"^([a-zA-Z. ]+?):\s+(.+?)\s*$", stdout, re.MULTILINE))
    assert fields["status"] == "complete"
    assert fields["run id"].startswith("run_")
    path = Path(fields["run.json"])
    assert path.parent.parent == out and path.is_file()
    assert re.fullmatch(r"0x[0-9a-f]{64}", fields["hash"])
    assert re.match(r"\d+ \(\d+ input \+ \d+ output tokens\), cost \$0\.000000$", fields["LLM calls"])
    assert "offline rules model" in stdout
    assert stdout.rstrip().endswith("Synthetic crowd reaction. Not a trading signal.")
    assert len(re.findall(r"^  round \d+/10: ", stderr, re.MULTILINE)) == ROUNDS

    verify = subprocess.run(
        [*hyvo_command(), "verify", str(path.parent)],
        capture_output=True,
        env=cli_env(),
        timeout=300,
        check=False,
    )
    verified = verify.stdout.decode("utf-8")
    assert verify.returncode == 0, verified + verify.stderr.decode("utf-8", errors="replace")
    assert "replay:    ok" in verified and "verified." in verified
    return path, {"hash": fields["hash"], "llm_calls": int(fields["LLM calls"].split()[0])}


@pytest.mark.parametrize("via", ["run_simulation", "cli"])
def test_dod_50x10_offline(tmp_path: Path, via: str, record_property: Any) -> None:
    before = anvil_pids()
    started = time.perf_counter()
    path, printed = run_api(tmp_path) if via == "run_simulation" else run_cli(tmp_path)
    runtime = time.perf_counter() - started

    doc = check_written_run(path, agents=AGENTS)  # schema, hash, replay, report, usage
    assert doc["hash"] == printed["hash"]
    assert doc["status"] == "complete" and doc["stopReason"] is None
    assert len(doc["rounds"]) == ROUNDS
    assert doc["crowd"]["size"] == AGENTS
    assert doc["crowd"]["model"] == {
        "agents": "offline/rules-v1",
        "report": "offline/rules-v1",
        "temperature": 0.8,
    }
    assert doc["world"]["forkBlock"] is None and doc["world"]["chainId"] == 4663

    # Agents post in every round and swap; both kinds of swap execute.
    assert all(rnd["posts"] for rnd in doc["rounds"]), "agents post in every round"
    kinds = Counter((action["kind"], action["status"]) for action in actions(doc))
    assert kinds[("swap_buy", "ok")] > 0 and kinds[("swap_sell", "ok")] > 0
    for action in actions(doc):
        if action["status"] in ("ok", "reverted") and action["kind"] in ("swap_buy", "swap_sell"):
            assert re.fullmatch(r"0x[0-9a-f]{64}", action["txHash"])
    assert any(post["replyTo"] for post in posts(doc)), "agents reply"
    assert sum(post["likes"] for post in posts(doc)) > 0, "agents like"

    # The report is filled in.
    report = doc["report"]
    assert report["summary"] and report["priceDrivers"]
    assert report["turningPoint"] is not None
    assert any(value != 0 for value in report["sentimentByRound"])

    # usage: one agents call per batch per round, plus the report.
    usage = doc["usage"]
    assert usage["llmCalls"] >= ROUNDS * (AGENTS // 10) + 1
    assert usage["costUsd"] == 0
    if "llm_calls" in printed:
        assert printed["llm_calls"] == usage["llmCalls"]

    # The world is gone and the run directory can be deleted (nothing holds a file open).
    assert not (anvil_pids() - before), "an anvil process outlived the run"
    log = events(path.parent)
    world = next(e for e in log if e["event"] == "world_ready")
    assert not anvil_alive(world["anvil"]["pid"]), "the run's anvil outlived it"
    if via == "run_simulation":
        assert [e["event"] for e in log][-2:] == ["run_finished", "teardown"]
        assert log[-1]["ok"] is True
    shutil.rmtree(path.parent)

    swaps = Counter(action["kind"] for action in actions(doc) if action["status"] == "ok")
    statuses = Counter(action["status"] for action in actions(doc))
    summary = {
        "via": via,
        "runtime_s": round(runtime, 1),
        "rounds": len(doc["rounds"]),
        "posts": sum(1 for p in posts(doc) if p["replyTo"] is None),
        "replies": sum(1 for p in posts(doc) if p["replyTo"] is not None),
        "likes": sum(p["likes"] for p in posts(doc)),
        "swap_buy_ok": swaps["swap_buy"],
        "swap_sell_ok": swaps["swap_sell"],
        "check_market": swaps["check_market"],
        "reverted": statuses["reverted"],
        "invalid": statuses["invalid"],
        "llm_calls": usage["llmCalls"],
    }
    record_property("dod", summary)
    print(f"\nDoD {summary}")
