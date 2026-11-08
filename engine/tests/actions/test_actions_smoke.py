"""50 agents x 3 rounds of random market actions on a real chain, then replayed by verify.py."""

from __future__ import annotations

import random
from collections import Counter
from decimal import Decimal
from typing import Any

import pytest

from hyvo.actions.execute import execute
from hyvo.actions.models import ActionLimits, ActionRecord, parse_market_action
from hyvo.runfile.models import Action, World
from hyvo.runfile.models import Market as RunMarket
from hyvo.world.verify import check_run_market

pytestmark = pytest.mark.anvil

AGENTS = 50
ROUNDS = 3
START_ETH = 2 * 10**18


def random_action(rng: random.Random) -> Any:
    """Raw model output: mostly valid actions, some above the cap, some malformed."""
    roll = rng.random()
    if roll < 0.40:
        return {
            "kind": "swap_buy",
            "amount_eth": round(rng.uniform(0.0001, 0.3), rng.choice([2, 4, 6])),
        }
    if roll < 0.45:
        return {"kind": "swap_buy", "amount_eth": round(rng.uniform(1.01, 1.5), 2)}  # above the cap
    if roll < 0.65:
        return {"kind": "swap_sell", "fraction": rng.choice([0.1, 0.25, 0.5, 1, "0.333"])}
    if roll < 0.80:
        return {"kind": "hold"}
    if roll < 0.90:
        return {"kind": "check_market"}
    return rng.choice(
        ['{"kind": "moon"}', {"kind": "swap_buy", "amount_eth": "-1"}, "not json", None]
    )


def test_fifty_agents_three_rounds_replay_without_mismatches(market, wallets):
    agents = [
        wallets.add(f"a{i:02d}", eth="2", tokens="2000" if i % 2 == 0 else "0")
        for i in range(1, AGENTS + 1)
    ]
    # 3% slippage against the round-start reserves: most swaps fill, late ones in a round revert.
    limits = ActionLimits(Decimal(1), max_slippage_bps=300)
    rng = random.Random(4663)
    initial = market.state()

    rounds = []
    for n in range(1, ROUNDS + 1):
        decision = market.state()  # every agent decides on the round-start market
        order = agents[:]
        rng.shuffle(order)
        records = []
        for agent in order:  # recorded in execution order
            action, note = parse_market_action(random_action(rng))
            if note is not None:
                records.append(ActionRecord.invalid(agent.agent_id, note))
            else:
                records.append(execute(market, agent, action, decision.reserves, limits))
        rounds.append(
            {
                "n": n,
                "posts": [],
                "actions": [record.to_dict() for record in records],
                "market": market.state().to_run_market(),
            }
        )
    run = {"world": market.run_world(initial.to_run_market()), "rounds": rounds}

    assert check_run_market(run) == []
    assert check_run_market(run, initial_reserves=initial.reserves) == []

    World.model_validate(run["world"])
    for rnd in rounds:
        RunMarket.model_validate(rnd["market"])
        for action in rnd["actions"]:
            Action.model_validate(action)
        assert sorted(action["agentId"] for action in rnd["actions"]) == [
            a.agent_id for a in agents
        ]

    outcomes = Counter((a["kind"], a["status"]) for rnd in rounds for a in rnd["actions"])
    assert outcomes[("swap_buy", "ok")] >= 20 and outcomes[("swap_sell", "ok")] >= 5
    assert outcomes[("swap_buy", "reverted")] + outcomes[("swap_sell", "reverted")] >= 1
    assert (
        outcomes[("hold", "invalid")]
        and outcomes[("hold", "ok")]
        and outcomes[("check_market", "ok")]
    )

    # Gas is free, so each agent's ETH is exactly its start minus spent plus received.
    for agent in agents:
        pnl = wallets.pnl(agent.agent_id)
        assert market.eth_balance(agent.address) == START_ETH - pnl.eth_spent + pnl.eth_received
    holding = sum(1 for agent in agents if market.token_balance(agent.address) > 0)
    assert rounds[-1]["market"]["holders"] == holding

    replayed_price = rounds[1]["market"]["price"]
    rounds[1]["market"]["price"] = "1"
    assert check_run_market(run) == [f"round 2: market.price is '1', replayed {replayed_price!r}"]
