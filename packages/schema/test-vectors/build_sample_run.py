"""Builds sample-run.json and sample-run.meta.json in this directory.

Independent of the TypeScript code and of the engine package: Uniswap V2 integer math, price via
Decimal (40 significant digits, half-even to 18 fractional digits), hash via rfc8785 + eth_hash,
runIdBytes32 via python-ulid. Run it with the engine's environment:

    cd engine && uv run --no-sync python ../packages/schema/test-vectors/build_sample_run.py         ../packages/schema/test-vectors
"""

import json
import sys
from datetime import datetime, timezone
from decimal import ROUND_HALF_EVEN, Decimal, localcontext
from pathlib import Path

import rfc8785
from eth_hash.auto import keccak
from eth_utils import to_checksum_address
from ulid import ULID

E18 = 10**18
FEE_BPS = 30


def units(wei: int, decimals: int = 18) -> str:
    whole, frac = divmod(wei, 10**decimals)
    if frac == 0:
        return str(whole)
    return f"{whole}.{str(frac).rjust(decimals, '0').rstrip('0')}"


def price(reserve_quote: int, reserve_token: int) -> str:
    with localcontext() as ctx:
        ctx.prec = 40
        ctx.rounding = ROUND_HALF_EVEN
        p = (Decimal(reserve_quote) / Decimal(reserve_token)).quantize(Decimal("1e-18"), rounding=ROUND_HALF_EVEN)
    s = format(p, "f")
    return s.rstrip("0").rstrip(".") if "." in s else s


def amount_out(amount_in: int, reserve_in: int, reserve_out: int) -> int:
    with_fee = amount_in * (10_000 - FEE_BPS)
    return with_fee * reserve_out // (reserve_in * 10_000 + with_fee)


def tx(label: str) -> str:
    return "0x" + keccak(f"hyvo-sample-{label}".encode()).hex()


token = to_checksum_address("0x5fbdb2315678afecb367f032d93f642f64180aa3")
weth = to_checksum_address("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512")
pair = to_checksum_address("0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0")
assert int(token, 16) < int(weth, 16)  # token0 = HYVX, token1 = WETH, as a V2 pair sorts them

created = datetime(2026, 11, 2, 12, 0, 0, tzinfo=timezone.utc)
ms = int(created.timestamp() * 1000)
run_ulid = ULID.from_bytes(ms.to_bytes(6, "big") + keccak(b"hyvo-sample-run")[:10])
run_id = f"run_{run_ulid}"

r_token, r_weth = 1_000_000 * E18, 10 * E18
initial_market = {"price": price(r_weth, r_token), "reserve0": units(r_token), "reserve1": units(r_weth), "holders": 0}

