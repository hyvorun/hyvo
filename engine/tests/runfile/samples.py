"""Test data for the run.json tests: a small valid run and the shared packages/schema vectors."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from hyvo.runfile import DISCLAIMER, hash_run

VECTORS_DIR = Path(__file__).resolve().parents[3] / "packages" / "schema" / "test-vectors"
SCHEMA_FILE = VECTORS_DIR.parent / "run.schema.json"

TOKEN = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
WETH = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
POOL = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"


def require_file(path: Path) -> Path:
    """Skip the calling test when a file produced by packages/schema does not exist yet."""
    if not path.is_file():
        pytest.skip(f"{path} is missing; it is produced by packages/schema")
    return path


def load_vector(name: str) -> Any:
    return json.loads(require_file(VECTORS_DIR / name).read_text(encoding="utf-8"))


def _tx(n: int) -> str:
    return "0x" + f"{n:02x}" * 32


def build_run() -> dict[str, Any]:
    """A small run that satisfies every rule of RUN_FORMAT.md, with its hash set."""
    run: dict[str, Any] = {
        "runId": "run_01JC8Z6Q3W1Y2V9K7T5R4N3M2P",
        "version": 1,
        "createdAt": "2026-11-03T10:00:00Z",
        "status": "complete",
        "stopReason": None,
        "scenario": {
            "title": "Test token lists with a 5% creator tax",
            "seedText": "A new token opens on a V2-style pool. Non-ASCII stays UTF-8: café, 🚀.",
            "seedSources": [{"kind": "user", "ref": "cli"}],
            "injectedEvents": [{"round": 2, "text": "Rumor: the dev wallet sold 20%"}],
        },
        "world": {
            "chainId": 4663,
            "forkBlock": None,
            "pools": [
                {"address": POOL, "token0": TOKEN, "token1": WETH, "kind": "v2-test", "feeBps": 30}
            ],
            "token": {"address": TOKEN, "symbol": "HYVX", "name": "Hyvo Test Token", "decimals": 18},
            "quote": {"address": WETH, "symbol": "WETH", "decimals": 18},
            "initialMarket": {"price": "0.0001", "reserve0": "1000000", "reserve1": "100", "holders": 1},
        },
        "crowd": {
            "size": 4,
            "personaMix": {"sniper": 1, "holder": 1, "panic_seller": 1, "skeptic": 1},
            "model": {"agents": "offline/rules", "report": "offline/rules", "temperature": 0.8},
            "agents": [
                {"agentId": "a01", "handle": "@quietferret42", "persona": "sniper",
                 "startEth": "1", "startTokens": "0"},
                {"agentId": "a02", "handle": "@steady_otter", "persona": "holder",
                 "startEth": "2.5", "startTokens": "1000"},
                {"agentId": "a03", "handle": "@jumpyheron7", "persona": "panic_seller",
                 "startEth": "0.8", "startTokens": "0"},
                {"agentId": "a04", "handle": "@doubtfulmole", "persona": "skeptic",
                 "startEth": "1.2", "startTokens": "0"},
            ],
        },
        "rounds": [
            {
                "n": 1,
                "posts": [
                    {"id": "p1", "agentId": "a01", "text": "In early.", "replyTo": None, "likes": 2},
                    {"id": "c2", "agentId": "a04", "text": "5% on every trade?", "replyTo": "p1", "likes": 1},
                ],
                "actions": [
                    {"agentId": "a01", "kind": "swap_buy", "amountIn": "0.05", "amountOut": "41234.5",
                     "txHash": _tx(1), "status": "ok", "note": None},
                    {"agentId": "a02", "kind": "swap_buy", "amountIn": "0.02", "amountOut": "16000",
                     "txHash": _tx(2), "status": "ok", "note": None},
                    {"agentId": "a03", "kind": "hold", "amountIn": None, "amountOut": None,
                     "txHash": None, "status": "invalid", "note": "amount above the per-agent cap"},
                    {"agentId": "a04", "kind": "check_market", "amountIn": None, "amountOut": None,
                     "txHash": None, "status": "ok", "note": None},
                ],
                "market": {"price": "0.000001234", "reserve0": "942765.5", "reserve1": "1.07", "holders": 2},
            },
            {
                "n": 2,
                "posts": [
                    {"id": "p3", "agentId": "a03", "text": "Dev wallet rumor, out.", "replyTo": None, "likes": 4},
                    {"id": "c4", "agentId": "a02", "text": "Still here.", "replyTo": "c2", "likes": 0},
                ],
                "actions": [
                    {"agentId": "a01", "kind": "swap_sell", "amountIn": "20000", "amountOut": "0.0241",
                     "txHash": _tx(3), "status": "ok", "note": None},
                    {"agentId": "a02", "kind": "swap_sell", "amountIn": "100", "amountOut": None,
                     "txHash": _tx(4), "status": "reverted", "note": "slippage limit exceeded"},
                    {"agentId": "a03", "kind": "hold", "amountIn": None, "amountOut": None,
                     "txHash": None, "status": "ok", "note": None},
                    {"agentId": "a04", "kind": "hold", "amountIn": None, "amountOut": None,
                     "txHash": None, "status": "ok", "note": None},
                ],
                "market": {"price": "0.0000011", "reserve0": "962765.5", "reserve1": "1.0459", "holders": 2},
            },
        ],
        "report": {
            "summary": "The synthetic crowd added liquidity in round 1 and reduced it after the rumor.",
            "turningPoint": {"round": 2, "why": "The injected rumor preceded the first sell (p3)."},
            "sentimentByRound": [0.25, -0.5],
            "objections": ["The 5% tax drew doubts (c2)."],
            "priceDrivers": ["Round 2: a01 (sniper) sold 20000 HYVX, price -10.86%."],
            "disclaimer": DISCLAIMER,
            "flags": [],
        },
        "usage": {"llmCalls": 9, "inputTokens": 12000, "outputTokens": 2400, "costUsd": 0.0031},
    }
    run["hash"] = hash_run(run)
    return run
