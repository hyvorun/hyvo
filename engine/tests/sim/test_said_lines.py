"""A line is said once in a run, with the lines a real model wrote in a 50 x 10 run as the cases."""

from __future__ import annotations

import pytest

from hyvo.sim.repeats import COMPARE_WITH_LAST, SaidLines, named_mentions


def said(*lines: str) -> SaidLines:
    memory = SaidLines()
    for line in lines:
        assert not memory.repeats(line), line
    return memory


@pytest.mark.parametrize(
    "first, again",
    [
        ("Still watching this pool.", "Still watching this pool."),
        ("Still watching this pool.", "STILL   watching this pool!"),
        (
            "@wittystoat34, I agree with you. We need to be cautious and not jump to conclusions.",
            "@waryllama77, I agree with you. We need to be cautious and not jump to conclusions.",
        ),
        (
            "@vividheron40, I agree with you that we need to be cautious and not jump to conclusions.",
            "I agree with @fuzzyllama99 that we need to be cautious and not jump to conclusions.",
        ),
        (
            "The tax issue is a major red flag for me. I need to see more transparency before I consider GLINT.",
            "The tax issue is a major red flag for me. I need to see more transparency before I consider holding GLINT.",
        ),
        ("I'm out!", "I'm out."),
    ],
)
def test_the_same_line_again_is_a_repeat(first: str, again: str) -> None:
    assert said(first).repeats(again)


@pytest.mark.parametrize(
    "first, other",
    [
        ("I'm out!", "I'm in!"),
        ("I'm out! Made a quick profit and don't want to risk it all.", "I'm out! Looks like a pump and dump to me."),
        (
            "@humblemole67, I agree with you. We need to be rational and not panic.",
            "@wittystoat34, I agree with you. We need to be cautious and not jump to conclusions.",
        ),
        ("The tax drop is a good sign.", "It's good to hear the tax will be reduced after the first week."),
        ("WHAT'S GOING ON?!", "What's the holdup?"),
    ],
)
def test_a_different_line_is_not(first: str, other: str) -> None:
    assert not said(first).repeats(other)


def test_a_refused_line_does_not_widen_what_counts_as_said() -> None:
    memory = said("We need to be cautious and not jump to conclusions about the tax.")
    assert memory.repeats("We need to be cautious and not jump to conclusions about this tax.")
    assert not memory.repeats("We should be careful and not jump around about this tax.")


def test_an_exact_copy_is_caught_however_long_ago_it_was_said() -> None:
    memory = said("Still watching this pool from a distance.")
    for n in range(COMPARE_WITH_LAST + 5):
        assert not memory.repeats(f"line number {n} with words {n * 3} and {n * 7} here")
    assert memory.repeats("Still watching this pool from a distance.")


def test_for_the_offline_model_only_the_very_same_line_is_a_repeat() -> None:
    memory = SaidLines(exact_only=True)
    assert not memory.repeats("@wittystoat34 fair question. I judge the team's work, not one candle.")
    assert not memory.repeats("@waryllama77 fair question. I judge the team's work, not one candle.")
    assert memory.repeats("@WARYLLAMA77  fair question. I judge the team's work, not one candle.")


def test_an_agent_id_in_a_post_becomes_its_handle() -> None:
    handles = {"a13": "@wittystoat34", "a02": "@waryllama77"}
    assert named_mentions("@a13 I agree, but @a02 has a point.", handles) == "@wittystoat34 I agree, but @waryllama77 has a point."
    assert named_mentions("@a99 who? and @a13x and a13", handles) == "@a99 who? and @a13x and a13"


def test_a_line_of_emoji_is_a_line_too() -> None:
    memory = said("🚀🚀🚀")
    assert memory.repeats("🚀🚀🚀")
    assert not memory.repeats("🐻")
