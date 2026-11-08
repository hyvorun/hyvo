"""The ``hyvo`` CLI: exit codes, short error messages, ``verify`` on good and tampered runs, and
output that survives a cp1252 console."""

from __future__ import annotations

import io
import json
import re
import shutil
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from simkit import anvil_pids, check_written_run, write_scenario
from typer.testing import CliRunner

from hyvo import cli
from hyvo.config import Settings
from hyvo.runfile import hash_run
from hyvo.sim.config import SimulationError

VECTORS = Path(__file__).resolve().parents[3] / "packages" / "schema" / "test-vectors"
SAMPLE_RUN = VECTORS / "sample-run.json"
runner = CliRunner()


@pytest.fixture(autouse=True)
def _offline_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """The CLI reads settings from the environment and .env; tests run without keys or RPC."""
    monkeypatch.setattr("hyvo.config.load_settings", lambda *args, **kwargs: Settings())


def invoke(*args: str) -> Any:
    return runner.invoke(cli.app, list(args))


def sample_run(tmp_path: Path, change=None, *, rehash: bool = True) -> Path:
    if not SAMPLE_RUN.is_file():
        pytest.skip(f"{SAMPLE_RUN} is produced by packages/schema")
    doc = json.loads(SAMPLE_RUN.read_text(encoding="utf-8"))
    if change is not None:
        change(doc)
        if rehash:
            doc["hash"] = hash_run(doc)
    path = tmp_path / "run.json"
    path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    return path


# --- hyvo verify --------------------------------------------------------------------------------


def test_verify_accepts_a_valid_run_file_or_directory(tmp_path: Path) -> None:
    path = sample_run(tmp_path)
    for target in (path, path.parent):
        result = invoke("verify", str(target))
        assert result.exit_code == 0, result.output
        assert "hash:      ok 0x" in result.output
        assert re.search(r"^replay:\s+ok \(\d+ swaps in 2 rounds\)$", result.output, re.MULTILINE)
        assert "verified. Synthetic crowd reaction. Not a trading signal." in result.output


def test_verify_fails_on_a_wrong_hash(tmp_path: Path) -> None:
    path = sample_run(tmp_path, lambda doc: doc.update(hash="0x" + "0" * 64), rehash=False)
    result = invoke("verify", str(path))
    assert result.exit_code == 1
    assert "hash:      FAILED: recorded 0x000" in result.output
    assert "NOT verified" in result.output


def test_verify_fails_when_the_recorded_price_does_not_match_the_swaps(tmp_path: Path) -> None:
    def move_price(doc: dict[str, Any]) -> None:
        doc["rounds"][-1]["market"]["price"] = "0.123"

    path = sample_run(tmp_path, move_price)  # re-hashed, so only the replay can catch it
    result = invoke("verify", str(path))
    assert result.exit_code == 1
    assert "hash:      ok" in result.output
    assert re.search(r"^replay:\s+FAILED \(1 problem\)$", result.output, re.MULTILINE)
    assert "market.price is '0.123'" in result.output


def test_verify_fails_on_a_schema_violation(tmp_path: Path) -> None:
    def change_disclaimer(doc: dict[str, Any]) -> None:
        doc["report"]["disclaimer"] = "Not financial advice."

    result = invoke("verify", str(sample_run(tmp_path, change_disclaimer)))
    assert result.exit_code == 1
    assert re.search(r"^schema:\s+FAILED", result.output, re.MULTILINE)
    assert re.search(r"^rules:\s+FAILED", result.output, re.MULTILINE)
    assert "/report/disclaimer" in result.output


def test_verify_fails_on_a_cross_field_rule(tmp_path: Path) -> None:
    def drop_a_hold(doc: dict[str, Any]) -> None:
        actions = doc["rounds"][0]["actions"]
        actions.remove(next(a for a in actions if a["kind"] != "swap_buy" and a["kind"] != "swap_sell"))

    result = invoke("verify", str(sample_run(tmp_path, drop_a_hold)))
    assert result.exit_code == 1
    assert re.search(r"^schema:\s+ok$", result.output, re.MULTILINE)  # per-field rules only
    assert re.search(r"^rules:\s+FAILED", result.output, re.MULTILINE)
    assert "has no action for" in result.output
    assert re.search(r"^replay:\s+ok", result.output, re.MULTILINE)


@pytest.mark.parametrize(
    ("content", "message"),
    [(b"not json", "read:      FAILED"), (b'{"a": 1, "a": 2}', "duplicate JSON member")],
)
def test_verify_fails_on_unreadable_files(tmp_path: Path, content: bytes, message: str) -> None:
    path = tmp_path / "run.json"
    path.write_bytes(content)
    result = invoke("verify", str(path))
    assert result.exit_code == 1 and message in result.output
    assert "Traceback" not in result.output


def test_verify_a_missing_file(tmp_path: Path) -> None:
    result = invoke("verify", str(tmp_path / "nope.json"))
    assert result.exit_code == 1 and "read:      FAILED" in result.output


# --- hyvo run: input errors -----------------------------------------------------------------------


def test_no_arguments_shows_help() -> None:
    result = invoke()
    assert result.exit_code in (0, 2) and "run" in result.output and "verify" in result.output


