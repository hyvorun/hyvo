"""``events.jsonl``: the engine's own event log of a run (docs/RUN_FORMAT.md, companion files).

One JSON object per line: ``{"ts": "...Z", "event": "<name>", ...fields}``. Lines are flushed as
they are written, so a crashed run keeps its log. Events (fields in camelCase):

- ``run_started``: runId, seed, the resolved parameters, models, offline
- ``world_ready``: anvil (pid, port, forked, forkBlock), market addresses, the initial market
- ``round_started`` / ``round_finished``: the round, its injected events, the market, counts
- ``batch``: one decision call: agents, batch notes, LLM error if any, every parsed decision
- ``budget_exhausted``, ``llm_request_failed``: why agents were forced to hold
- ``social_rejected``: a post, reply or like that failed validation (never sent to OASIS)
- ``action``: every market action except a plain hold (swaps with txHash and status, checks,
  invalid actions with the reason)
- ``stopped``: why the run stopped before its last round (budget or timeout)
- ``report``: whether the model wrote the prose, the builder's notes, the copy-guard flags
- ``run_finished`` / ``run_failed`` and ``teardown``

The log never holds settings or secrets; prompts and answers live in ``llm-log.jsonl``.
"""

from __future__ import annotations

import json
import os
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import IO, Any

EVENTS_LOG_NAME = "events.jsonl"


class EventLog:
    """Append-only, thread-safe JSONL writer. Close it when the run ends (Windows keeps an open
    file from being deleted)."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._file: IO[str] | None = self.path.open("a", encoding="utf-8", newline="\n")

    def write(self, event: str, **fields: Any) -> None:
        record = {"ts": _now(), "event": event, **fields}
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":"), default=str)
        with self._lock:
            if self._file is None:
                raise ValueError("the event log is closed")
            self._file.write(line + "\n")
            self._file.flush()

    def close(self) -> None:
        with self._lock:
            if self._file is not None:
                self._file.close()
                self._file = None

    @property
    def closed(self) -> bool:
        return self._file is None


def read_events(path: str | os.PathLike[str]) -> list[dict[str, Any]]:
    """Parse an ``events.jsonl`` file (for tests and tooling)."""
    text = Path(path).read_text(encoding="utf-8")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
