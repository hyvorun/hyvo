"""Unit tests of the simulation glue: config validation, decision-to-action mapping, sentiment
placeholders, the swap tape, the market panel, run.json assembly and the event log. No anvil, no
OASIS."""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest
from simkit import offline_settings, sim_config, write_scenario

from hyvo.actions.models import CheckMarket, Hold, SwapBuy, SwapSell
from hyvo.config import Settings
from hyvo.decisions import Decision
from hyvo.personas import generate_crowd
from hyvo.scenarios import ScenarioError, parse_scenario_markdown
from hyvo.sim import SimConfig, SimConfigError, run_simulation
from hyvo.sim.events import EventLog, read_events
from hyvo.sim.loop import market_config
from hyvo.sim.rundoc import RoundRecord, persona_mix, posts_by_round, run_rounds
from hyvo.sim.social import SocialPost
from hyvo.sim.views import (
    MARKET_INVALID_NOTE,
    SwapTape,
    feed_post,
    market_view,
    percent_change,
    plan_action,
    reported_sentiment,
)
from hyvo.world.amm import Reserves, apply_buy, apply_sell
from hyvo.world.market import MarketConfig
from hyvo.world.state import MarketState
from hyvo.world.units import format_amount, format_price

WEI = 10**18


def decision(market=None, notes=(), sentiment=0.4, post=None) -> Decision:
    return Decision("a01", post, [], market, sentiment, "why not", list(notes))


# --- SimConfig ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"agents": 0}, "agents must be a whole number from 1"),
        ({"agents": 10_000}, "agents must be a whole number from 1"),
        ({"rounds": 0}, "rounds must be"),
        ({"batch_size": 0}, "batch_size must be"),
        ({"max_concurrency": 0}, "max_concurrency must be"),
        ({"max_cost_usd": -1}, "max_cost_usd must be a finite number >= 0"),
        ({"max_cost_usd": float("nan")}, "max_cost_usd must be"),
        ({"max_llm_calls": -1}, "max_llm_calls must be"),
        ({"fork": "yes"}, "fork must be True, False or None"),
        ({"fork": False, "fork_block": 5}, "fork_block needs a fork"),
        ({"timeout_s": 0}, "timeout_s must be a finite number > 0"),
        ({"temperature": 3}, "temperature must be"),
        ({"seed": -1}, "seed must be"),
        ({"agents": True}, "agents must be"),
        ({"mix": 7}, "mix must be"),
        ({"max_slippage_bps": 10_001}, "max_slippage_bps must be"),
        ({"seed_token_share": Decimal("1.5")}, "seed_token_share must be"),
        ({"run_id": "run_123"}, "run_id must be 'run_' and a ULID"),
        ({"run_id": "run_8ZZZZZZZZZZZZZZZZZZZZZZZZZ"}, "run_id must be"),  # above 128 bits
    ],
)
def test_sim_config_rejects_bad_values(overrides, message):
    with pytest.raises(SimConfigError, match=message):
        SimConfig(scenario="s.md", **overrides)


def test_sim_config_defaults():
    config = SimConfig(scenario="s.md")
    assert (config.agents, config.rounds, config.batch_size, config.max_concurrency) == (50, 10, 10, 4)
    assert (config.max_cost_usd, config.max_llm_calls, config.fork, config.seed) == (None, None, None, None)
    assert (config.timeout_s, config.temperature, config.max_slippage_bps) == (1800.0, 0.8, 1500)
    assert config.run_id is None


@pytest.mark.parametrize(
    ("settings", "overrides", "message"),
    [
        (Settings(), {"fork": True}, "RH_RPC_URL is not set"),
        (Settings(), {"fork": None, "fork_block": 7}, "fork_block needs a fork"),
        (Settings(rh_rpc_url="http://127.0.0.1:1"), {"fork": False}, None),  # --no-fork wins
    ],
)
def test_fork_options_are_checked_before_anything_starts(tmp_path, settings, overrides, message):
    config = sim_config(write_scenario(tmp_path), tmp_path / "runs", **overrides)
    from hyvo.sim.loop import _Simulation

    simulation = _Simulation(config, settings, None, None)
    if message is None:
        simulation.resolve()
        assert simulation.fork_url is None
        return
    with pytest.raises(SimConfigError, match=message):
        run_simulation(config, settings)
    assert not (tmp_path / "runs").exists()  # nothing was created


