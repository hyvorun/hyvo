"""The golden run (fixtures/golden-run.json) verifies on the Python side."""

from __future__ import annotations

import json
from pathlib import Path

from hyvo.runfile import hash_run, verify_run
from hyvo.world.verify import check_run_market

GOLDEN = Path(__file__).resolve().parents[3] / "fixtures" / "golden-run.json"
GOLDEN_HASH = "0x3f59118078569faaba4769e7da6246c816fc9f9d6bbcf22581a98e0ae63a570d"


def test_the_golden_run_verifies() -> None:
    result = verify_run(GOLDEN)
    assert result.ok, (result.schema_errors, result.model_errors)
    assert result.actual == result.expected == GOLDEN_HASH


def test_the_golden_run_replays_from_its_initial_market() -> None:
    doc = json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert check_run_market(doc) == []
    assert hash_run(doc) == GOLDEN_HASH


def test_the_golden_run_says_each_line_once() -> None:
    doc = json.loads(GOLDEN.read_text(encoding="utf-8"))
    lines = [" ".join(post["text"].lower().split()) for r in doc["rounds"] for post in r["posts"]]
    assert lines and len(lines) == len(set(lines))
