"""Fork mode: with ``RH_RPC_URL`` set, the world forks it (at ``fork_block`` when given) and
run.json records ``world.forkBlock``. The forked chain is another local anvil, so there is no
network; ``fork=False`` (``--no-fork``) overrides the URL."""

from __future__ import annotations

from pathlib import Path
from types import ModuleType

import pytest
from simkit import anvil_pids, check_written_run, events, sim_config, write_scenario

from hyvo.config import Settings
from hyvo.sim import run_simulation
from hyvo.world.anvil import CHAIN_ID, AnvilInstance

pytestmark = [pytest.mark.anvil, pytest.mark.oasis, pytest.mark.slow]


@pytest.fixture(autouse=True)
def _oasis_logs_in_tmp(oasis_module: ModuleType) -> None:
    """Import OASIS through the session fixture, so its log file lands in a temp dir."""


def test_fork_mode_records_the_fork_block(tmp_path: Path) -> None:
    before = anvil_pids()
    with AnvilInstance(base_dir=tmp_path / "parent-anvil") as parent:
        for _ in range(3):
            parent.w3.provider.make_request("evm_mine", [])
        block = parent.w3.eth.block_number
        settings = Settings(rh_rpc_url=parent.rpc_url)
        scenario = write_scenario(tmp_path)

        forked = run_simulation(
            sim_config(scenario, tmp_path / "runs", agents=6, rounds=1, fork=None,
                       fork_block=block - 1, anvil_dir=tmp_path / "anvil"),
            settings,
        )  # fmt: skip
        doc = check_written_run(forked.path, agents=6)
        assert doc["world"]["forkBlock"] == block - 1
        assert doc["world"]["chainId"] == CHAIN_ID
        ready = next(e for e in events(forked.run_dir) if e["event"] == "world_ready")
        assert ready["anvil"]["forked"] is True and ready["anvil"]["forkBlock"] == block - 1
        assert parent.w3.eth.block_number == block  # the run's transactions stayed on the fork

        local = run_simulation(
            sim_config(scenario, tmp_path / "runs", agents=6, rounds=1, fork=False),
            settings,
        )
        assert check_written_run(local.path, agents=6)["world"]["forkBlock"] is None
    assert not (anvil_pids() - before)
    assert not any((tmp_path / "anvil").iterdir())  # the fork's data dir is gone
