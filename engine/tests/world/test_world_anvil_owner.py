"""anvil dies with its owner even on a hard kill; stale instances are swept; fork fallback and
start retries."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import psutil
import pytest

from hyvo.config import ENGINE_ROOT, Settings
from hyvo.world import anvil as anvil_module
from hyvo.world.anvil import AnvilError, AnvilInstance, sweep_stale


def _is_anvil(pid: int) -> bool:
    try:
        name = psutil.Process(pid).name().lower()
    except psutil.Error:
        return False
    return name == "anvil" or name.startswith("anvil.")


def _wait_gone(pid: int, seconds: float = 15.0) -> bool:
    deadline = time.monotonic() + seconds
    while _is_anvil(pid) and time.monotonic() < deadline:
        time.sleep(0.1)
    return not _is_anvil(pid)


def _dead_pid() -> int:
    pid = 99_999_996
    while psutil.pid_exists(pid):
        pid -= 4
    return pid


@pytest.mark.anvil
def test_a_hard_killed_owner_takes_its_anvil_down(tmp_path: Path) -> None:
    script = (
        "import json, time\n"
        "from hyvo.world.anvil import AnvilInstance\n"
        f"node = AnvilInstance(base_dir={str(tmp_path)!r}).start()\n"
        "print(json.dumps([node.pid, str(node.data_dir)]), flush=True)\n"
        "time.sleep(600)\n"
    )
    owner = subprocess.Popen(
        [sys.executable, "-c", script], stdout=subprocess.PIPE, text=True, cwd=ENGINE_ROOT
    )
    anvil_pid = None
    try:
        anvil_pid, data_dir = json.loads(owner.stdout.readline())
        assert _is_anvil(anvil_pid)
        psutil.Process(owner.pid).kill()  # no finally, no atexit: like Task Manager or an OOM
        owner.wait(timeout=30)
        assert _wait_gone(anvil_pid), "anvil outlived its hard-killed owner"
    finally:
        if owner.poll() is None:
            owner.kill()
        if anvil_pid is not None and _is_anvil(anvil_pid):
            psutil.Process(anvil_pid).kill()
    # The owner could not delete its data dir; the next sweep does.
    assert Path(data_dir).is_dir()
    assert sweep_stale(tmp_path) == [Path(data_dir)]
    assert not Path(data_dir).exists()


@pytest.mark.anvil
def test_the_sweep_kills_orphans_of_dead_owners_and_keeps_live_dirs(tmp_path: Path) -> None:
    stale = tmp_path / f"{_dead_pid()}-0123456789"
    stale.mkdir()
    orphan = subprocess.Popen(  # an anvil started outside any job, as before this fix
        ["anvil", "--port", "0", "--cache-path", str(stale / "state")],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        time.sleep(0.5)
        assert sweep_stale(tmp_path) == [stale] and not stale.exists()
        assert _wait_gone(orphan.pid)
        with AnvilInstance(base_dir=tmp_path) as live:
            assert sweep_stale(tmp_path) == []  # its owner (this process) is alive
            assert live.data_dir.is_dir() and live.running
    finally:
        if orphan.poll() is None:
            orphan.kill()


@pytest.mark.anvil
def test_the_first_start_in_a_process_sweeps_its_base_dir(tmp_path: Path) -> None:
    stale = tmp_path / f"{_dead_pid()}-abcdef0123"
    stale.mkdir()
    with AnvilInstance(base_dir=tmp_path):
        assert not stale.exists()


def test_a_fallback_fork_url_becomes_a_second_fork_url() -> None:
    node = AnvilInstance("http://rpc.example/a", fallback_fork_url="http://rpc.example/b")
    command = node._command("anvil", 1234)
    first = command.index("--fork-url")
    assert command[first : first + 4] == [
        "--fork-url", "http://rpc.example/a", "--fork-url", "http://rpc.example/b",
    ]  # fmt: skip
    with pytest.raises(ValueError, match="needs a fork_url"):
        AnvilInstance(fallback_fork_url="http://rpc.example/b")


def test_from_settings_passes_the_fallback_only_with_a_fork() -> None:
    forked = AnvilInstance.from_settings(
        Settings(rh_rpc_url="http://rpc.example/a", rh_rpc_url_fallback="http://rpc.example/b")
    )
    assert forked._fallback_fork_url == "http://rpc.example/b"
    plain = AnvilInstance.from_settings(Settings(rh_rpc_url_fallback="http://rpc.example/b"))
    assert not plain.forked and plain._fallback_fork_url is None


@pytest.mark.anvil
def test_a_forked_start_is_retried(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(anvil_module, "_RETRY_BACKOFF_S", 0.0)
    with AnvilInstance(base_dir=tmp_path) as source:
        forked = AnvilInstance(fork_url=source.rpc_url, base_dir=tmp_path)
        real = forked._launch_on_free_port
        failures = iter([AnvilError("Unknown state (flaky fork RPC)")] * 2)

        def flaky(binary: str) -> None:
            error = next(failures, None)
            if error is not None:
                raise error
            real(binary)

        monkeypatch.setattr(forked, "_launch_on_free_port", flaky)
        with forked:
            assert forked.running and forked.fork_block is not None


@pytest.mark.anvil
def test_a_plain_start_is_not_retried(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    node = AnvilInstance(base_dir=tmp_path)
    calls = []

    def broken(binary: str) -> None:
        calls.append(binary)
        raise AnvilError("broken binary")

    monkeypatch.setattr(node, "_launch_on_free_port", broken)
    with pytest.raises(AnvilError, match="broken binary"):
        node.start()
    assert len(calls) == 1 and not node.data_dir.exists()