# Round 1: a01 enters with 0.5 ETH, a02 checks the market, a03 enters with 0.2 ETH.
out_a01 = amount_out(5 * E18 // 10, r_weth, r_token)
r_weth, r_token = r_weth + 5 * E18 // 10, r_token - out_a01
out_a03 = amount_out(2 * E18 // 10, r_weth, r_token)
r_weth, r_token = r_weth + 2 * E18 // 10, r_token - out_a03
market1 = {"price": price(r_weth, r_token), "reserve0": units(r_token), "reserve1": units(r_weth), "holders": 2}

# Round 2: a03 exits in full; a01's full exit (1% slippage limit, priced before a03's swap)
# reverts; a02's 2 ETH order exceeds its 1 ETH cap and becomes hold.
quoted_a01 = amount_out(out_a01, r_token, r_weth)
eth_a03 = amount_out(out_a03, r_token, r_weth)
r_token, r_weth = r_token + out_a03, r_weth - eth_a03
actual_a01 = amount_out(out_a01, r_token, r_weth)
assert actual_a01 < quoted_a01 * 99 // 100, "a01's exit must breach its slippage limit"
market2 = {"price": price(r_weth, r_token), "reserve0": units(r_token), "reserve1": units(r_weth), "holders": 1}


def action(agent, kind, amount_in=None, amount_out_=None, tx_hash=None, status="ok", note=None):
    return {"agentId": agent, "kind": kind, "amountIn": amount_in, "amountOut": amount_out_,
            "txHash": tx_hash, "status": status, "note": note}


def post(post_id, agent, text, reply_to, likes):
    return {"id": post_id, "agentId": agent, "text": text, "replyTo": reply_to, "likes": likes}


run = {
    "runId": run_id,
    "version": 1,
    "createdAt": created.strftime("%Y-%m-%dT%H:%M:%SZ"),
    "status": "complete",
    "stopReason": None,
    "scenario": {
        "title": "Thin-liquidity launch with a deployer rumor",
        "seedText": "A new test token launches with a small constant-product pool. Early agents see the pool "
        "before the feed does. In round 2 a rumor claims the deployer wallet moved part of the supply.",
        "seedSources": [{"kind": "user", "ref": "sample-scenario.md"}],
        "injectedEvents": [{"round": 2, "text": "Rumor: the deployer wallet moved 20% of the token supply to a fresh address."}],
    },
    "world": {
        "chainId": 4663,
        "forkBlock": None,
        "pools": [{"address": pair, "token0": token, "token1": weth, "kind": "v2-test", "feeBps": FEE_BPS}],
        "token": {"address": token, "symbol": "HYVX", "name": "Hyvo Test Token", "decimals": 18},
        "quote": {"address": weth, "symbol": "WETH", "decimals": 18},
        "initialMarket": initial_market,
    },
    "crowd": {
        "size": 3,
        "personaMix": {"sniper": 1, "holder": 1, "panic_seller": 1, "skeptic": 0},
        "model": {"agents": "provider/agents-model", "report": "provider/report-model", "temperature": 0.8},
        "agents": [
            {"agentId": "a01", "handle": "@quietferret42", "persona": "sniper", "startEth": "1", "startTokens": "0"},
            {"agentId": "a02", "handle": "@lowtide_otter", "persona": "holder", "startEth": "1.5", "startTokens": "0"},
            {"agentId": "a03", "handle": "@shaky_heron7", "persona": "panic_seller", "startEth": "0.5", "startTokens": "0"},
        ],
    },
    "rounds": [
        {
            "n": 1,
            "posts": [
                post("p1", "a01", "Fresh pool and thin liquidity. Took an early position before the feed noticed.", None, 2),
                post("c1", "a02", "Thin pools move fast both ways. Checking the reserves first.", "p1", 1),
                post("p2", "a03", "Everyone here sounds excited, so I am in with a small size \U0001F680", None, 0),
            ],
            "actions": [
                action("a01", "swap_buy", "0.5", units(out_a01), tx("tx-1")),
                action("a02", "check_market"),
                action("a03", "swap_buy", "0.2", units(out_a03), tx("tx-2")),
            ],
            "market": market1,
        },
        {
            "n": 2,
            "posts": [
                post("p3", "a03", "Rumor says the deployer moved 20% of supply. I am out — not waiting to find out.", None, 3),
                post("c2", "a01", "Tried to exit too. My tx reverted because the price moved before it landed.", "p3", 1),
            ],
            "actions": [
                action("a03", "swap_sell", units(out_a03), units(eth_a03), tx("tx-3")),
                action("a01", "swap_sell", units(out_a01), None, tx("tx-4"), "reverted",
                       "Reverted: output was below the 1% slippage limit."),
                action("a02", "hold", status="invalid",
                       note="swap_buy of 2 ETH exceeds the per-agent cap of 1 ETH; recorded as hold."),
            ],
            "market": market2,
        },
    ],
    "report": {
        "summary": "Two agents entered early on thin liquidity and lifted the price. The round 2 rumor flipped "
        "the mood: one agent exited in full, which moved the price enough that the sniper's exit reverted "
        "on slippage, and the holder's oversized order was rejected and recorded as a hold.",
        "turningPoint": {"round": 2, "why": "The injected deployer rumor turned sentiment negative and triggered the first full exit."},
        "sentimentByRound": [0.45, -0.6],
        "objections": [
            "Liquidity is thin, so a single order moves the price.",
            "Nobody checked the deployer rumor on-chain before reacting.",
        ],
        "priceDrivers": ["Two early entries in round 1.", "One full exit in round 2 after the rumor."],
        "disclaimer": "Synthetic crowd reaction. Not a trading signal.",
        "flags": ["rewritten:price_prediction"],
    },
    "usage": {"llmCalls": 3, "inputTokens": 2140, "outputTokens": 388, "costUsd": 0.000408},
}

run["hash"] = "0x" + keccak(rfc8785.dumps(run)).hex()  # hash is computed before the member exists
meta = {
    "hash": run["hash"],
    "scenarioHash": "0x" + keccak(rfc8785.dumps(run["scenario"])).hex(),
    "runIdBytes32": "0x" + "00" * 16 + run_ulid.bytes.hex(),
}

out_dir = Path(sys.argv[1])
(out_dir / "sample-run.json").write_text(json.dumps(run, indent=2, ensure_ascii=True) + "\n", encoding="ascii", newline="\n")
(out_dir / "sample-run.meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="ascii", newline="\n")
print(json.dumps(meta, indent=2))
print("initialMarket", initial_market)
print("market1", market1)
print("market2", market2)
print("quoted vs actual a01 exit:", units(quoted_a01), units(actual_a01))
