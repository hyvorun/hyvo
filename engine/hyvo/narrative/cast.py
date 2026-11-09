"""Swarm Cast (SPEC §10): a short post thread from a run's report, for X and Farcaster. Text only, and posting it is by hand.

Every line comes from the run itself, so it costs no allowance and has nothing to invent. A post that would break the copy
rules is left out, and the last post always carries the link, the hash and the disclaimer.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from hyvo.report.guard import REMOVED_TEXT, find_violations
from hyvo.runfile import DISCLAIMER

MAX_CHARS = 280
DEFAULT_SITE = "https://hyvo.run"


def _shorten(text: str, limit: int) -> str:
    """Cut at the end of a sentence if one fits, else at a word."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    head = text[: limit - 1]
    for stop in (". ", "! ", "? "):
        at = head.rfind(stop)
        if at >= limit // 2:
            return head[: at + 1]
    return head.rsplit(" ", 1)[0].rstrip(",;:") + "…"


def _change(run: Mapping[str, Any]) -> str | None:
    rounds = run["rounds"]
    if not rounds:
        return None
    try:
        start = Decimal(run["world"]["initialMarket"]["price"])
        end = Decimal(rounds[-1]["market"]["price"])
    except (InvalidOperation, KeyError, TypeError):
        return None
    if start <= 0:
        return None
    return f"{(end - start) / start * 100:+.1f}%"


def build_thread(run: Mapping[str, Any], site: str = DEFAULT_SITE) -> list[str]:
    """The posts, in order. Each fits in ``MAX_CHARS``."""
    report = run["report"]
    crowd = run["crowd"]
    symbol = run["world"]["token"]["symbol"]
    posts_total = sum(len(item["posts"]) for item in run["rounds"])
    swaps_total = sum(1 for item in run["rounds"] for action in item["actions"] if action["kind"] in ("swap_buy", "swap_sell") and action["status"] == "ok")

    thread = [
        f"{_shorten(run['scenario']['title'], 150)}\n\n"
        f"A synthetic crowd of {crowd['size']} AI trader agents played this for {len(run['rounds'])} rounds on a private test market. None of it is real trading."
    ]
    change = _change(run)
    tally = f"{posts_total} posts and {swaps_total} swaps"
    thread.append(f"In the simulation, the test market for {symbol} went {change} over {tally}." if change else f"The simulation had {tally}.")
    summary = report.get("summary", "")
    if summary and summary != REMOVED_TEXT:
        thread.append(_shorten(summary, MAX_CHARS))
    turning = report.get("turningPoint")
    if turning and turning.get("why") and turning["why"] != REMOVED_TEXT:
        thread.append(_shorten(f"The turning point came in round {turning['round']}: {turning['why']}", MAX_CHARS))
    objections = [item for item in report.get("objections", []) if item != REMOVED_TEXT]
    if objections:
        thread.append(_shorten(f"The crowd's main objection: {objections[0]}", MAX_CHARS))

    kept = [post for post in thread if not find_violations(post)]
    link = f"{site.rstrip('/')}/run/{run['runId']}"
    closing = f"Replay every post and swap: {link}\nHash on Robinhood Chain: {run['hash'][:18]}…\n\n{DISCLAIMER}"
    return [*kept, closing]


def write_thread(run_path: Path, out_dir: Path | None = None, site: str = DEFAULT_SITE) -> Path:
    """Write ``thread.md`` and ``thread.json`` next to the run or in ``out_dir``; returns the Markdown file."""
    run = json.loads(run_path.read_text(encoding="utf-8"))
    thread = build_thread(run, site)
    folder = out_dir or run_path.parent
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "thread.json").write_text(json.dumps({"runId": run["runId"], "posts": thread}, indent=1, ensure_ascii=False), encoding="utf-8", newline="\n")
    path = folder / "thread.md"
    path.write_text("\n\n---\n\n".join(thread) + "\n", encoding="utf-8", newline="\n")
    return path
