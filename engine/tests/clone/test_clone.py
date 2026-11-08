"""Wallet Clone: a wallet's trades become numbers, and the numbers become an agent. Nothing about who it is gets through."""

from __future__ import annotations

import json
import re
import urllib.error
from collections.abc import Sequence
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest

from hyvo.clone import BlockscoutSource, CloneProfile, HistoryError, NotEnoughHistory, Trade, build_profile, clone_persona, tokens_to_date, trades_from
from hyvo.personas import generate_crowd, join_crowd
from hyvo.report.guard import find_violations
from hyvo.runner.models import JobError, parse_job
from hyvo.sim.rundoc import persona_mix

ME = "0x" + "aB" * 20
POOL = "0x" + "11" * 20
FRIEND = "0x" + "22" * 20
TOKEN_A = "0x" + "a1" * 20
TOKEN_B = "0x" + "b2" * 20
USDG = "0x" + "cc" * 20
WETH = "0x" + "dd" * 20
START = datetime(2026, 10, 1, tzinfo=UTC).timestamp()
ETH = 10**18


def when(seconds: float) -> str:
    return datetime.fromtimestamp(START + seconds, UTC).strftime("%Y-%m-%dT%H:%M:%S.000000Z")


def tx(tx_hash: str, at: float, value: int = 0, *, sender: str = ME, method: str = "swapExactETHForTokens", status: str = "ok", result: str = "success") -> dict[str, Any]:
    return {
        "hash": tx_hash,
        "timestamp": when(at),
        "value": str(value),
        "from": {"hash": sender},
        "to": {"hash": POOL},
        "method": method,
        "status": status,
        "result": result,
    }


def transfer(tx_hash: str, token: str, amount: int, *, into_me: bool = True, symbol: str = "MOSS", decimals: int = 18, other: str = POOL) -> dict[str, Any]:
    return {
        "transaction_hash": tx_hash,
        "timestamp": "ignored",
        "from": {"hash": other if into_me else ME},
        "to": {"hash": ME if into_me else other},
        "token": {"address_hash": token, "symbol": symbol, "decimals": str(decimals), "type": "ERC-20"},
        "total": {"decimals": str(decimals), "value": str(amount)},
        "token_type": "ERC-20",
        "type": "token_transfer",
    }


def trade(at: float, token: str, side: str, tokens: float, eth: float | None = None) -> Trade:
    return Trade(f"0x{int(at):x}", START + at, token, side, Decimal(str(tokens)), Decimal(str(eth)) if eth is not None else None)


# --- reading trades ------------------------------------------------------------------------------------------------------


