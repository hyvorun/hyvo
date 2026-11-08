"""check_run_market against the shared sample run: replay from world.initialMarket, holders and
balances tracked from the agents' start balances (RUN_FORMAT.md)."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from hyvo.world.verify import check_run_market

SAMPLE = Path(__file__).resolve().parents[3] / "packages" / "schema" / "test-vectors" / "sample-run.json"


@pytest.fixture
def sample() -> dict[str, Any]:
    return json.loads(SAMPLE.read_text(encoding="utf-8"))


def test_the_sample_replays_cleanly(sample: dict[str, Any]) -> None:
    assert check_run_market(sample) == []


def test_a_tampered_holders_count_is_caught(sample: dict[str, Any]) -> None:
    sample["rounds"][0]["market"]["holders"] += 1
    assert any("round 1: market.holders" in m for m in check_run_market(sample))


def test_a_tampered_initial_holders_count_is_caught(sample: dict[str, Any]) -> None:
    sample["world"]["initialMarket"]["holders"] = 1
    assert any("world.initialMarket.holders" in m for m in check_run_market(sample))


def test_a_tampered_initial_price_is_caught(sample: dict[str, Any]) -> None:
    sample["world"]["initialMarket"]["price"] = "0.00002"
    assert any("world.initialMarket.price" in m for m in check_run_market(sample))


def test_tampered_initial_reserves_break_round_one(sample: dict[str, Any]) -> None:
    sample["world"]["initialMarket"]["reserve1"] = "11"
    mismatches = check_run_market(sample)
    assert any(m.startswith("round 1:") for m in mismatches)


def test_spending_more_eth_than_the_start_balance_is_caught(sample: dict[str, Any]) -> None:
    sample["crowd"]["agents"][2]["startEth"] = "0.1"  # a03 buys with 0.2 ETH in round 1
    assert any("spends more than the agent holds" in m for m in check_run_market(sample))


def test_selling_unheld_tokens_is_caught(sample: dict[str, Any]) -> None:
    rnd = sample["rounds"][1]
    sell = next(a for a in rnd["actions"] if a["agentId"] == "a03")
    sell["agentId"] = "a02"  # a02 never bought, so it cannot sell
    for action in rnd["actions"]:
        if action is not sell and action["agentId"] == "a02":
            action["agentId"] = "a03"
    assert any("spends more than the agent holds" in m for m in check_run_market(sample))


def test_documents_without_start_data_fall_back_to_reconstruction(sample: dict[str, Any]) -> None:
    legacy = copy.deepcopy(sample)
    del legacy["world"]["initialMarket"]
    for agent in legacy["crowd"]["agents"]:
        del agent["startEth"], agent["startTokens"]
    assert check_run_market(legacy) == []
    legacy["rounds"][0]["market"]["holders"] += 1  # unverifiable without start balances
    assert check_run_market(legacy) == []
