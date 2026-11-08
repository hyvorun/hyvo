"""The showcase run (fixtures/showcase-run.json) is what a visitor opens first: a run a language model
played, which verifies like any other and breaks no copy rule."""

from __future__ import annotations

import json
from pathlib import Path

from hyvo.report.guard import REMOVED_TEXT, find_violations, prose_fields
from hyvo.runfile import DISCLAIMER, verify_run
from hyvo.world.verify import check_run_market

SHOWCASE = Path(__file__).resolve().parents[3] / "fixtures" / "showcase-run.json"


def _doc() -> dict:
    return json.loads(SHOWCASE.read_text(encoding="utf-8"))


def test_the_showcase_run_verifies_and_replays() -> None:
    result = verify_run(SHOWCASE)
    assert result.ok, (result.schema_errors, result.model_errors)
    assert check_run_market(_doc()) == []


def test_a_language_model_played_it_to_the_end() -> None:
    doc = _doc()
    assert doc["status"] == "complete"
    assert not doc["crowd"]["model"]["agents"].startswith("offline/")
    assert not doc["crowd"]["model"]["report"].startswith("offline/")


def test_it_played_on_a_fork_of_the_chain() -> None:
    world = _doc()["world"]
    assert world["chainId"] == 4663
    assert world["forkBlock"] > 0


def test_the_crowd_answered_each_other_and_said_each_line_once() -> None:
    posts = [post for round_ in _doc()["rounds"] for post in round_["posts"]]
    assert sum(post["replyTo"] is not None for post in posts) > 20
    said = [post["text"] for post in posts if post["text"] != REMOVED_TEXT]
    assert len(said) == len(set(said))


def test_what_was_taken_out_is_counted_where_a_reader_can_see_it() -> None:
    doc = _doc()
    removed = sum(post["text"] == REMOVED_TEXT for round_ in doc["rounds"] for post in round_["posts"])
    assert f"posts_removed:{removed}" in doc["report"]["flags"]


def test_it_breaks_no_copy_rule() -> None:
    report = _doc()["report"]
    assert report["disclaimer"] == DISCLAIMER
    for field, text in prose_fields(report).items():
        assert find_violations(text) == [], (field, text)
    for round_ in _doc()["rounds"]:
        for post in round_["posts"]:
            assert find_violations(post["text"]) == [], post["text"]