def test_a_swap_paid_in_eth_is_a_buy_of_that_size() -> None:
    [buy] = trades_from(ME, [tx("0xaa", 0, ETH // 4)], [transfer("0xaa", TOKEN_A, 1000 * ETH)])
    assert (buy.side, buy.token, buy.tokens, buy.eth) == ("buy", TOKEN_A, Decimal(1000), Decimal("0.25"))
    assert buy.at == START


def test_a_swap_back_to_eth_is_a_sell_and_its_size_stays_unknown() -> None:
    [sell] = trades_from(ME, [tx("0xaa", 0)], [transfer("0xaa", TOKEN_A, 400 * ETH, into_me=False)])
    assert (sell.side, sell.tokens, sell.eth) == ("sell", Decimal(400), None)


def test_a_weth_leg_says_what_a_buy_cost() -> None:
    trades = trades_from(
        ME,
        [tx("0xaa", 0, method="swapExactTokensForTokens")],
        [transfer("0xaa", TOKEN_A, 500 * ETH), transfer("0xaa", WETH, ETH // 2, into_me=False, symbol="WETH")],
    )
    assert [(t.token, t.eth) for t in trades] == [(TOKEN_A, Decimal("0.5"))]


def test_a_stablecoin_is_what_a_position_is_priced_in_not_a_position() -> None:
    trades = trades_from(
        ME,
        [tx("0xaa", 0, method="swapExactTokensForTokens")],
        [transfer("0xaa", TOKEN_A, 500 * ETH), transfer("0xaa", USDG, 20 * 10**6, into_me=False, symbol="USDG", decimals=6)],
    )
    assert [t.token for t in trades] == [TOKEN_A] and trades[0].eth is None


@pytest.mark.parametrize(
    ("transaction", "move"),
    [
        (tx("0xaa", 0, sender=FRIEND), transfer("0xaa", TOKEN_A, ETH)),  # an airdrop: someone else sent it
        (tx("0xaa", 0, method="transfer"), transfer("0xaa", TOKEN_A, ETH, into_me=False, other=FRIEND)),  # moving tokens is not selling them
        (tx("0xaa", 0, status="error", result="reverted"), transfer("0xaa", TOKEN_A, ETH)),  # it failed
        (tx("0xbb", 0), transfer("0xaa", TOKEN_A, ETH)),  # a transfer in a transaction the wallet did not send
    ],
    ids=["airdrop", "plain transfer", "failed", "not sent"],
)
def test_what_is_not_a_trade(transaction: dict[str, Any], move: dict[str, Any]) -> None:
    assert trades_from(ME, [transaction], [move]) == []


def test_a_transfer_to_itself_moves_nothing() -> None:
    move = transfer("0xaa", TOKEN_A, ETH)
    move["from"] = {"hash": ME}
    assert trades_from(ME, [tx("0xaa", 0)], [move]) == []


def test_addresses_compare_without_their_case_and_trades_come_oldest_first() -> None:
    transactions = [tx("0xbb", 100, ETH // 10), tx("0xaa", 0, ETH // 10)]
    trades = trades_from(ME.upper().replace("0X", "0x"), transactions, [transfer("0xbb", TOKEN_B, ETH), transfer("0xaa", TOKEN_A, ETH)])
    assert [t.tx_hash for t in trades] == ["0xaa", "0xbb"]


# --- the explorer --------------------------------------------------------------------------------------------------------


class Explorer:
    """Answers like Blockscout's REST API, and remembers what it was asked."""

    def __init__(self, pages: dict[str, list[dict[str, Any]]], errors: Sequence[Exception] = ()) -> None:
        self.pages = pages
        self.errors = list(errors)
        self.urls: list[str] = []

    def __call__(self, url: str) -> bytes:
        self.urls.append(url)
        if self.errors:
            raise self.errors.pop(0)
        path = url.split("/api/v2", 1)[1].split("?", 1)[0]
        return json.dumps(self.pages[path].pop(0)).encode()


def source(explorer: Explorer) -> BlockscoutSource:
    return BlockscoutSource("proapi_secret", "https://explorer.test/api/v2", explorer, sleep=lambda _: None)


def test_it_follows_the_pages_and_sends_the_key() -> None:
    explorer = Explorer(
        {
            f"/addresses/{ME}/transactions": [{"items": [tx("0xaa", 0, ETH // 10)], "next_page_params": {"index": 7, "items_count": 50}}, {"items": [tx("0xbb", 10, ETH // 10)], "next_page_params": None}],
            f"/addresses/{ME}/token-transfers": [{"items": [transfer("0xaa", TOKEN_A, ETH), transfer("0xbb", TOKEN_A, ETH)], "next_page_params": None}],
        }
    )
    trades = source(explorer).trades(ME)
    assert [t.tx_hash for t in trades] == ["0xaa", "0xbb"]
    assert all("apikey=proapi_secret" in url for url in explorer.urls)
    assert "index=7" in explorer.urls[1] and "type=ERC-20" in explorer.urls[2]


def test_a_rate_limit_is_waited_out_once() -> None:
    limited = urllib.error.HTTPError("https://explorer.test", 429, "busy", None, None)  # type: ignore[arg-type]
    waits: list[float] = []
    explorer = Explorer({f"/addresses/{ME}/transactions": [{"items": [], "next_page_params": None}], f"/addresses/{ME}/token-transfers": [{"items": [], "next_page_params": None}]}, [limited])
    BlockscoutSource("k", "https://explorer.test/api/v2", explorer, sleep=waits.append).trades(ME)
    assert 20.0 in waits


@pytest.mark.parametrize(
    ("error", "message"),
    [
        (urllib.error.HTTPError("https://explorer.test/x?apikey=proapi_secret", 403, "nope", None, None), "answered 403"),  # type: ignore[arg-type]
        (urllib.error.URLError("no route"), "could not be reached"),
    ],
)
def test_a_failure_names_the_problem_and_never_the_key(error: Exception, message: str) -> None:
    explorer = Explorer({}, [error])
    with pytest.raises(HistoryError, match=message) as caught:
        source(explorer).trades(ME)
    assert "proapi_secret" not in str(caught.value)


def test_an_answer_that_is_not_json_is_a_failure() -> None:
    with pytest.raises(HistoryError, match="not JSON"):
        BlockscoutSource("k", "https://explorer.test/api/v2", lambda url: b"<html>Just a moment...</html>", sleep=lambda _: None).trades(ME)


def test_a_token_age_comes_from_its_creation_and_may_be_unknown() -> None:
    explorer = Explorer(
        {
            f"/addresses/{TOKEN_A}": [{"creation_transaction_hash": "0xcc"}],
            "/transactions/0xcc": [{"timestamp": when(0)}],
            f"/addresses/{TOKEN_B}": [{"creation_transaction_hash": None}],
        }
    )
    assert source(explorer).token_created_at(TOKEN_A) == START
    assert source(explorer).token_created_at(TOKEN_B) is None


# --- the numbers ----------------------------------------------------------------------------------------------------------

SOME_TRADES = [
    trade(0, TOKEN_A, "buy", 1000, 0.1),
    trade(600, TOKEN_A, "sell", 500),
    trade(1200, TOKEN_A, "sell", 500),
    trade(2000, TOKEN_B, "buy", 100, 0.3),
    trade(3000, TOKEN_B, "buy", 100, 0.2),
    trade(2000 + 4 * 3600, TOKEN_B, "sell", 50),
]


def test_the_numbers_of_a_small_history() -> None:
    profile = build_profile(SOME_TRADES, {TOKEN_A: START - 1800, TOKEN_B: START - 86_400})
    assert (profile.trades, profile.buys, profile.sells, profile.tokens) == (6, 3, 3, 2)
    assert profile.typicalBuyEth == 0.2 and profile.smallBuyEth == 0.1 and profile.largeBuyEth == 0.3
    # A held 10 minutes, then B 4 hours: each position's first sale counts once.
    assert profile.medianHoldHours == pytest.approx(2.1, abs=0.05)
    assert profile.soldWithinHourPct == 50
    assert profile.stillHeldPct == 50  # A was sold in full and B was not
    assert profile.medianSellPct == 50  # half of A, then all that was left of A, then a quarter of B
    assert profile.earlyEntryPct == 50  # A at 30 minutes old, B at a day


def test_a_position_sold_in_pieces_counts_its_first_sale_once() -> None:
    trades = [trade(0, TOKEN_A, "buy", 100, 0.1), *[trade(600 * n, TOKEN_A, "sell", 10) for n in range(1, 5)]]
    profile = build_profile(trades)
    assert profile.medianHoldHours == pytest.approx(600 / 3600, rel=0.05) and profile.soldWithinHourPct == 100


def test_a_sale_of_what_it_bought_before_this_history_is_not_a_position() -> None:
    trades = [trade(0, TOKEN_A, "sell", 100), *[trade(10 * n, TOKEN_B, "buy", 10, 0.1) for n in range(1, 5)]]
    profile = build_profile(trades)
    assert profile.medianHoldHours is None and profile.medianSellPct is None and profile.soldWithinHourPct is None


def test_a_token_bought_again_after_it_was_sold_is_a_new_position() -> None:
    trades = [
        trade(0, TOKEN_A, "buy", 100, 0.1),
        trade(600, TOKEN_A, "sell", 100),
        trade(10_000, TOKEN_A, "buy", 100, 0.1),
        trade(10_000 + 7200, TOKEN_A, "sell", 100),
        trade(20_000, TOKEN_B, "buy", 1, 0.1),
    ]
    profile = build_profile(trades)
    assert profile.soldWithinHourPct == 50, "two first sales, one within the hour"
    assert profile.stillHeldPct == 50


def test_too_few_trades_say_how_many_it_found() -> None:
    with pytest.raises(NotEnoughHistory, match="this wallet has 2 trades on Robinhood Chain, and a clone needs at least 5"):
        build_profile(SOME_TRADES[:2])


def test_the_most_traded_tokens_are_the_ones_dated() -> None:
    assert tokens_to_date(SOME_TRADES) == [TOKEN_B, TOKEN_A]


def everything_said(profile: CloneProfile) -> str:
    persona = clone_persona(profile)
    return json.dumps(profile.to_dict()) + persona.describe()


def test_nothing_identifies_the_wallet() -> None:
    profile = build_profile(SOME_TRADES, {TOKEN_A: START - 1800})
    said = everything_said(profile)
    for secret in (ME, ME.lower(), TOKEN_A, TOKEN_B, "2026"):
        assert secret not in said
    assert not re.search(r"0x[0-9a-fA-F]{6,}", said)
    assert set(profile.to_dict()) == set(CloneProfile.__dataclass_fields__)


def test_the_persona_comes_from_the_numbers_and_breaks_no_copy_rule() -> None:
    persona = clone_persona(build_profile(SOME_TRADES, {TOKEN_A: START - 1800, TOKEN_B: START - 86_400}))
    assert persona.id == "clone"
    low, high = persona.typical_size_eth
    assert 0 < low <= 0.1 and 0.3 <= high <= persona.per_agent_cap_eth
    assert persona.per_agent_cap_eth < persona.initial_eth[0] < persona.initial_eth[1]
    text = persona.describe()
    assert "6 trades in 2 tokens" in text and "50% of its first sales came within an hour" in text
    assert find_violations(text) == []
    assert not re.search(r"\b(he|she|his|her|risk-loving|degen|gambler)\b", text.lower()), "no guesses about a person"


def test_a_wallet_with_gaps_still_makes_a_persona() -> None:
    profile = build_profile([trade(10 * n, TOKEN_B, "buy", 10) for n in range(1, 6)])
    assert profile.typicalBuyEth is None and profile.medianHoldHours is None
    persona = clone_persona(profile)
    assert "no sale on record" in persona.describe()
    assert persona.typical_size_eth[0] > 0


def test_extreme_sizes_stay_within_what_a_run_can_hold() -> None:
    huge = clone_persona(build_profile([trade(n, TOKEN_A, "buy", 1, 500) for n in range(1, 6)]))
    assert huge.per_agent_cap_eth <= 3
    tiny = clone_persona(build_profile([trade(n, TOKEN_A, "buy", 1, 0.00001) for n in range(1, 6)]))
    assert tiny.typical_size_eth[0] >= 0.001


def test_a_profile_from_the_wire_with_something_extra_is_refused() -> None:
    wire = build_profile(SOME_TRADES).to_dict()
    assert CloneProfile.from_mapping(wire) == build_profile(SOME_TRADES)
    with pytest.raises(ValueError, match="address"):
        CloneProfile.from_mapping({**wire, "address": ME})


# --- the crowd and the job ---------------------------------------------------------------------------------------------------


def test_one_agent_of_the_crowd_plays_it() -> None:
    persona = clone_persona(build_profile(SOME_TRADES))
    plain = generate_crowd(20, seed=9)
    joined = join_crowd(plain, persona, 9)
    changed = [(a, b) for a, b in zip(plain, joined, strict=True) if a != b]
    assert len(changed) == 1
    before, after = changed[0]
    assert (before.agent_id, before.handle) == (after.agent_id, after.handle) and after.persona.id == "clone"
    assert persona_mix(joined)["clone"] == 1 and "clone" not in persona_mix(plain)
    assert join_crowd(plain, persona, 9) == joined, "the same seed chooses the same agent"


def job(kind: str | None, spec: Any) -> dict[str, Any]:
    return {
        "runId": "run_01M6GCKE58E5YXTK38CQ5RRWEB",
        "leaseId": "lease_abcdefghijklmnop",
        "attempt": 1,
        "heartbeatIntervalS": 15,
        "timeoutS": 600,
        **({"kind": kind} if kind else {}),
        "spec": spec,
    }


def test_a_clone_job_names_one_wallet() -> None:
    parsed = parse_job(job("clone", {"address": ME}))
    assert parsed.kind == "clone" and parsed.spec.address == ME


@pytest.mark.parametrize("spec", [{"address": "not an address"}, {"address": ME, "extra": 1}, {}])
def test_a_clone_job_that_is_anything_else_is_refused(spec: dict[str, Any]) -> None:
    with pytest.raises(JobError):
        parse_job(job("clone", spec))
