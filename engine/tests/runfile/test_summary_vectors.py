"""summarize_run gives what summarizeRun in packages/schema gives (shared vectors, `pnpm gen`)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from hyvo.runfile import run_meta, scenario_hash, summarize_run
from hyvo.runfile.summary import clip_code_points

REPO = Path(__file__).resolve().parents[3]
VECTORS = REPO / "packages" / "schema" / "test-vectors"


@pytest.mark.parametrize(
    ("source", "vector"),
    [
        (REPO / "fixtures" / "golden-run.json", VECTORS / "golden-run.summary.json"),
        (VECTORS / "sample-run.json", VECTORS / "sample-run.summary.json"),
    ],
)
def test_the_summary_matches_the_typescript_one(source: Path, vector: Path) -> None:
    run = json.loads(source.read_text(encoding="utf-8"))
    assert summarize_run(run) == json.loads(vector.read_text(encoding="utf-8"))


def test_run_meta_describes_the_exact_bytes() -> None:
    path = REPO / "fixtures" / "golden-run.json"
    data = path.read_bytes()
    run = json.loads(data)
    meta = run_meta(run, data)
    assert meta["hash"] == run["hash"]
    assert meta["sha256"] == hashlib.sha256(data).hexdigest()
    assert meta["scenarioHash"] == scenario_hash(run["scenario"])
    assert meta["usage"] == {"costUsd": run["usage"]["costUsd"], "llmCalls": run["usage"]["llmCalls"]}
    assert meta["eventRounds"] == [event["round"] for event in run["scenario"]["injectedEvents"]]


@pytest.mark.parametrize(
    ("text", "limit", "expected"),
    [
        ("short", 280, "short"),
        ("abcdef", 4, "abc\N{HORIZONTAL ELLIPSIS}"),
        ("ab  cdef", 4, "ab\N{HORIZONTAL ELLIPSIS}"),
        ("\N{SLIGHTLY SMILING FACE}" * 5, 3, "\N{SLIGHTLY SMILING FACE}" * 2 + "\N{HORIZONTAL ELLIPSIS}"),
    ],
)
def test_clipping_counts_code_points(text: str, limit: int, expected: str) -> None:
    assert clip_code_points(text, limit) == expected
