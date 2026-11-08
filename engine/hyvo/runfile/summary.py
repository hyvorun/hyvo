"""What the runner reports about a verified run: the gallery summary, hashes and usage.

On the Workers Free plan the API cannot parse or re-hash a run within its CPU limit, so it takes
these from the runner, which verifies every run before it uploads it (docs/OPEN_ITEMS.md item 21).
``summarize_run`` mirrors ``summarizeRun`` in ``packages/schema/src/summary.ts``; the shared vectors
``packages/schema/test-vectors/*.summary.json`` hold the two to the same output.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Mapping
from typing import Any

from .canonical import scenario_hash

SUMMARY_CHARS = 280
_SWAPS = frozenset({"swap_buy", "swap_sell"})


def summarize_run(run: Mapping[str, Any]) -> dict[str, Any]:
    """The ``DerivedRunSummary`` of a valid run (docs/API.md, ``RunSummary``)."""
    prices = [run["world"]["initialMarket"]["price"], *(r["market"]["price"] for r in run["rounds"])]
    start = float(prices[0])
    end = float(prices[-1])
    report = run["report"]
    turning_point = report.get("turningPoint")
    swaps = sum(
        1
        for round_ in run["rounds"]
        for action in round_["actions"]
        if action["status"] == "ok" and action["kind"] in _SWAPS
    )
    question = run.get("question")
    return {
        "runId": run["runId"],
        "title": run["scenario"]["title"],
        "createdAt": run["createdAt"],
        "status": run["status"],
        "stopReason": run["stopReason"],
        "crowdSize": run["crowd"]["size"],
        "rounds": len(run["rounds"]),
        "personaMix": dict(run["crowd"]["personaMix"]),
        "models": {"agents": run["crowd"]["model"]["agents"], "report": run["crowd"]["model"]["report"]},
        "hash": run["hash"],
        "market": {
            "symbol": run["world"]["token"]["symbol"],
            "priceStart": prices[0],
            "priceEnd": prices[-1],
            "priceChangePct": _round2((end - start) / start * 100) if start > 0 else 0,
            "swaps": swaps,
            "posts": sum(len(round_["posts"]) for round_ in run["rounds"]),
        },
        "sparkline": [float(price) for price in prices],
        "turningPointRound": turning_point["round"] if turning_point else None,
        "summary": clip_code_points(report["summary"], SUMMARY_CHARS),
        **(
            {
                "question": {
                    "text": question["text"],
                    "resolvesAt": question["resolvesAt"],
                    "expectation": question["expectation"],
                    **question["answers"],
                }
            }
            if question
            else {}
        ),
    }


def run_meta(run: Mapping[str, Any], data: bytes) -> dict[str, Any]:
    """The ``RunMeta`` for ``complete``: ``data`` is the exact bytes uploaded for ``run``."""
    return {
        "hash": run["hash"],
        "scenarioHash": scenario_hash(run["scenario"]),
        "sha256": hashlib.sha256(data).hexdigest(),
        "summary": summarize_run(run),
        "usage": {"costUsd": run["usage"]["costUsd"], "llmCalls": run["usage"]["llmCalls"]},
        "eventRounds": [event["round"] for event in run["scenario"]["injectedEvents"]],
    }


def clip_code_points(text: str, limit: int) -> str:
    """At most ``limit`` code points; a cut text ends with an ellipsis (counted in the limit)."""
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "\N{HORIZONTAL ELLIPSIS}"


def _round2(value: float) -> float:
    # JavaScript's Math.round: halves go up, also below zero.
    return math.floor(value * 100 + 0.5) / 100