def test_bad_scenario_and_mix_fail_before_anything_starts(tmp_path):
    scenario = write_scenario(tmp_path, {5: "Late event"})
    with pytest.raises(ScenarioError, match="after the last round"):
        run_simulation(sim_config(scenario, tmp_path / "runs", rounds=3), offline_settings())
    with pytest.raises(ValueError, match="persona mix sums to 3"):
        run_simulation(
            sim_config(write_scenario(tmp_path), tmp_path / "runs", mix="sniper=3"),
            offline_settings(),
        )
    with pytest.raises(SimConfigError, match="scenario file not found"):
        run_simulation(sim_config(tmp_path / "missing.md", tmp_path / "runs"), offline_settings())
    assert not (tmp_path / "runs").exists()


def test_a_missing_run_schema_fails_before_anything_starts(tmp_path, monkeypatch):
    monkeypatch.setenv("HYVO_RUN_SCHEMA", str(tmp_path / "nowhere" / "run.schema.json"))
    with pytest.raises(SimConfigError, match="run.json schema not found"):
        run_simulation(sim_config(write_scenario(tmp_path), tmp_path / "runs"), offline_settings())
    assert not (tmp_path / "runs").exists()


def test_market_config_applies_scenario_overrides():
    plain = parse_scenario_markdown("---\ntitle: Plain\n---\nseed\n")
    assert market_config(plain) == MarketConfig()
    custom = parse_scenario_markdown(
        "---\ntitle: Custom\ntoken_symbol: GLINT\nliquidity_eth: 5\nfee_bps: 500\n---\nseed\n"
    )
    config = market_config(custom)
    assert (config.token_symbol, config.fee_bps, config.liquidity_eth) == ("GLINT", 500, Decimal(5))
    assert config.token_name == MarketConfig().token_name
    assert config.liquidity_tokens == MarketConfig().liquidity_tokens


# --- decisions to actions -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("market", "expected"),
    [
        ({"action": "swap_buy", "amountEth": "0.05"}, SwapBuy(amount_eth=Decimal("0.05"))),
        ({"action": "swap_buy", "amount_eth": 0.1}, SwapBuy(amount_eth=Decimal("0.1"))),
        ({"action": "SWAP_SELL", "fraction": "0.5"}, SwapSell(fraction=Decimal("0.5"))),
        ({"action": "hold"}, Hold()),
        ({"action": "check_market"}, CheckMarket()),
        (None, Hold()),
    ],
)
def test_plan_action_maps_the_decision_protocol_onto_actions(market, expected):
    plan = plan_action(decision(market))
    assert (plan.action, plan.invalid, plan.forced) == (expected, None, None)


@pytest.mark.parametrize(
    ("market", "note"),
    [
        ({"action": "swap_buy"}, "invalid swap_buy: amount_eth: Field required"),
        ({"action": "swap_buy", "amountEth": "-1"}, "invalid swap_buy: amount_eth"),
        ({"action": "swap_sell", "fraction": "1.5"}, "invalid swap_sell: fraction"),
        ({"action": "moon"}, "unknown market action kind 'moon'"),
    ],
)
def test_plan_action_marks_unreadable_actions_invalid(market, note):
    plan = plan_action(decision(market))
    assert plan.action == Hold() and plan.invalid.startswith(note) and plan.forced is None


def test_plan_action_for_a_market_value_that_parsing_dropped():
    plan = plan_action(decision(None, notes=["market_invalid"]))
    assert (plan.action, plan.invalid) == (Hold(), MARKET_INVALID_NOTE)


@pytest.mark.parametrize("note", ["budget_exhausted", "llm_request_failed", "batch_failed", "missing_decision"])
def test_forced_holds_carry_their_note(note):
    plan = plan_action(decision({"action": "hold"}, notes=[note]))
    assert (plan.action, plan.invalid, plan.forced) == (Hold(), None, note)


def test_placeholder_sentiments_are_not_reported():
    assert reported_sentiment(decision(sentiment=-0.3)) == -0.3
    assert reported_sentiment(decision(notes=["post_clipped"], sentiment=0.2)) == 0.2
    for note in ("missing_decision", "batch_failed", "budget_exhausted", "llm_request_failed",
                 "sentiment_missing", "sentiment_invalid"):  # fmt: skip
        assert reported_sentiment(decision(notes=[note], sentiment=0.0)) is None


# --- swap tape and market panel ---------------------------------------------------------------


