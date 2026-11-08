"""The real model path end to end: ``OpenAICompatClient`` (OpenAI SDK, JSON mode, usage capture)
talking to an ``httpx.MockTransport`` endpoint. The endpoint answers every request with the
registered offline responders and reports provider-style token usage, which run.json must record
exactly. No network."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from types import ModuleType
from typing import Any

import httpx
import pytest
from simkit import (
    anvil_pids,
    call_lines,
    check_written_run,
    offline_settings,
    sim_config,
    write_scenario,
)

from hyvo.llm.offline import OfflineClient
from hyvo.llm.openai_compat import OpenAICompatClient
from hyvo.llm.pricing import cost_usd
from hyvo.llm.types import ChatMessage, Prices
from hyvo.sim import run_simulation

pytestmark = [pytest.mark.anvil, pytest.mark.oasis, pytest.mark.slow]

BASE_URL = "https://api.deepseek.com/v1"
MODEL = "deepseek-flash"
PRICES = Prices(0.30, 1.20)
API_KEY = "sk-test-not-a-real-key"


@pytest.fixture(autouse=True)
def _oasis_logs_in_tmp(oasis_module: ModuleType) -> None:
    """Import OASIS through the session fixture, so its log file lands in a temp dir."""


class OfflineProvider:
    """An OpenAI-compatible endpoint backed by the offline responders. Each answer reports a
    distinct usage (``prompt_tokens`` 1000 + i, ``completion_tokens`` 200 + i)."""

    def __init__(self, seed: int = 9) -> None:
        self.offline = OfflineClient(seed)
        self.lock = threading.Lock()
        self.requests: list[dict[str, Any]] = []
        self.usage: list[tuple[int, int]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert request.headers["authorization"] == f"Bearer {API_KEY}"
        messages = [ChatMessage(m["role"], m["content"]) for m in body["messages"]]
        answer = self.offline.complete(
            messages,
            temperature=body.get("temperature", 0.0),
            max_tokens=body["max_tokens"],
            json_mode=True,
            purpose="agents",
        )
        with self.lock:
            index = len(self.requests)
            self.requests.append(body)
            usage = (1000 + index, 200 + index)
            self.usage.append(usage)
        return httpx.Response(
            200,
            json={
                "id": f"chatcmpl-{index}",
                "object": "chat.completion",
                "created": 0,
                "model": MODEL,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": answer.text},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": usage[0],
                    "completion_tokens": usage[1],
                    "total_tokens": sum(usage),
                },
            },
        )

    def client(self) -> OpenAICompatClient:
        return OpenAICompatClient(
            API_KEY,
            BASE_URL,
            MODEL,
            *PRICES,
            max_retries=0,
            http_client=httpx.Client(transport=httpx.MockTransport(self)),
        )


def test_openai_compatible_client_path_records_provider_usage(tmp_path: Path) -> None:
    before = anvil_pids()
    provider = OfflineProvider()
    client = provider.client()
    outcome = run_simulation(
        sim_config(write_scenario(tmp_path), tmp_path / "runs", agents=6, rounds=2, batch_size=3),
        offline_settings(),
        clients=(client, client),
    )
    assert outcome.status == "complete" and not outcome.offline
    doc = check_written_run(outcome.path, agents=6)

    assert doc["crowd"]["model"] == {
        "agents": "deepseek/deepseek-flash",
        "report": "deepseek/deepseek-flash",
        "temperature": 0.8,
    }
    calls = len(provider.requests)
    assert calls >= 2 * 2 + 1  # two batches per round, and the report
    assert doc["usage"] == {
        "llmCalls": calls,
        "inputTokens": sum(u[0] for u in provider.usage),
        "outputTokens": sum(u[1] for u in provider.usage),
        "costUsd": round(sum(cost_usd(PRICES, *u) for u in provider.usage), 6),
    }
    assert doc["usage"]["costUsd"] > 0

    # Requests carry the model, JSON mode and the DeepSeek thinking switch; agent calls use the
    # run temperature, report calls the report's.
    agents = [r for r in provider.requests if r["temperature"] == 0.8]
    assert len(agents) == 4
    assert all(r["model"] == MODEL for r in provider.requests)
    assert all(r["response_format"] == {"type": "json_object"} for r in provider.requests)
    assert all(r["thinking"] == {"type": "disabled"} for r in provider.requests)
    # llm-log.jsonl holds the provider's numbers, not estimates.
    logged = call_lines(outcome.run_dir)
    assert sorted((line["input_tokens"], line["output_tokens"]) for line in logged) == sorted(provider.usage)
    assert not any(line["estimated_tokens"] for line in logged)
    assert API_KEY not in (outcome.run_dir / "llm-log.jsonl").read_text(encoding="utf-8")
    assert not (anvil_pids() - before)
