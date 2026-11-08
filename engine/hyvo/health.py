"""Liveness files. A long-running loop (the runner, the daily run) touches its file as it goes, and
``hyvo health`` says whether the file is fresh, so that a container's health check can restart a loop that
has hung, not only one that has died."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path


def touch(path: Path, state: str = "ok") -> None:
    """Record that the loop is alive. It never stops the loop: a full disk must not end a run."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps({"at": time.time(), "state": state}), encoding="utf-8")
        os.replace(temporary, path)
    except OSError:
        pass


def check(path: Path, max_age_s: float, *, now: float | None = None) -> tuple[bool, str]:
    """``(healthy, what to say)``: healthy when the file was touched within ``max_age_s``."""
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
        at = float(record["at"])
        state = str(record.get("state", ""))
    except (OSError, ValueError, KeyError, TypeError):
        return False, f"no health record at {path}"
    age = (time.time() if now is None else now) - at
    if age > max_age_s:
        return False, f"stale: last seen {age:.0f} s ago ({state})"
    return True, f"healthy: last seen {max(age, 0):.0f} s ago ({state})"
