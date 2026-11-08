"""What flows through a run: injected events reach the prompts of their round, replies and likes
reach run.json, a check_market choice puts the detailed market into the next prompt, market
actions follow a seeded order, and events.jsonl records the run."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from simkit import (
    actions,
    call_lines,
    check_written_run,
    decision_data,
    events,
    offline_settings,
    posts,
    sim_config,
    write_scenario,
)

from hyvo.decisions.prompt import rows
from hyvo.sim import run_simulation

pytestmark = [pytest.mark.anvil, pytest.mark.oasis, pytest.mark.slow]

EVENT_2 = "Rumor: the lighthouse wallet moved 20% of FERN to an exchange deposit address."
EVENT_3 = "The team posts an audit of the FERN pool and locks its liquidity for a year."
AGENTS = 16


@pytest.fixture(autouse=True)
def _oasis_logs_in_tmp(oasis_module: ModuleType) -> None:
    """Import OASIS through the session fixture, so its log file lands in a temp dir."""


@pytest.fixture(scope="module")
def played(tmp_path_factory: pytest.TempPathFactory, oasis_module: ModuleType) -> dict[str, Any]:
    tmp = tmp_path_factory.mktemp("flow")
    scenario = write_scenario(tmp, {2: EVENT_2, 3: EVENT_3})
    outcome = run_simulation(
        sim_config(scenario, tmp / "runs", agents=AGENTS, rounds=4, seed=21), offline_settings()
    )
    doc = check_written_run(outcome.path, agents=AGENTS)
    prompts: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for line in call_lines(outcome.run_dir):
        if line["purpose"] == "agents":
            data = decision_data(line)
            prompts[data["round"]].append({"data": data, "messages": line["messages"]})
    return {"outcome": outcome, "doc": doc, "prompts": prompts, "events": events(outcome.run_dir)}


def test_injected_events_reach_the_prompts_of_their_round(played: dict[str, Any]) -> None:
    prompts = played["prompts"]
    assert sorted(prompts) == [1, 2, 3, 4]
    for prompt in prompts[1]:
        assert prompt["data"]["eventsNow"] == [] and prompt["data"]["eventsEarlier"] == []
        assert "lighthouse" not in prompt["messages"][1]["content"]
    for prompt in prompts[2]:
        assert prompt["data"]["eventsNow"] == [EVENT_2]
        assert EVENT_2 in prompt["messages"][1]["content"]  # in the readable prompt too
    for prompt in prompts[3]:
        assert prompt["data"]["eventsNow"] == [EVENT_3]
        assert prompt["data"]["eventsEarlier"] == [[2, EVENT_2]]
    for prompt in prompts[4]:
        assert prompt["data"]["eventsNow"] == []
        assert prompt["data"]["eventsEarlier"] == [[2, EVENT_2], [3, EVENT_3]]
    doc = played["doc"]
    assert doc["scenario"]["injectedEvents"] == [
        {"round": 2, "text": EVENT_2},
        {"round": 3, "text": EVENT_3},
    ]
    started = [e for e in played["events"] if e["event"] == "round_started"]
    assert [e["injectedEvents"] for e in started] == [[], [EVENT_2], [EVENT_3], []]


def test_every_agent_is_decided_once_per_round_in_batches(played: dict[str, Any]) -> None:
    for prompts in played["prompts"].values():
        ids = [row["agentId"] for p in prompts for row in rows(p["data"], "agents")]
        assert sorted(ids) == sorted(a["agentId"] for a in played["doc"]["crowd"]["agents"])
        assert [len(rows(p["data"], "agents")) for p in prompts] == [4, 4, 4, 4]


def test_replies_and_likes_appear_in_run_json(played: dict[str, Any]) -> None:
    doc = played["doc"]
    all_posts = posts(doc)
    replies = [post for post in all_posts if post["replyTo"] is not None]
    assert replies and all(post["id"].startswith("c") for post in replies)
    assert all(post["id"].startswith("p") for post in all_posts if post["replyTo"] is None)
    assert sum(post["likes"] for post in all_posts) > 0
    # Likes are final: a post's count matches the likes recorded for it in the database world.
    seen: set[str] = set()
    for post in all_posts:
        if post["replyTo"] is not None:
            # the post or reply the agent answered, always an earlier one
            assert post["replyTo"] in seen
        seen.add(post["id"])
    # The feed shown in later rounds carries those posts with their like counts.
    feed_ids = {row["id"] for p in played["prompts"][4] for row in rows(p["data"], "posts")}
    assert feed_ids <= seen


def _thread_root(post: dict[str, Any], by_id: dict[str, dict[str, Any]]) -> str:
    while post["replyTo"] is not None:
        post = by_id[post["replyTo"]]
    return post["id"]


def test_cards_list_own_posts_and_replies_to_the_agent(played: dict[str, Any]) -> None:
    doc, prompts = played["doc"], played["prompts"]
    replied_any = False
    for n in (2, 3, 4):
        earlier = [post for rnd in doc["rounds"][: n - 1] for post in rnd["posts"]]
        by_id = {post["id"]: post for post in earlier}
        for row in (row for p in prompts[n] for row in rows(p["data"], "agents")):
            agent = row["agentId"]
            newest_first = [post["id"] for post in reversed(earlier) if post["agentId"] == agent]
            assert row["ownPosts"] == newest_first[:3]  # SocialWorld.posts_by order
            for ref in row["repliesToMe"]:
                replied_any = True
                reply = by_id[ref]
                assert ref.startswith("c") and reply["agentId"] != agent
                # OASIS threads are flat: the reply sits in the thread of a post the agent wrote
                # or replied in (replyTo may name a reply, so follow it to the thread's post).
                root = _thread_root(reply, by_id)
                thread = [p for p in earlier if _thread_root(p, by_id) == root]
                assert any(p["agentId"] == agent for p in thread)
    assert replied_any


def test_check_market_adds_the_detailed_market_to_the_next_prompt(played: dict[str, Any]) -> None:
    doc, prompts = played["doc"], played["prompts"]
    checked_any = False
    for index, rnd in enumerate(doc["rounds"][:-1]):
        checkers = {a["agentId"] for a in rnd["actions"] if a["kind"] == "check_market"}
        detailed = {
            row["agentId"]: row["detailedMarket"]
            for p in prompts[index + 2]
            for row in rows(p["data"], "agents")
        }
        assert {agent for agent, d in detailed.items() if d is not None} == checkers
        for agent in checkers:
            checked_any = True
            market = detailed[agent]
            assert set(market) >= {"block", "price_eth_per_token", "reserve_eth", "holders"}
            # It is the market the next round was decided on.
            assert market["price_eth_per_token"] == rnd["market"]["price"]
    assert checked_any, "no agent chose check_market in this run; pick another seed"


def test_market_panel_reports_price_changes_and_recent_swaps(played: dict[str, Any]) -> None:
    doc, prompts = played["doc"], played["prompts"]
    for n in (2, 3, 4):
        market = prompts[n][0]["data"]["market"]
        assert market["price"] == doc["rounds"][n - 2]["market"]["price"]
        swaps = rows(prompts[n][0]["data"], "swaps")
        executed = [a for rnd in doc["rounds"][: n - 1] for a in rnd["actions"]
                    if a["status"] == "ok" and a["kind"] in ("swap_buy", "swap_sell")]  # fmt: skip
        assert len(swaps) == min(6, len(executed))
        if executed:
            last = executed[-1]
            assert (swaps[-1]["kind"], swaps[-1]["amountIn"]) == (last["kind"], last["amountIn"])


def test_events_log_records_the_run(played: dict[str, Any]) -> None:
    log, doc, outcome = played["events"], played["doc"], played["outcome"]
    names = [e["event"] for e in log]
    assert names[0] == "run_started" and names[1] == "world_ready"
    assert names[-3:] == ["report", "run_finished", "teardown"]
    assert names.count("round_started") == names.count("round_finished") == 4
    assert names.count("batch") == 4 * 4
    started = log[0]
    assert started["runId"] == doc["runId"] and started["seed"] == 21 == outcome.seed
    for batch in (e for e in log if e["event"] == "batch"):
        assert batch["outcome"] == "ok"
        assert [d["agentId"] for d in batch["decisions"]] == batch["agents"]
    sent = [e for e in log if e["event"] == "action"]
    swaps = [a for a in actions(doc) if a["kind"] in ("swap_buy", "swap_sell")]
    assert len([e for e in sent if e["kind"] in ("swap_buy", "swap_sell")]) == len(swaps)
    assert {e["txHash"] for e in sent if e["txHash"]} == {a["txHash"] for a in swaps}
    finished = log[-2]
    assert finished["hash"] == doc["hash"] and finished["status"] == "complete"
    for rejected in (e for e in log if e["event"] == "social_rejected"):
        assert rejected["action"] in ("post", "reply", "like") and rejected["reason"]


def test_same_seed_same_run(tmp_path: Path, played: dict[str, Any]) -> None:
    """Offline runs are reproducible: the same seed gives the same crowd, decisions, posts and
    execution order (only ids, timestamps and transaction hashes may differ)."""
    first = played["doc"]
    scenario = write_scenario(tmp_path, {2: EVENT_2, 3: EVENT_3})
    again = run_simulation(
        sim_config(scenario, tmp_path / "runs", agents=AGENTS, rounds=4, seed=21),
        offline_settings(),
    )
    second = check_written_run(again.path, agents=AGENTS)

    def comparable(doc: dict[str, Any]) -> list[Any]:
        return [
            [
                [(p["id"], p["agentId"], p["text"], p["replyTo"], p["likes"]) for p in rnd["posts"]],
                [{k: v for k, v in a.items() if k != "txHash"} for a in rnd["actions"]],
                rnd["market"],
            ]
            for rnd in doc["rounds"]
        ]

    assert second["crowd"] == first["crowd"]
    assert comparable(second) == comparable(first)
    assert second["report"] == first["report"]
    # Market actions run in a seeded shuffle of the crowd, not in agent order.
    order = [a["agentId"] for a in first["rounds"][0]["actions"]]
    assert order != sorted(order)
    assert order != [a["agentId"] for a in first["rounds"][1]["actions"]]
