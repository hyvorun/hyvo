"""The rolling graph: it remembers across restarts, forgets on schedule, and knows what appears together."""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

from hyvo.narrative.graph import NarrativeGraph

from .samples import NOW, news_signal, pool_signal


def test_a_signal_seen_again_changes_nothing(tmp_path: Path) -> None:
    with NarrativeGraph(tmp_path / "g.sqlite") as graph:
        signal = pool_signal("FIZZ")
        assert graph.add([signal], NOW) == 1
        assert graph.add([signal], NOW + timedelta(hours=1)) == 0
        assert len(graph.signals(since=NOW - timedelta(days=1))) == 1


def test_a_restart_finds_everything_as_it_was(tmp_path: Path) -> None:
    path = tmp_path / "deep" / "g.sqlite"
    signal = pool_signal("FIZZ", kind="launch", change=12.5)
    with NarrativeGraph(path) as graph:
        graph.add([signal], NOW)
        graph.mark_used("FIZZ", "seedpack", NOW)
    with NarrativeGraph(path) as graph:
        [back] = graph.signals(since=NOW - timedelta(days=1))
        assert back == signal
        assert graph.used_since("seedpack", NOW - timedelta(days=1)) == {"FIZZ"}


def test_old_signals_are_pruned_and_their_entities_go_with_them(tmp_path: Path) -> None:
    with NarrativeGraph(tmp_path / "g.sqlite") as graph:
        old = pool_signal("OLD", at=NOW - timedelta(days=20))
        new = pool_signal("NEW")
        graph.add([old, new], NOW)
        graph.mark_used("OLD", "seedpack", NOW - timedelta(days=20))
        assert graph.first_seen("OLD") is not None
        assert graph.prune(NOW - timedelta(days=14)) == 1
        assert [signal.refs["symbol"] for signal in graph.signals(since=NOW - timedelta(days=30))] == ["NEW"]
        assert graph.first_seen("OLD") is None and graph.first_seen("NEW") is not None
        assert graph.used_since("seedpack", NOW - timedelta(days=30)) == set()
        assert graph.about("OLD", since=NOW - timedelta(days=30)) == []


def test_an_entity_keeps_its_first_sighting(tmp_path: Path) -> None:
    with NarrativeGraph(tmp_path / "g.sqlite") as graph:
        graph.add([pool_signal("FIZZ", at=NOW)], NOW)
        graph.add([pool_signal("FIZZ", at=NOW - timedelta(hours=30))], NOW)
        assert graph.first_seen("FIZZ") == NOW - timedelta(hours=30)


def test_the_days_narratives_are_what_is_mentioned_most(tmp_path: Path) -> None:
    with NarrativeGraph(tmp_path / "g.sqlite") as graph:
        graph.add(
            [
                news_signal("one", "Bitcoin", "Regulation"),
                news_signal("two", "Bitcoin"),
                news_signal("three", "Bitcoin", "Robinhood"),
                news_signal("four", "Robinhood"),
                news_signal("old", "Solana", at=NOW - timedelta(days=5)),
                pool_signal("FIZZ"),
            ],
            NOW,
        )
        assert graph.top_entities(since=NOW - timedelta(days=1)) == [("Bitcoin", 3), ("Robinhood", 2), ("Regulation", 1)]


def test_the_edges_are_what_appears_together(tmp_path: Path) -> None:
    with NarrativeGraph(tmp_path / "g.sqlite") as graph:
        graph.add([news_signal("a", "Bitcoin", "ETFs"), news_signal("b", "Bitcoin", "ETFs"), news_signal("c", "Bitcoin", "AI")], NOW)
        assert graph.neighbors("Bitcoin", since=NOW - timedelta(days=1)) == [("ETFs", 2), ("AI", 1)]


def test_about_gives_a_timeline(tmp_path: Path) -> None:
    with NarrativeGraph(tmp_path / "g.sqlite") as graph:
        early = pool_signal("FIZZ", at=NOW - timedelta(hours=30))
        late = pool_signal("FIZZ", at=NOW - timedelta(hours=2))
        graph.add([late, early, pool_signal("OTHER")], NOW)
        assert [signal.at for signal in graph.about("FIZZ", since=NOW - timedelta(days=2))] == [early.at, late.at]
        assert [signal.at for signal in graph.about("FIZZ", since=NOW - timedelta(days=2), until=NOW - timedelta(hours=10))] == [early.at]
        kinds = graph.signals(since=NOW - timedelta(days=2), kinds=("news",))
        assert kinds == []