def test_swap_tape_follows_the_router_math():
    start = Reserves(token=100_000_000 * WEI, quote=5 * WEI)
    tape = SwapTape(start, 18)
    tokens_out, after_buy = apply_buy(start, WEI // 10, 100)
    before, after = tape.apply("swap_buy", "0.1", format_amount(tokens_out, 18))
    assert before == format_price(start.quote, start.token)
    assert tape.reserves == after_buy and after == format_price(after_buy.quote, after_buy.token)
    eth_out, after_sell = apply_sell(after_buy, 2_000_000 * WEI, 100)
    tape.apply("swap_sell", "2000000", format_amount(eth_out, 18))
    assert tape.reserves == after_sell
    with pytest.raises(ValueError, match="not a swap kind"):
        tape.apply("hold", "0", "0")


def test_percent_change():
    assert percent_change("0.0001", "0.00011") == 10.0
    assert percent_change("0.0002", "0.0001") == -50.0
    assert percent_change("0.0001", "0.0001") == 0.0
    assert percent_change("0", "1") == 0.0
    assert str(percent_change("3", "1")) == "-66.6667"


def test_market_view_from_a_snapshot():
    state = MarketState.from_reserves(
        block_number=12,
        reserve0=110 * WEI,
        reserve1=900_000 * WEI,
        token_is_token0=False,
        holders=["0x" + "11" * 20, "0x" + "22" * 20],
    )
    swap = {"handle": "@quietferret42", "kind": "swap_buy", "amountIn": "0.1",
            "amountOut": "900.5", "priceAfter": state.price}  # fmt: skip
    view = market_view(state, start_price="0.0001", previous_price=state.price, recent_swaps=[swap])
    assert view.price == state.price
    assert view.reserve_eth == "110" and view.reserve_token == "900000"
    assert view.holders == 2
    assert view.change_pct_since_start == percent_change("0.0001", state.price) > 0
    assert view.change_pct_last_round == 0.0
    assert view.recent_swaps == [swap] and view.recent_swaps[0] is not swap


def test_feed_post_keeps_refs_and_counts():
    post = SocialPost("c4", "a02", "@calmotter11", "agree", "p1", 3, 0, 2)
    feed = feed_post(post)
    assert (feed.id, feed.reply_to, feed.likes, feed.round) == ("c4", "p1", 3, 2)
    assert feed.author_handle == "@calmotter11"


# --- run.json assembly ------------------------------------------------------------------------


def test_persona_mix_lists_every_archetype_in_order():
    crowd = generate_crowd(6, {"holder": 4, "skeptic": 2}, seed=1)
    assert persona_mix(crowd) == {"sniper": 0, "holder": 4, "panic_seller": 0, "skeptic": 2}
    assert list(persona_mix(crowd)) == ["sniper", "holder", "panic_seller", "skeptic"]


def test_run_rounds_take_posts_with_final_likes_by_round():
    content = [
        SocialPost("p1", "a01", "@a", "gm", None, 4, 1, 1),
        SocialPost("c1", "a02", "@b", "gm back", "p1", 1, 0, 2),
        SocialPost("p2", "a02", "@b", "later", None, 0, 0, 2),
    ]
    assert {n: [p.ref for p in group] for n, group in posts_by_round(content).items()} == {
        1: ["p1"],
        2: ["c1", "p2"],
    }
    market = {"price": "1", "reserve0": "1", "reserve1": "1", "holders": 0}
    records = [RoundRecord(n, [], [], market, {}, []) for n in (1, 2, 3)]
    rounds = run_rounds(records, content)
    assert [len(r["posts"]) for r in rounds] == [1, 2, 0]
    assert rounds[0]["posts"][0] == {"id": "p1", "agentId": "a01", "text": "gm", "replyTo": None, "likes": 4}
    assert rounds[1]["posts"][0]["replyTo"] == "p1"


# --- events.jsonl -----------------------------------------------------------------------------


def test_event_log_appends_flushed_lines_and_closes(tmp_path: Path):
    log = EventLog(tmp_path / "events.jsonl")
    log.write("round_started", round=1, text="café \U0001f680", amount=Decimal("0.5"))
    assert read_events(tmp_path / "events.jsonl")[0]["round"] == 1  # flushed while still open
    log.write("round_finished", round=1)
    log.close()
    log.close()  # idempotent
    assert log.closed
    lines = read_events(tmp_path / "events.jsonl")
    assert [line["event"] for line in lines] == ["round_started", "round_finished"]
    assert lines[0]["text"] == "café \U0001f680" and lines[0]["amount"] == "0.5"
    assert lines[0]["ts"].endswith("Z")
    with pytest.raises(ValueError, match="closed"):
        log.write("late")
    (tmp_path / "events.jsonl").unlink()  # the file is not held open
