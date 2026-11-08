"""Rewind: a real pool's past, read from the chain, with one thing changed. The comparison is fixed before the run starts."""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

import pytest

from hyvo.rewind import CallReverted, Chain, ChainUnreachable, RewindError, RewindRequest, TokenInfo, plan_rewind
from hyvo.rewind.chain import DECIMALS, GET_RESERVES, NAME, SYMBOL, TOKEN0, TOKEN1
from hyvo.runfile.io import model_errors
from hyvo.runner.models import JobError, parse_job
from hyvo.scenarios import MarketOverrides, from_text

POOL = "0x" + "aa" * 20
WETH = "0x" + "bb" * 20
TOKEN = "0x" + "cc" * 20
HEAD = 1_000_000
RATE = 10  # blocks a second
ETH = 10**18
NOW = 1_790_000_000


def word(value: int) -> str:
    return f"{value:064x}"


def abi_text(text: str) -> str:
    raw = text.encode()
    return "0x" + word(32) + word(len(raw)) + raw.hex().ljust(64, "0")


class FakeChain:
    """Answers JSON-RPC like a node: reserves change with the block."""

    def __init__(self, *, pons: bool = False, eth_first: bool = True, reserves: Any = None, weth_symbol: str = "WETH") -> None:
        self.pons = pons
        self.eth_first = eth_first
        self.reserves = reserves or (lambda block: (5 * ETH + (block - 500_000) * 10**12, 100_000_000 * ETH))
        self.weth_symbol = weth_symbol
        self.calls: list[tuple[str, Any]] = []

    def __call__(self, url: str, body: bytes) -> bytes:
        request = json.loads(body)
        method, params = request["method"], request["params"]
        self.calls.append((method, params))
        return json.dumps({"jsonrpc": "2.0", "id": 1, **self.answer(method, params)}).encode()

    def answer(self, method: str, params: list[Any]) -> dict[str, Any]:
        if method == "eth_blockNumber":
            return {"result": hex(HEAD)}
        if method == "eth_getBlockByNumber":
            block = int(params[0], 16)
            return {"result": {"timestamp": hex(NOW - (HEAD - block) // RATE)}}
        call = params[0]
        to, data = call["to"], call["data"]
        block = int(params[1], 16)
        if to == POOL and data == GET_RESERVES:
            eth, tokens = self.reserves(block)
            first, second = (eth, tokens) if self.eth_first else (tokens, eth)
            return {"result": "0x" + word(first) + word(second) + word(0)}
        if to == POOL and data in (TOKEN0, TOKEN1):
            if self.pons:
                return {"error": {"code": 3, "message": "execution reverted"}}
            wanted = WETH if (data == TOKEN0) == self.eth_first else TOKEN
            return {"result": "0x" + word(int(wanted, 16))}
        if data == SYMBOL:
            return {"result": abi_text(self.weth_symbol if to == WETH else "MOSS")}
        if data == NAME:
            return {"result": abi_text("Moss")}
        if data == DECIMALS:
            return {"result": "0x" + word(18)}
        return {"error": {"code": 3, "message": "execution reverted"}}


def scenario(market: MarketOverrides | None = None, events: Any = None) -> Any:
    return from_text("Rewind of a launch", "People were nervous that day.", events if events is not None else [{"round": 2, "text": "The rumor came two hours earlier."}], ref="api", market=market)


REQUEST = RewindRequest(POOL, 500_000, 6.0)


def plan(fake: FakeChain | None = None, request: RewindRequest = REQUEST, **kwargs: Any) -> Any:
    chain = Chain("http://rpc.test", fake or FakeChain(), sleep=lambda _: None)
    return plan_rewind(request, kwargs.pop("scenario", scenario()), kwargs.pop("rounds", 4), chain, lookup=lambda pool: TokenInfo("BURRIOT", "Burriot"), **kwargs)


def test_the_path_is_read_from_the_chain_block_by_block() -> None:
    section = plan().section
    assert section["pool"] == POOL and section["block"] == 500_000 and section["hours"] == 6.0
    assert section["change"] == "The rumor came two hours earlier."
    blocks = [point["block"] for point in section["actual"]]
    assert blocks == [500_000 + 216_000 * n // 4 for n in range(5)], "six hours at ten blocks a second, in as many steps as rounds"
    assert section["actual"][0]["reserveEth"] == "5"
    last = section["actual"][-1]
    assert Decimal(last["reserveEth"]) == Decimal(5) + Decimal(216_000 * 10**12) / ETH
    assert Decimal(section["actual"][0]["price"]) == Decimal("0.00000005")


def test_the_market_starts_where_the_pool_was() -> None:
    played = plan().scenario
    assert played.market.liquidity_eth == Decimal(5) and played.market.liquidity_tokens == Decimal(100_000_000)
    assert played.market.token_symbol == "MOSS" and played.market.token_name == "Moss"
    assert played.market.fee_bps == 100
    assert "block 500000" in played.seed_text and "People were nervous that day." in played.seed_text
    assert "Nothing here touches the real pool" in played.seed_text


def test_a_pool_with_its_token_first_is_read_the_right_way_round() -> None:
    section = plan(FakeChain(eth_first=False)).section
    assert section["actual"][0]["reserveEth"] == "5" and section["actual"][0]["reserveToken"] == "100000000"


def test_a_pons_pool_has_its_eth_side_first_and_its_name_from_outside() -> None:
    played = plan(FakeChain(pons=True))
    assert played.scenario.market.token_symbol == "BURRIOT"
    assert played.section["actual"][0]["reserveEth"] == "5"


def test_a_token_symbol_with_odd_characters_is_made_safe() -> None:
    chain = Chain("http://rpc.test", FakeChain(pons=True), sleep=lambda _: None)
    played = plan_rewind(REQUEST, scenario(), 4, chain, lookup=lambda pool: TokenInfo("$moss-2 🌿", "Moss"))
    assert played.scenario.market.token_symbol == "MOSS2"


def test_what_the_order_sets_is_kept() -> None:
    played = plan(scenario=scenario(MarketOverrides(token_symbol="FERN", fee_bps=500)))
    assert played.scenario.market.token_symbol == "FERN" and played.scenario.market.fee_bps == 500


@pytest.mark.parametrize(
    ("request_", "message"),
    [
        (RewindRequest(POOL, HEAD, 6.0), "not in the past"),
        (RewindRequest(POOL, HEAD + 5, 6.0), "not in the past"),
        (RewindRequest(POOL, HEAD - 100, 6.0), "still in the future"),
        (RewindRequest(POOL, 500_000, 0.5), "1 to 72 hours"),
        (RewindRequest(POOL, 500_000, 100.0), "1 to 72 hours"),
    ],
)
def test_a_moment_it_cannot_compare_says_why(request_: RewindRequest, message: str) -> None:
    with pytest.raises(RewindError, match=message):
        plan(request=request_)


def test_a_pool_that_held_nothing_yet_says_so() -> None:
    with pytest.raises(RewindError, match="held nothing at block 500000"):
        plan(FakeChain(reserves=lambda block: (0, 0)))


def test_a_pool_not_priced_in_eth_is_refused() -> None:
    with pytest.raises(RewindError, match="not priced in ETH"):
        plan(FakeChain(weth_symbol="DAI"))


@pytest.mark.parametrize("events", [[], [{"round": 1, "text": "a"}, {"round": 2, "text": "b"}]])
def test_a_rewind_changes_exactly_one_thing(events: list[dict[str, Any]]) -> None:
    with pytest.raises(RewindError, match="exactly one event"):
        plan(scenario=scenario(events=events))


class NoState(FakeChain):
    """A node without the old state, for the first few calls: dRPC's free tier does this in bursts."""

    def __init__(self, failures: int, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.failures = failures

    def answer(self, method: str, params: list[Any]) -> dict[str, Any]:
        if method == "eth_call" and self.failures > 0:
            self.failures -= 1
            return {"error": {"code": 27, "message": "Unknown state. First available state is 1"}}
        return super().answer(method, params)


def test_a_burst_of_missing_state_is_waited_out() -> None:
    assert plan(NoState(2)).section["actual"][0]["reserveEth"] == "5"


def test_missing_state_is_not_mistaken_for_a_pons_pool() -> None:
    """A Pons pool refuses token0(). A node without the state also fails it, and reading that as Pons would swap ETH and the token."""
    played = plan(NoState(2, eth_first=False))
    assert played.scenario.market.token_symbol == "MOSS"
    assert played.section["actual"][0]["reserveEth"] == "5"


def test_state_that_never_comes_can_be_tried_again_later() -> None:
    with pytest.raises(ChainUnreachable, match="Unknown state"):
        plan(NoState(10_000))


# --- the RPC -------------------------------------------------------------------------------------------------------------


def test_an_rpc_that_does_not_answer_is_tried_again_then_named() -> None:
    attempts: list[str] = []

    def down(url: str, body: bytes) -> bytes:
        attempts.append(url)
        raise TimeoutError

    with pytest.raises(ChainUnreachable, match="eth_blockNumber"):
        Chain("http://rpc.test", down, sleep=lambda _: None).head()
    assert len(attempts) == 4


def test_a_refusal_is_not_tried_again() -> None:
    attempts: list[str] = []

    def refuses(url: str, body: bytes) -> bytes:
        attempts.append(url)
        return json.dumps({"error": {"message": "execution reverted"}}).encode()

    with pytest.raises(CallReverted, match="execution reverted"):
        Chain("http://rpc.test", refuses, sleep=lambda _: None).call(POOL, GET_RESERVES, 5)
    assert len(attempts) == 1


# --- the format and the job -----------------------------------------------------------------------------------------------


def job(spec: dict[str, Any]) -> dict[str, Any]:
    return {"runId": "run_01M6GCKE58E5YXTK38CQ5RRWEB", "leaseId": "lease_abcdefghijklmnop", "attempt": 1, "heartbeatIntervalS": 15, "timeoutS": 1800, "spec": spec}


SPEC = {
    "version": 1,
    "scenario": {"title": "Rewind", "seedText": "", "events": [{"round": 2, "text": "It came earlier."}], "market": None},
    "agents": 10,
    "rounds": 3,
    "mix": None,
    "batchSize": 10,
    "maxCostUsd": 0.1,
    "maxLlmCalls": 10,
    "seed": None,
}


def test_a_job_carries_where_to_go_back_to() -> None:
    parsed = parse_job(job({**SPEC, "rewind": {"pool": POOL, "block": 5, "hours": 6}}))
    assert parsed.spec.rewind.block == 5 and parsed.spec.rewind.hours == 6


@pytest.mark.parametrize("rewind", [{"pool": "nope", "block": 5, "hours": 6}, {"pool": POOL, "block": 0, "hours": 6}, {"pool": POOL, "block": 5, "hours": 73}, {"pool": POOL, "block": 5}])
def test_a_job_with_a_bad_rewind_is_refused(rewind: dict[str, Any]) -> None:
    with pytest.raises(JobError):
        parse_job(job({**SPEC, "rewind": rewind}))


def fixture_run() -> dict[str, Any]:
    from pathlib import Path

    return json.loads((Path(__file__).resolve().parents[3] / "fixtures" / "ten-personas-run.json").read_text(encoding="utf-8"))


def with_rewind(doc: dict[str, Any], **changes: Any) -> dict[str, Any]:
    section = {"pool": POOL, "block": 5, "at": "2026-11-01T00:00:00Z", "hours": 6.0, "change": "It came earlier.", "actual": [
        {"block": 5, "at": "2026-11-01T00:00:00Z", "price": "0.1", "reserveEth": "1", "reserveToken": "10"},
        {"block": 9, "at": "2026-11-01T06:00:00Z", "price": "0.2", "reserveEth": "2", "reserveToken": "10"},
    ], **changes}  # fmt: skip
    return {**doc, "world": {**doc["world"], "forkBlock": 5}, "rewind": section}


def test_the_format_holds_a_rewind_and_its_rules() -> None:
    doc = with_rewind(fixture_run())
    assert model_errors(doc) == []
    assert any("rewind" in str(problem) for problem in model_errors({**doc, "world": {**doc["world"], "forkBlock": 6}}))
    backwards = with_rewind(fixture_run())
    backwards["rewind"]["actual"] = list(reversed(backwards["rewind"]["actual"]))
    assert any("rewind" in str(problem) for problem in model_errors(backwards))