@pytest.mark.parametrize(
    ("extra", "message"),
    [
        (["--mix", "sniper=3"], "persona mix sums to 3, but the crowd size is 12"),
        (["--mix", "wizard=12"], "unknown persona 'wizard'"),
        (["--no-fork", "--fork-block", "5"], "fork_block needs a fork"),
        (["--fork"], "RH_RPC_URL is not set"),
        (["--rounds", "1"], "fall after the last round (1)"),
        (["--timeout-min", "0"], "timeout_s must be a finite number > 0"),
    ],
)
def test_run_rejects_bad_input_with_a_short_message(tmp_path: Path, extra, message) -> None:
    scenario = write_scenario(tmp_path, {2: "Rumor: a large wallet left."})
    result = invoke("run", "--scenario", str(scenario), "--agents", "12", "--offline",
                    "--out", str(tmp_path / "runs"), *extra)  # fmt: skip
    assert result.exit_code == 2, result.output
    assert f"error: {message}" in result.output or message in result.output
    assert "Traceback" not in result.output
    assert not (tmp_path / "runs").exists()


def test_run_reports_a_missing_scenario(tmp_path: Path) -> None:
    result = invoke("run", "--scenario", str(tmp_path / "missing.md"))
    assert result.exit_code == 2
    assert "error: scenario file not found" in result.output


def test_run_rejects_out_of_range_options(tmp_path: Path) -> None:
    result = invoke("run", "--scenario", str(write_scenario(tmp_path)), "--agents", "0")
    assert result.exit_code == 2 and "--agents" in result.output


def test_a_failing_run_exits_1_without_a_traceback(tmp_path: Path, monkeypatch) -> None:
    def explode(*args: Any, **kwargs: Any) -> Any:
        raise SimulationError("round 3: the pool holds something else\nsecond line")

    monkeypatch.setattr("hyvo.sim.loop.run_simulation", explode)
    args = ["run", "--scenario", str(write_scenario(tmp_path)), "--offline", "--no-fork"]
    result = invoke(*args)
    assert result.exit_code == 1
    assert "error: round 3: the pool holds something else" in result.output
    assert "Traceback" not in result.output
    debug = invoke(*args, "--debug")
    assert debug.exit_code == 1 and "Traceback" in debug.output


def test_without_a_key_the_run_says_it_is_offline(tmp_path: Path, monkeypatch) -> None:
    seen: dict[str, Any] = {}

    def capture(config: Any, settings: Any, **kwargs: Any) -> Any:
        seen["config"] = config
        raise SimulationError("stop here")

    monkeypatch.setattr("hyvo.sim.loop.run_simulation", capture)
    result = invoke("run", "--scenario", str(write_scenario(tmp_path)), "--no-fork", "--seed", "4",
                    "--max-cost-usd", "0.2", "--max-llm-calls", "9", "--timeout-min", "2")  # fmt: skip
    assert "LLM_API_KEY is not set" in result.output and "offline rules model" in result.output
    config = seen["config"]
    assert (config.offline, config.fork, config.seed) == (False, False, 4)
    assert (config.max_cost_usd, config.max_llm_calls, config.timeout_s) == (0.2, 9, 120.0)
    assert config.scenario.title.startswith("Fictional token FERN")


# --- hyvo run: a real (small) run -------------------------------------------------------------


@pytest.mark.anvil
@pytest.mark.oasis
@pytest.mark.slow
def test_a_partial_run_exits_0_and_prints_its_stop_reason(
    tmp_path: Path, oasis_module: ModuleType
) -> None:
    before = anvil_pids()
    out = tmp_path / "runs"
    result = invoke("run", "--scenario", str(write_scenario(tmp_path)), "--agents", "12",
                    "--rounds", "3", "--batch-size", "4", "--max-llm-calls", "6", "--offline",
                    "--no-fork", "--seed", "3", "--out", str(out), "--quiet")  # fmt: skip
    assert result.exit_code == 0, result.output
    fields = dict(re.findall(r"^([a-zA-Z. ]+?):\s+(.+?)\s*$", result.stdout, re.MULTILINE))
    assert fields["status"] == "partial (max_llm_calls)"
    path = Path(fields["run.json"])
    doc = check_written_run(path, agents=12)
    assert fields["hash"] == doc["hash"]
    assert fields["LLM calls"].startswith(f"{doc['usage']['llmCalls']} (")
    assert "round 1/3" not in result.output  # --quiet
    assert not (anvil_pids() - before)
    shutil.rmtree(out)


# --- console safety -----------------------------------------------------------------------------


class _Console(io.TextIOWrapper):
    def isatty(self) -> bool:
        return True


def test_safe_streams_switch_a_cp1252_pipe_to_utf8(monkeypatch: pytest.MonkeyPatch) -> None:
    pipe = io.TextIOWrapper(io.BytesIO(), encoding="cp1252", newline="\n")
    console = _Console(io.BytesIO(), encoding="cp1252", newline="\n")
    monkeypatch.setattr(sys, "stdout", pipe)
    monkeypatch.setattr(sys, "stderr", console)
    cli._safe_streams()
    print("runs-ñ-走 ✓")
    print("走", file=sys.stderr)
    pipe.flush()
    console.flush()
    assert pipe.buffer.getvalue().decode("utf-8") == "runs-ñ-走 ✓\n"  # type: ignore[attr-defined]
    assert console.buffer.getvalue() == b"?\n"  # type: ignore[attr-defined]


def test_safe_streams_leave_utf8_streams_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    stream = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", errors="strict")
    monkeypatch.setattr(sys, "stdout", stream)
    cli._safe_streams()
    assert (stream.encoding, stream.errors) == ("utf-8", "strict")
