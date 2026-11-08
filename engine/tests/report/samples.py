"""Test data for the report tests: a hand-built 4-round run and a scripted fake LLM client.

Expected values (computed by hand):
  prices   1e-6 -> 1.21e-6 (+21%) -> 1.44e-6 (+19.0083%) -> 1.00e-6 (-30.5556%) -> 1.00e-6 (0%)
  sentiment by round  [0.15, 0.25, -0.35, -0.225]
  candidates          round 3 (1.0), round 2 (0.2988), round 1 (0.2749)
  drivers             r1 a01 +21%, r2 a02 +19.0083%, r3 a03 -18.0556%, r3 a01 -15.2542%
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from hyvo.llm.types import ChatMessage, LLMResult, Prices
from hyvo.report.types import ReportInput, RoundTrace
from hyvo.runfile import hash_run

PERSONAS = {"a01": "sniper", "a02": "holder", "a03": "panic_seller", "a04": "skeptic"}
RUMOR = "Rumor: the dev wallet sold 20%"


def _swap(agent: str, kind: str, amount_in: str, amount_out: str, before: str, after: str, reason: str) -> dict[str, Any]:
    return {"agentId": agent, "persona": PERSONAS[agent], "kind": kind, "amountIn": amount_in,
            "amountOut": amount_out, "priceBefore": before, "priceAfter": after, "reason": reason}


def _post(post_id: str, agent: str, text: str, likes: int, reply_to: str | None = None) -> dict[str, Any]:
    return {"id": post_id, "agentId": agent, "persona": PERSONAS[agent], "text": text,
            "replyTo": reply_to, "likes": likes}


def _market(price: str, reserve0: str, reserve1: str, holders: int) -> dict[str, Any]:
    return {"price": price, "reserve0": reserve0, "reserve1": reserve1, "holders": holders}


def make_input(**overrides: Any) -> ReportInput:
    rounds = [
        RoundTrace(
            n=1,
            market_after=_market("0.00000121", "909338.7", "1.1", 1),
            swaps=[_swap("a01", "swap_buy", "0.1", "90661.3", "0.000001", "0.00000121", "early entry")],
            posts=[
                _post("p1", "a01", "In early, liquidity looks fine.", 3),
                _post("c2", "a04", "A 5% tax on every trade? Doubtful.", 2, "p1"),
            ],
            sentiments={"a01": 0.8, "a02": 0.2, "a03": 0.0, "a04": -0.4},
        ),
        RoundTrace(
            n=2,
            market_after=_market("0.00000144", "833333.3", "1.2", 2),
            swaps=[_swap("a02", "swap_buy", "0.1", "76005.4", "0.00000121", "0.00000144", "long hold")],
            posts=[_post("p3", "a02", "Holding for the long run.", 1)],
            sentiments={"a01": 0.6, "a02": 0.5, "a03": 0.1, "a04": -0.2},
        ),
        RoundTrace(
            n=3,
            market_after=_market("0.000001", "923333.3", "1.095", 2),
            swaps=[
                _swap("a03", "swap_sell", "50000", "0.06", "0.00000144", "0.00000118", "rumor"),
                _swap("a01", "swap_sell", "40000", "0.045", "0.00000118", "0.000001", "take profit"),
            ],
            posts=[
                _post("p4", "a03", "Dev wallet dumped, I am out.", 5),
                _post("c5", "a04", "Told you, the tax was a red flag.", 4, "p4"),
                _post("p6", "a01", "Taking profit here.", 0),
            ],
            sentiments={"a01": -0.1, "a02": 0.3, "a03": -0.9, "a04": -0.7},
            injected_events=[RUMOR],
            invalid_count=1,
        ),
        RoundTrace(
            n=4,
            market_after=_market("0.000001", "923333.3", "1.095", 2),
            sentiments={"a01": 0.0, "a02": 0.2, "a03": -0.5, "a04": -0.6},
            reverted_count=1,
        ),
    ]
    values: dict[str, Any] = {
        "scenario": {
            "title": "Test token lists with a 5% creator tax",
            "seedText": "A new token opens on a V2-style pool with a 5% creator tax.",
            "seedSources": [{"kind": "user", "ref": "cli"}],
            "injectedEvents": [{"round": 3, "text": RUMOR}],
        },
        "crowd": {
            "size": 4,
            "personaMix": {"sniper": 1, "holder": 1, "panic_seller": 1, "skeptic": 1},
            "model": {"agents": "offline/rules-v1", "report": "offline/rules-v1", "temperature": 0.8},
            "agents": [
                {"agentId": "a01", "handle": "@quietferret42", "persona": "sniper",
                 "startEth": "1", "startTokens": "0"},
                {"agentId": "a02", "handle": "@steady_otter", "persona": "holder",
                 "startEth": "1", "startTokens": "0"},
                {"agentId": "a03", "handle": "@jumpyheron7", "persona": "panic_seller",
                 "startEth": "1", "startTokens": "0"},
                {"agentId": "a04", "handle": "@doubtfulmole", "persona": "skeptic",
                 "startEth": "1", "startTokens": "0"},
            ],
        },
        "initial_market": _market("0.000001", "1000000", "1", 0),
        "rounds": rounds,
    }
    values.update(overrides)
    return ReportInput(**values)


def valid_output(**overrides: Any) -> dict[str, Any]:
    """A report/v1 answer that passes validation for ``make_input()``."""
    output: dict[str, Any] = {
        "summary": "Snipers and holders added ETH in rounds 1 and 2; after the rumor in round 3 "
        "the panic_seller and sniper agents exited and the price fell 30.56%.",
        "turningPoint": {"round": 3, "why": "The injected rumor preceded two exits.",
                         "evidencePostIds": ["p4", "c5"]},
        "objections": [{"text": "The 5% creator tax drew doubts.", "evidencePostIds": ["c2"]}],
        "priceDrivers": ["Round 3 exits by a03 and a01 moved the price down."],
    }
    output.update(overrides)
    return output


def run_with_report(inp: ReportInput, report: dict[str, Any]) -> dict[str, Any]:
    """A full run.json built from ``inp`` with ``report``, to check it against ``RunV1``."""
    rounds = []
    for trace in inp.rounds:
        swapped = {swap["agentId"]: swap for swap in trace.swaps}
        actions = []
        for agent in inp.crowd["agents"]:
            swap = swapped.get(agent["agentId"])
            if swap is None:
                actions.append({"agentId": agent["agentId"], "kind": "hold", "amountIn": None,
                                "amountOut": None, "txHash": None, "status": "ok", "note": None})
            else:
                actions.append({"agentId": agent["agentId"], "kind": swap["kind"],
                                "amountIn": swap["amountIn"], "amountOut": swap["amountOut"],
                                "txHash": "0x" + "ab" * 32, "status": "ok", "note": None})
        posts = [{k: v for k, v in post.items() if k != "persona"} for post in trace.posts]
        rounds.append({"n": trace.n, "posts": posts, "actions": actions, "market": trace.market_after})
    token, weth = "0x5FbDB2315678afecb367f032d93F642f64180aa3", "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
    run = {
        "runId": "run_01JC8Z6Q3W1Y2V9K7T5R4N3M2P",
        "version": 1,
        "createdAt": "2026-11-03T10:00:00Z",
        "status": inp.status,
        "stopReason": inp.stop_reason,
        "scenario": inp.scenario,
        "world": {
            "chainId": 4663,
            "forkBlock": None,
            "pools": [{"address": "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0", "token0": token,
                       "token1": weth, "kind": "v2-test", "feeBps": 30}],
            "token": {"address": token, "symbol": "HYVX", "name": "Hyvo Test Token", "decimals": 18},
            "quote": {"address": weth, "symbol": "WETH", "decimals": 18},
            "initialMarket": dict(inp.initial_market),
        },
        "crowd": inp.crowd,
        "rounds": rounds,
        "report": report,
        "usage": {"llmCalls": 3, "inputTokens": 100, "outputTokens": 50, "costUsd": 0.0},
    }
    run["hash"] = hash_run(run)
    return run


Reply = str | dict[str, Any] | BaseException | Callable[[Sequence[ChatMessage]], str]
FREE = Prices(0.0, 0.0)


@dataclass
class FakeClient:
    """Scripted ``LLMClient``: each call consumes the next reply (text, dict as JSON, an exception
    to raise, or a function of the messages)."""

    replies: list[Reply]
    calls: list[dict[str, Any]] = field(default_factory=list)
    model_label: str = "fake/model"
    prices: Prices = FREE

    def complete(self, messages: Sequence[ChatMessage], *, temperature: float, max_tokens: int,
                 json_mode: bool, purpose: str) -> LLMResult:
        self.calls.append({"messages": list(messages), "temperature": temperature,
                           "max_tokens": max_tokens, "json_mode": json_mode, "purpose": purpose})
        if not self.replies:
            raise AssertionError("FakeClient received more calls than scripted")
        reply = self.replies.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        if callable(reply):
            reply = reply(messages)
        text = reply if isinstance(reply, str) else json.dumps(reply)
        return LLMResult(text=text, input_tokens=10, output_tokens=10, model=self.model_label,
                         finish_reason="stop", latency_ms=1, cost_usd=0.0, estimated_tokens=False)
