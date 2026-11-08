"""``llm-log.jsonl``: one JSON line per LLM call or refused call, for replaying a run.

Each line: ``ts, purpose, model, temperature, max_tokens, json_mode, messages, response_text,
input_tokens, output_tokens, estimated_tokens, cost_usd, latency_ms, finish_reason, error``.
A refused call has ``error = "budget_exceeded: <reason>"`` and nothing was sent. The log holds
prompts and answers only; API keys and other settings are never written.
"""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

from .types import ChatMessage, LLMResult

LLM_LOG_NAME = "llm-log.jsonl"


class LLMLog:
    """Append-only, thread-safe JSONL writer."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def write(
        self,
        *,
        purpose: str,
        model: str,
        messages: Sequence[ChatMessage],
        temperature: float,
        max_tokens: int,
        json_mode: bool,
        result: LLMResult | None = None,
        error: str | None = None,
    ) -> None:
        """Append one line. ``result`` is None when nothing came back (refused or failed)."""
        record = {
            "ts": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "purpose": purpose,
            "model": model,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "json_mode": json_mode,
            "messages": [m.to_dict() for m in messages],
            "response_text": result.text if result else None,
            "input_tokens": result.input_tokens if result else 0,
            "output_tokens": result.output_tokens if result else 0,
            "estimated_tokens": result.estimated_tokens if result else False,
            "cost_usd": result.cost_usd if result else 0.0,
            "latency_ms": result.latency_ms if result else None,
            "finish_reason": result.finish_reason if result else None,
            "error": error,
        }
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        with self._lock, self.path.open("a", encoding="utf-8", newline="\n") as fh:
            fh.write(line + "\n")
