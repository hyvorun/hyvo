"""A line is said once in a run, by anyone. Cheap models copy the posts they are shown and give two
agents of a batch the same words, and the engine keeps the feed from filling up with them; the rest
of the decision still counts."""

from __future__ import annotations

import dataclasses
import json
from collections.abc import Sequence
from pathlib import Path
from types import ModuleType

import pytest
from simkit import (
    actions,
    check_written_run,
    events,
    offline_settings,
    posts,
    sim_config,
    write_scenario,
)

from hyvo.llm.offline import OfflineClient
from hyvo.llm.protocol import find_protocol
from hyvo.llm.types import ChatMessage, LLMResult, Prices
from hyvo.report.guard import REMOVED_TEXT
from hyvo.report.review import REVIEW_PROTOCOL
from hyvo.sim import run_simulation

pytestmark = [pytest.mark.anvil, pytest.mark.oasis, pytest.mark.slow]

LINE = "Still watching this pool."
AGENTS = 12


@pytest.fixture(autouse=True)
def _oasis_logs_in_tmp(oasis_module: ModuleType) -> None:
    """Import OASIS through the session fixture, so its log file lands in a temp dir."""


class CopyingClient:
    """The offline model, with every post rewritten to the same line. Even calls shout it, because
    a change of case is not something new to say."""

    model_label = "test/copying"
    prices = Prices(0.0, 0.0)

    def __init__(self, seed: int) -> None:
        self.inner = OfflineClient(seed)
        self.calls = 0

    def complete(
        self,
        messages: Sequence[ChatMessage],
        *,
        temperature: float,
        max_tokens: int,
        json_mode: bool,
        purpose: str,
    ) -> LLMResult:
        result = self.inner.complete(
            messages,
            temperature=temperature,
            max_tokens=max_tokens,
            json_mode=json_mode,
            purpose=purpose,
        )
        if purpose != "agents":
            return result
        self.calls += 1
        line = LINE.upper() if self.calls % 2 == 0 else LINE
        answer = json.loads(result.text)
        for decision in answer["decisions"]:
            if decision.get("post"):
                decision["post"]["text"] = line
        return dataclasses.replace(result, text=json.dumps(answer))


class FlaggingClient(CopyingClient):
    """A review that flags the first post."""

    def complete(self, messages: Sequence[ChatMessage], **kwargs: object) -> LLMResult:
        result = self.inner.complete(messages, **kwargs)
        if find_protocol(messages) == REVIEW_PROTOCOL:
            return dataclasses.replace(result, text=json.dumps({"flagged": ["p1"]}))
        return result


def test_a_post_the_review_flags_is_removed_before_the_run_is_hashed(tmp_path: Path) -> None:
    scenario = write_scenario(tmp_path)
    client = FlaggingClient(22)
    outcome = run_simulation(
        sim_config(scenario, tmp_path / "runs", agents=AGENTS, rounds=5, seed=22),
        offline_settings(),
        clients=(client, client),
    )
    doc = check_written_run(outcome.path, agents=AGENTS)  # the hash covers the removal, and replies keep their parent
    said = {post["id"]: post["text"] for post in posts(doc)}
    assert said["p1"] == REMOVED_TEXT
    assert sum(text == REMOVED_TEXT for text in said.values()) == 1
    assert doc["report"]["flags"] == ["posts_removed:1"]
    assert [event["flagged"] for event in events(outcome.run_dir) if event["event"] == "post_review"] == [["p1"]]


def test_a_line_is_said_once_and_every_decision_still_counts(tmp_path: Path) -> None:
    scenario = write_scenario(tmp_path)
    client = CopyingClient(21)
    outcome = run_simulation(
        sim_config(scenario, tmp_path / "runs", agents=AGENTS, rounds=5, seed=21),
        offline_settings(),
        clients=(client, client),
    )

    doc = check_written_run(outcome.path, agents=AGENTS)  # every agent still acts in every round
    said = posts(doc)
    assert len(said) == 1, [post["text"] for post in said]
    assert said[0]["text"].lower() == LINE.lower()

    dropped = [event for event in events(outcome.run_dir) if event["event"] == "post_repeat_dropped"]
    assert len({event["agentId"] for event in dropped}) > 1, "nobody else tried: the test tested nothing"
    assert len({event["round"] for event in dropped}) > 1, "and it holds across rounds"
    # What those agents did on the market is untouched.
    assert len(actions(doc)) == AGENTS * 5
    assert any(action["kind"].startswith("swap") for action in actions(doc))
