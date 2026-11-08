from __future__ import annotations

import pytest

from hyvo.decisions.lexicon import tone


@pytest.mark.parametrize(
    "text",
    ["Rumor: dev wallet sold 20%", "Exploit drained the pool", "The dev dumped everything", "Possible rug"],
)
def test_bad_news_is_negative(text):
    assert tone(text) < 0


@pytest.mark.parametrize(
    "text",
    ["Audit passed", "Listing on a second venue", "Partnership with a wallet app", "Team burned 10% of supply"],
)
def test_good_news_is_positive(text):
    assert tone(text) > 0


def test_phrases_win_over_their_words():
    assert tone("audit passed") > 0 > tone("audit failed")


def test_negators_flip_at_half_weight():
    assert tone("no rug here") == pytest.approx(0.5)
    assert tone("The team denied the rumor") > 0


def test_neutral_text_and_clamping():
    assert tone("") == 0 and tone("the pool opened at noon") == 0
    assert tone("rug rug exploit hack scam dump") == -1.0
    assert tone("listing partnership burn buyback audited") == 1.0
