"""Swarm Cast: a post thread from a run. Every post fits and passes the copy rules, and it ends with the proof."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from hyvo.cli import app
from hyvo.narrative.cast import MAX_CHARS, build_thread, write_thread
from hyvo.report.guard import REMOVED_TEXT, find_violations

GOLDEN_PATH = Path(__file__).resolve().parents[3] / "fixtures" / "golden-run.json"
GOLDEN = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
DISCLAIMER = "Synthetic crowd reaction. Not a trading signal."


def test_a_thread_fits_and_breaks_no_copy_rule() -> None:
    thread = build_thread(GOLDEN)
    assert 3 <= len(thread) <= 6
    for post in thread:
        assert len(post) <= MAX_CHARS, post
        assert find_violations(post) == [], post


def test_it_opens_with_what_this_is_and_ends_with_the_proof() -> None:
    thread = build_thread(GOLDEN, "https://site.example/")
    assert GOLDEN["scenario"]["title"][:40] in thread[0]
    assert "synthetic crowd" in thread[0] and "None of it is real trading" in thread[0]
    assert f"https://site.example/run/{GOLDEN['runId']}" in thread[-1]
    assert GOLDEN["hash"][:18] in thread[-1]
    assert thread[-1].endswith(DISCLAIMER)


def test_it_says_what_the_test_market_did() -> None:
    thread = build_thread(GOLDEN)
    assert any(post.startswith("In the simulation, the test market for") and "%" in post for post in thread)


def test_a_line_that_breaks_the_rules_is_left_out_and_the_proof_stays() -> None:
    run = copy.deepcopy(GOLDEN)
    run["report"]["summary"] = "This token will moon, you should buy now."
    thread = build_thread(run)
    assert all("moon" not in post for post in thread)
    assert thread[-1].endswith(DISCLAIMER)


def test_what_the_guard_removed_is_not_posted() -> None:
    run = copy.deepcopy(GOLDEN)
    run["report"]["summary"] = REMOVED_TEXT
    run["report"]["turningPoint"] = {"round": 2, "why": REMOVED_TEXT}
    run["report"]["objections"] = [REMOVED_TEXT]
    assert all(REMOVED_TEXT not in post for post in build_thread(run))


def test_a_long_line_is_cut_where_it_reads_well() -> None:
    run = copy.deepcopy(GOLDEN)
    run["report"]["summary"] = ("The crowd split early. " * 40).strip()
    summary = next(post for post in build_thread(run) if post.startswith("The crowd split"))
    assert len(summary) <= MAX_CHARS and summary.endswith(".")
    run["report"]["summary"] = "word " * 200
    cut = next(post for post in build_thread(run) if post.startswith("word"))
    assert len(cut) <= MAX_CHARS and cut.endswith("…")


def test_it_writes_a_thread_next_to_the_run(tmp_path: Path) -> None:
    run_path = tmp_path / "run.json"
    run_path.write_text(GOLDEN_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    path = write_thread(run_path)
    assert path == tmp_path / "thread.md"
    assert DISCLAIMER in path.read_text(encoding="utf-8")
    assert json.loads((tmp_path / "thread.json").read_text(encoding="utf-8"))["runId"] == GOLDEN["runId"]


@pytest.mark.parametrize("site", ["https://hyvo.pages.dev", "https://hyvo.pages.dev/"])
def test_the_command_prints_it(tmp_path: Path, site: str) -> None:
    run_path = tmp_path / "run.json"
    run_path.write_text(GOLDEN_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    result = CliRunner().invoke(app, ["cast", str(run_path), "--site", site])
    assert result.exit_code == 0, result.output
    assert f"https://hyvo.pages.dev/run/{GOLDEN['runId']}" in result.output
    assert DISCLAIMER in result.output


def test_the_command_says_what_is_wrong(tmp_path: Path) -> None:
    result = CliRunner().invoke(app, ["cast", str(tmp_path / "missing.json")])
    assert result.exit_code == 2
