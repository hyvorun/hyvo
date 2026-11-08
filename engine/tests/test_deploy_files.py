"""The runner's deploy files agree with the code. Nothing here needs Docker: no image is built."""

from __future__ import annotations

import os
import re
import shlex
import signal
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest
import yaml
from typer.testing import CliRunner

from hyvo import cli
from hyvo.cli import app
from hyvo.daily import HEALTH_FILENAME

REPO = Path(__file__).resolve().parents[2]
DEPLOY = REPO / "deploy" / "runner"
DOCKERFILE = (DEPLOY / "Dockerfile").read_text(encoding="utf-8")
ENGINE_SERVICES = ("daily", "runner")


def services() -> dict[str, dict]:
    return yaml.safe_load((DEPLOY / "compose.yaml").read_text(encoding="utf-8"))["services"]


def left_out_of_the_image() -> list[str]:
    return re.findall(r"--no-install-package (\S+)", DOCKERFILE)


def test_every_service_restarts_rotates_its_logs_and_checks_its_health() -> None:
    assert set(services()) == set(ENGINE_SERVICES)
    for service in services().values():
        assert service["restart"] == "unless-stopped" and service["init"] is True
        assert service["logging"]["options"]["max-size"] and int(service["logging"]["options"]["max-file"]) > 1
        check = service["healthcheck"]
        assert check["test"][0] == "CMD-SHELL" and "python -m hyvo health" in check["test"][1]
        assert "kill 1" in check["test"][1], "Docker only reports an unhealthy container; something has to end it"
        assert "start_period" not in check, "the check could run before the loop wrote its first health file"


def test_the_health_checks_read_the_files_the_loops_write() -> None:
    runs_dir = re.search(r"HYVO_RUNS_DIR=(\S+)", DOCKERFILE)[1]
    daily = services()["daily"]["healthcheck"]["test"][1]
    assert f"{runs_dir}/daily/{HEALTH_FILENAME} " in daily
    command = services()["runner"]["command"]
    work_dir = command[command.index("--work-dir") + 1]
    assert f"{work_dir}/runner.health " in services()["runner"]["healthcheck"]["test"][1]


@pytest.mark.parametrize("name", ENGINE_SERVICES)
def test_the_commands_exist(name: str) -> None:
    command = services()[name]["command"]
    assert command[:3] == ["python", "-m", "hyvo"]
    subcommand, *options = command[3:]
    result = CliRunner().invoke(app, [subcommand, "--help"], env={"COLUMNS": "200", "NO_COLOR": "1", "TERMINAL_WIDTH": "200"})
    assert result.exit_code == 0
    for option in options:
        if option.startswith("--"):
            assert option in result.output


def test_no_secret_is_in_the_deploy_files() -> None:
    for service in services().values():
        assert service["env_file"] == ".env" and "environment" not in service
    ignored = subprocess.run(["git", "check-ignore", "-q", "deploy/runner/.env"], cwd=REPO, check=False)
    assert ignored.returncode == 0, "deploy/runner/.env must stay out of git"
    ignore = (REPO / ".dockerignore").read_text(encoding="utf-8").splitlines()
    assert ignore[1] == "*", "the build context lets in only what the image copies"


def test_the_image_gets_what_a_run_reads_and_the_context_lets_it_through() -> None:
    allowed = {line[1:] for line in (REPO / ".dockerignore").read_text(encoding="utf-8").splitlines() if line.startswith("!")}
    copied = []
    for line in re.findall(r"^COPY --chown=\S+ (.+)$", DOCKERFILE, re.MULTILINE):
        copied += shlex.split(line)[:-1]
    assert set(copied) == allowed
    for path in copied:
        assert (REPO / path).exists(), path
    assert {"engine/hyvo", "engine/examples", "chain/artifacts"} <= set(copied)


def test_what_the_image_leaves_out_is_in_the_lock() -> None:
    lock = {package["name"] for package in tomllib.loads((REPO / "engine" / "uv.lock").read_text(encoding="utf-8"))["package"]}
    names = left_out_of_the_image()
    assert "torch" in names
    assert set(names) <= lock
    # Every GPU library torch brings in on Linux, or the image grows by gigabytes without a word.
    assert {name for name in lock if name.startswith("nvidia-")} <= set(names)


CHECK = """
import sys, tempfile, pathlib
BLOCKED = set(sys.argv[1].split(","))
class Block:
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in BLOCKED:
            raise ImportError(f"not in the image: {name}")
sys.meta_path.insert(0, Block())
out = tempfile.mkdtemp()
sys.argv = ["hyvo", "run", "--scenario", sys.argv[2], "--agents", "6", "--rounds", "9", "--offline", "--no-fork", "--seed", "3", "--out", out, "--quiet"]
from hyvo.cli import app
try:
    app(standalone_mode=False)
except SystemExit as stop:
    assert not stop.code, stop.code
assert list(pathlib.Path(out).glob("*/run.json"))
print("played")
"""


@pytest.mark.anvil
@pytest.mark.slow
def test_a_run_needs_nothing_the_image_leaves_out(tmp_path: Path) -> None:
    modules = {name.split("-")[0] if name.startswith("nvidia-") else name.replace("-", "_") for name in left_out_of_the_image()}
    scenario = REPO / "engine" / "examples" / "scenarios" / "pons-creator-tax.md"
    done = subprocess.run(
        [sys.executable, "-c", CHECK, ",".join(sorted(modules)), str(scenario)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env={**os.environ, "HYVO_NO_DOTENV": "1", "PYTHONUTF8": "1"},
        cwd=tmp_path,
        timeout=240,
        check=False,
    )
    assert done.returncode == 0 and "played" in done.stdout, done.stderr[-2000:]


def test_a_stop_signal_stops_a_loop_the_way_ctrl_c_does() -> None:
    before = signal.getsignal(signal.SIGTERM)
    try:
        cli._stop_on_sigterm()
        assert signal.getsignal(signal.SIGTERM) is signal.default_int_handler
    finally:
        signal.signal(signal.SIGTERM, before)
