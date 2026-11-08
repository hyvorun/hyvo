"""A run with a clone in its crowd: one agent plays a wallet's numbers, and the file holds what it did and nothing about the wallet."""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from types import ModuleType

import pytest
from simkit import check_written_run, offline_settings, sim_config, write_scenario

from hyvo.clone import Trade, build_profile
from hyvo.sim import run_simulation

pytestmark = [pytest.mark.anvil, pytest.mark.oasis, pytest.mark.slow]

WALLET = "0x" + "aB" * 20
TOKEN = "0x" + "a1" * 20
TRADES = [Trade(f"0x{n:x}", 1_790_000_000.0 + n * 600, TOKEN, "buy" if n % 2 else "sell", Decimal(100), Decimal("0.1") if n % 2 else None) for n in range(1, 8)]


@pytest.fixture(autouse=True)
def _oasis_logs_in_tmp(oasis_module: ModuleType) -> None:
    """Import OASIS through the session fixture, so its log file lands in a temp dir."""


def test_a_run_with_a_clone_verifies_and_keeps_the_wallet_out_of_the_file(tmp_path: Path) -> None:
    scenario = write_scenario(tmp_path)
    profile = build_profile(TRADES, {TOKEN: 1_789_999_000.0})
    outcome = run_simulation(sim_config(scenario, tmp_path / "runs", clone=profile), offline_settings())
    doc = check_written_run(outcome.path, agents=12)
    assert doc["crowd"]["personaMix"]["clone"] == 1
    [agent] = [a for a in doc["crowd"]["agents"] if a["persona"] == "clone"]
    assert agent["handle"].startswith("@")
    assert any(action["agentId"] == agent["agentId"] for round_ in doc["rounds"] for action in round_["actions"])
    text = Path(outcome.path).read_text(encoding="utf-8")
    # The run holds what the agent did, and none of the numbers it was made from.
    assert WALLET not in text and WALLET.lower() not in text and TOKEN not in text and "typicalBuyEth" not in text
    assert json.loads(text)["report"]["disclaimer"] == "Synthetic crowd reaction. Not a trading signal."
