from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import psutil
import pytest
from eth_utils import to_checksum_address
from web3.types import RPCEndpoint

from hyvo.config import ENGINE_ROOT, Settings
from hyvo.world.anvil import CHAIN_ID, DEFAULT_BASE_DIR, AnvilError, AnvilInstance

pytestmark = pytest.mark.anvil

PROBE = to_checksum_address("0x" + "ab" * 20)


def anvil_alive(pid: int) -> bool:
    try:
        return psutil.Process(pid).name().lower() in {"anvil", "anvil.exe"}
    except psutil.NoSuchProcess:
        return False


def set_balance(node: AnvilInstance, wei: int) -> None:
    node.w3.provider.make_request(RPCEndpoint("anvil_setBalance"), [PROBE, hex(wei)])


def mine(node: AnvilInstance) -> None:
    node.w3.provider.make_request(RPCEndpoint("evm_mine"), [])


def test_start_and_stop_leave_no_process_and_no_dir():
    node = AnvilInstance().start()
    pid, data_dir = node.pid, node.data_dir
    assert data_dir.parent == DEFAULT_BASE_DIR and data_dir.is_dir()
    assert node.log_path.is_file()
    assert node.running and anvil_alive(pid)
    assert node.rpc_url == f"http://127.0.0.1:{node.port}"
    assert node.w3.eth.chain_id == CHAIN_ID
    assert node.fork_block is None and not node.forked
    node.stop()
    assert not node.running
    assert not anvil_alive(pid)
    assert not data_dir.exists()
    node.stop()  # idempotent
    with pytest.raises(AnvilError):
        _ = node.rpc_url
    with pytest.raises(AnvilError, match="starts once"):
        node.start()


def test_gas_is_free_and_any_address_can_send(tmp_path):
    with AnvilInstance(base_dir=tmp_path) as node:
        set_balance(node, 10**18)
        receiver = to_checksum_address("0x" + "cd" * 20)
        tx = node.w3.eth.send_transaction(
            {"from": PROBE, "to": receiver, "value": 7, "gasPrice": 0}
        )
        assert node.w3.eth.wait_for_transaction_receipt(tx)["status"] == 1
        assert node.w3.eth.get_balance(PROBE) == 10**18 - 7
        assert node.w3.eth.gas_price == 0
        assert node.w3.eth.get_block("latest")["baseFeePerGas"] == 0


def test_the_context_manager_stops_on_error(tmp_path):
    with pytest.raises(RuntimeError, match="boom"), AnvilInstance(base_dir=tmp_path) as node:
        pid = node.pid
        raise RuntimeError("boom")
    assert not anvil_alive(pid)
    assert list(tmp_path.iterdir()) == []


def test_two_instances_run_at_once_on_different_ports(tmp_path):
    with AnvilInstance(base_dir=tmp_path) as first, AnvilInstance(base_dir=tmp_path) as second:
        assert first.port != second.port and first.pid != second.pid
        assert first.data_dir != second.data_dir
        set_balance(first, 5)
        assert first.w3.eth.get_balance(PROBE) == 5
        assert second.w3.eth.get_balance(PROBE) == 0
        assert second.w3.eth.chain_id == CHAIN_ID
        pids = (first.pid, second.pid)
    assert not any(anvil_alive(pid) for pid in pids)
    assert list(tmp_path.iterdir()) == []


def test_forks_another_node_at_a_block_number(tmp_path):
    with AnvilInstance(base_dir=tmp_path) as base:
        set_balance(base, 123)
        for _ in range(3):
            mine(base)
        block = base.w3.eth.block_number
        cache = Path.home() / ".foundry" / "cache" / "rpc" / str(CHAIN_ID) / str(block)
        cached_before = cache.exists()
        with AnvilInstance(
            fork_url=base.rpc_url, fork_block_number=block, base_dir=tmp_path
        ) as fork:
            assert fork.forked and fork.fork_block == block
            assert fork.w3.eth.chain_id == CHAIN_ID
            assert fork.w3.eth.get_balance(PROBE) == 123
            set_balance(fork, 1)
            assert base.w3.eth.get_balance(PROBE) == 123  # the fork is a copy
        mine(base)
        settings = Settings(rh_rpc_url=base.rpc_url)
        with AnvilInstance.from_settings(settings, base_dir=tmp_path) as latest:
            assert latest.fork_block == block + 1  # no block number: anvil forks the latest block
    # A loopback node's state is not fixed per block, so it must not enter the Foundry RPC cache.
    assert cached_before or not cache.exists()
    assert list(tmp_path.iterdir()) == []


def test_without_an_rpc_url_the_chain_is_not_forked():
    assert not AnvilInstance.from_settings(Settings()).forked
    assert not AnvilInstance(fork_url="  ").forked
    with pytest.raises(ValueError, match="needs a fork_url"):
        AnvilInstance(fork_block_number=5)


def test_a_failed_fork_cleans_up_and_never_shows_the_url(tmp_path):
    url = "http://127.0.0.1:9/secret-api-key"  # nothing listens on the discard port
    node = AnvilInstance(fork_url=url, base_dir=tmp_path)
    with pytest.raises(AnvilError) as failure:
        node.start()
    assert "secret-api-key" not in str(failure.value)
    assert "<fork-url>" in str(failure.value)
    assert "secret-api-key" not in repr(node)
    assert list(tmp_path.iterdir()) == []


def test_a_missing_binary_fails_cleanly(tmp_path):
    node = AnvilInstance(anvil_path=str(tmp_path / "no-such-anvil"), base_dir=tmp_path / "nodes")
    with pytest.raises(AnvilError, match="cannot run"):
        node.start()
    assert list((tmp_path / "nodes").iterdir()) == []


def test_interpreter_exit_stops_a_forgotten_instance(tmp_path):
    script = (
        "import json\n"
        "from hyvo.world.anvil import AnvilInstance\n"
        f"node = AnvilInstance(base_dir={str(tmp_path)!r}).start()\n"
        "print(json.dumps([node.pid, str(node.data_dir)]))\n"
    )  # exits without stop(): the atexit hook must clean up
    done = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=ENGINE_ROOT,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    pid, data_dir = json.loads(done.stdout.strip().splitlines()[-1])
    assert not anvil_alive(pid)
    assert not Path(data_dir).exists()
