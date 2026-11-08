"""Helpers for the simulation-loop tests: scenarios, offline settings, priced clients, and the
checks every written run must pass. Imported by the test modules next to it (tests/sim has no
package ``__init__``, so pytest puts this directory on ``sys.path``)."""

from __future__ import annotations

import dataclasses
import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import psutil

from hyvo.config import Settings
from hyvo.llm.log import LLM_LOG_NAME
from hyvo.llm.offline import OfflineClient
from hyvo.llm.pricing import cost_usd
from hyvo.llm.types import ChatMessage, LLMResult, Prices
from hyvo.report.guard import find_violations, prose_fields
from hyvo.report.prompt import extract_data
from hyvo.runfile import DISCLAIMER, RunV1, load_run, validate_json_schema, verify_run
from hyvo.sim.config import SimConfig
from hyvo.sim.events import EVENTS_LOG_NAME, read_events
from hyvo.world.verify import check_run_market

ENGINE_ROOT = Path(__file__).resolve().parents[2]
EXAMPLE_SCENARIO = ENGINE_ROOT / "examples" / "scenarios" / "pons-creator-tax.md"

SEED_TEXT = (
    "FERN is a fictional token made up for this test. It has just launched on a thin pool with a "
    "1% fee. The team is anonymous and the roadmap says 'soon'. Early chatter is split between "
    "wallets excited about a fast start and wallets asking who holds the supply."
)


def offline_settings() -> Settings:
    """No LLM key and no RPC: the offline rules model and a plain local anvil."""
    return Settings()


def write_scenario(
    directory: Path,
    events: Mapping[int, str] | None = None,
    *,
    title: str = "Fictional token FERN lists on a thin pool",
    name: str = "scenario.md",
) -> Path:
    lines = [
        "---",
        f"title: {title}",
        "token_symbol: FERN",
        "liquidity_eth: 5",
        "liquidity_tokens: 100000000",
        "fee_bps: 100",
        "---",
        "",
        SEED_TEXT,
        "",
    ]
    if events:
        lines += ["## Events", ""]
        lines += [f"- round {n}: {text}" for n, text in sorted(events.items())]
    path = directory / name
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def sim_config(scenario: Path, runs_dir: Path, **overrides: Any) -> SimConfig:
    values: dict[str, Any] = {
        "scenario": scenario,
        "agents": 12,
        "rounds": 3,
        "batch_size": 4,
        "offline": True,
        "fork": False,
        "seed": 5,
        "runs_dir": runs_dir,
    }
    values.update(overrides)
    return SimConfig(**values)


# --- logs -------------------------------------------------------------------------------------


def llm_lines(run_dir: Path) -> list[dict[str, Any]]:
    text = (run_dir / LLM_LOG_NAME).read_text(encoding="utf-8")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def call_lines(run_dir: Path) -> list[dict[str, Any]]:
    """Lines of calls that were sent (a refused call is logged with error budget_exceeded)."""
    return [
        line
        for line in llm_lines(run_dir)
        if not str(line.get("error") or "").startswith("budget_exceeded")
    ]


def events(run_dir: Path) -> list[dict[str, Any]]:
    return read_events(run_dir / EVENTS_LOG_NAME)


def decision_data(line: Mapping[str, Any]) -> dict[str, Any]:
    """The DATA block of an agents call in llm-log.jsonl."""
    messages = [ChatMessage(m["role"], m["content"]) for m in line["messages"]]
    return extract_data(messages)


# --- processes --------------------------------------------------------------------------------


def anvil_pids() -> set[int]:
    """anvil processes descended from this test process. Other anvil processes on the machine
    (a developer's own run, a parallel suite) are ignored, so they cannot fail a leftover check;
    runs in a subprocess are checked through the pid their events.jsonl records."""
    pids = set()
    for process in psutil.Process().children(recursive=True):
        try:
            name = process.name().lower()
        except psutil.Error:  # exited while we looked
            continue
        if name == "anvil" or name.startswith("anvil."):
            pids.add(process.pid)
    return pids


def anvil_alive(pid: int) -> bool:
    """Whether ``pid`` is a running anvil process (any parent)."""
    try:
        name = psutil.Process(pid).name().lower()
    except psutil.Error:
        return False
    return name == "anvil" or name.startswith("anvil.")


# --- clients ----------------------------------------------------------------------------------


class PricedOfflineClient:
    """The offline rules model, billed at ``prices`` for its (estimated) token counts."""

    model_label = "test/priced-offline"

    def __init__(self, seed: int, prices: Prices) -> None:
        self.inner = OfflineClient(seed)
        self.prices = prices

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
        cost = cost_usd(self.prices, result.input_tokens, result.output_tokens)
        return dataclasses.replace(result, model=self.model_label, cost_usd=cost)


# --- checks -----------------------------------------------------------------------------------


def check_written_run(path: Path, *, agents: int) -> dict[str, Any]:
    """The checks every run must pass; returns the parsed document.

    run.json validates with pydantic and the JSON Schema, its hash verifies, the price replay
    finds no mismatch, every round has exactly one action per agent, the report carries the exact
    disclaimer and no prose breaks a copy rule, and usage.llmCalls equals the call lines of
    llm-log.jsonl.
    """
    doc = load_run(path)
    RunV1.model_validate(doc)
    assert validate_json_schema(doc) == []
    result = verify_run(path)
    assert result.ok, (result.model_errors, result.schema_errors)
    assert result.expected == result.actual == doc["hash"]
    assert check_run_market(doc) == []
    agent_ids = sorted(agent["agentId"] for agent in doc["crowd"]["agents"])
    assert len(agent_ids) == agents
    for rnd in doc["rounds"]:
        assert sorted(action["agentId"] for action in rnd["actions"]) == agent_ids
    report = doc["report"]
    assert report["disclaimer"] == DISCLAIMER
    assert report["summary"].strip()
    assert len(report["sentimentByRound"]) == len(doc["rounds"])
    for field, text in prose_fields(report).items():
        assert find_violations(text) == [], (field, text)
    assert doc["usage"]["llmCalls"] == len(call_lines(path.parent))
    return doc


def actions(doc: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [action for rnd in doc["rounds"] for action in rnd["actions"]]


def posts(doc: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [post for rnd in doc["rounds"] for post in rnd["posts"]]
