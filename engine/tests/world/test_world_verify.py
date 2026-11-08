"""verify.py on synthetic runs; tests/actions/test_actions_smoke.py checks it on a real chain."""

from __future__ import annotations

import copy
from typing import Any

import pytest

from hyvo.world.amm import Reserves, apply_buy, apply_sell
from hyvo.world.units import format_amount, format_price
from hyvo.world.verify import check_run_market, replay_rounds

E18 = 10**18
TOKEN = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
WETH = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
POOL = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"
START = Reserves(token=1_000_000 * E18, quote=100 * E18)
FEE = 30

# (agentId, kind, amount in base units or None, status) per round, in execution order
PLAN: list[list[tuple[str, str, int | None, str]]] = [
    [
        ("a01", "swap_buy", E18, "ok"),
        ("a02", "hold", None, "ok"),
        ("a03", "swap_buy", 3 * E18, "ok"),
    ],
    [
        ("a01", "swap_sell", 4000 * E18, "ok"),
        ("a02", "swap_buy", 2 * E18, "reverted"),
        ("a03", "check_market", None, "ok"),
        ("a04", "hold", None, "invalid"),
    ],
    [("a02", "swap_buy", E18 // 7, "ok"), ("a03", "swap_sell", 12_345 * E18 + 1, "ok")],
]


def _tx(n: int) -> str:
    return "0x" + f"{n:064x}"


def build_run(token_is_token0: bool) -> dict[str, Any]:
    """A run whose markets follow the router formula exactly, as the engine records them."""
    token0, token1 = (TOKEN, WETH) if token_is_token0 else (WETH, TOKEN)
    reserves, rounds, tx = START, [], 0
    for n, plan in enumerate(PLAN, start=1):
        actions = []
        for agent_id, kind, amount, status in plan:
            action = {"agentId": agent_id, "kind": kind, "amountIn": None, "amountOut": None,
                      "txHash": None, "status": status, "note": None}  # fmt: skip
            if kind in ("swap_buy", "swap_sell"):
                tx += 1
                action["txHash"] = _tx(tx)
                buy = kind == "swap_buy"
                action["amountIn"] = format_amount(amount, 18)
                if status == "ok":
                    out, reserves = (apply_buy if buy else apply_sell)(reserves, amount, FEE)
                    action["amountOut"] = format_amount(out, 18)
                else:
                    action["note"] = "reverted: InsufficientOutput(amountOut=1, amountOutMin=2)"
            elif status == "invalid":
                action["note"] = "swap_buy of 9 ETH is above the per-agent cap of 1 ETH"
            actions.append(action)
        reserve0, reserve1 = (
            (reserves.token, reserves.quote)
            if token_is_token0
            else (reserves.quote, reserves.token)
        )
        market = {
            "price": format_price(reserves.quote, reserves.token),
            "reserve0": format_amount(reserve0, 18),
            "reserve1": format_amount(reserve1, 18),
            "holders": 3,
        }
        rounds.append({"n": n, "posts": [], "actions": actions, "market": market})
    pool = {"address": POOL, "token0": token0, "token1": token1, "kind": "v2-test", "feeBps": FEE}
    world = {
        "chainId": 4663,
        "forkBlock": None,
        "pools": [pool],
        "token": {"address": TOKEN, "symbol": "HYVX", "name": "Hyvo Test Token", "decimals": 18},
        "quote": {"address": WETH, "symbol": "WETH", "decimals": 18},
    }
    return {"world": world, "rounds": rounds}


@pytest.fixture(params=[True, False], ids=["token0", "token1"])
def run(request) -> dict[str, Any]:
    return build_run(request.param)


def test_accepts_a_correct_sequence(run):
    assert check_run_market(run) == []
    assert check_run_market(run, initial_reserves=START) == []


def test_replay_rounds_recomputes_the_reserves_of_every_round(run):
    replays = replay_rounds(START, run["rounds"], fee_bps=FEE)
    assert [replay.n for replay in replays] == [1, 2, 3]
    assert all(replay.mismatches == () for replay in replays)
    final = replays[-1].reserves
    assert format_price(final.quote, final.token) == run["rounds"][-1]["market"]["price"]


def test_rejects_a_tampered_price(run):
    replayed = run["rounds"][1]["market"]["price"]
    run["rounds"][1]["market"]["price"] = "0.0002"
    assert check_run_market(run) == [f"round 2: market.price is '0.0002', replayed {replayed!r}"]


def test_rejects_a_tampered_reserve(run):
    run["rounds"][2]["market"]["reserve1"] += "1"  # still a valid Decimal string
    mismatches = check_run_market(run, initial_reserves=START)
    assert len(mismatches) == 1
    assert mismatches[0].startswith("round 3: market.reserve1 is ")


def test_rejects_a_tampered_swap_output(run):
    action = run["rounds"][1]["actions"][0]
    action["amountOut"] = "1"
    mismatches = check_run_market(run, initial_reserves=START)
    assert mismatches == [
        f"round 2 actions[0] (a01): amountOut is '1', replayed {_replayed_out(1, 0)!r}"
    ]


def test_rejects_a_tampered_swap_input(run):
    run["rounds"][2]["actions"][0]["amountIn"] = "0.2"
    mismatches = check_run_market(run, initial_reserves=START)
    assert any(m.startswith("round 3 actions[0] (a02): amountOut") for m in mismatches)
    assert any(m.startswith("round 3: market.reserve") for m in mismatches)


def test_detects_a_tampered_first_round_without_the_initial_reserves(run):
    market = run["rounds"][0]["market"]
    tampered = build_run(True)["rounds"][1]["market"]  # a plausible but wrong market
    market.update(
        price=tampered["price"], reserve0=tampered["reserve0"], reserve1=tampered["reserve1"]
    )
    assert check_run_market(run) != []


def test_swaps_must_be_listed_in_execution_order(run):
    actions = run["rounds"][0]["actions"]
    actions[0], actions[2] = actions[2], actions[0]
    assert check_run_market(run, initial_reserves=START) != []


def test_ignores_reverted_invalid_hold_and_check_market_actions(run):
    reverted = run["rounds"][1]["actions"][1]
    assert reverted["status"] == "reverted"
    reverted["amountOut"] = "999"  # never applied
    assert check_run_market(run) == []


def test_reports_unreadable_amounts_and_malformed_runs(run):
    broken = copy.deepcopy(run)
    broken["rounds"][2]["actions"][0]["amountIn"] = "1e18"
    assert any("unreadable amounts" in m for m in check_run_market(broken, initial_reserves=START))
    assert check_run_market({"rounds": []}) == [
        "the run has no readable world and rounds: KeyError('world')"
    ]
    run["world"]["quote"]["address"] = POOL
    assert check_run_market(run) == ["world.pools[0] must pair world.token with world.quote"]
    assert check_run_market({"world": build_run(True)["world"], "rounds": []}) == []


def _replayed_out(round_index: int, action_index: int) -> str:
    """The formula output of one PLAN swap, recomputed independently of build_run."""
    reserves = START
    for r, plan in enumerate(PLAN):
        for a, (_, kind, amount, status) in enumerate(plan):
            if status != "ok" or kind not in ("swap_buy", "swap_sell"):
                continue
            out, reserves = (apply_buy if kind == "swap_buy" else apply_sell)(reserves, amount, FEE)
            if (r, a) == (round_index, action_index):
                return format_amount(out, 18)
    raise AssertionError("no such swap")
