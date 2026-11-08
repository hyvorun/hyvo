"""The daily run: it publishes what passed everything, once, and a restart changes nothing."""

from __future__ import annotations

import copy
import json
import sys
import threading
import time
from datetime import UTC, date, datetime
from datetime import time as clock
from pathlib import Path

import pytest
from typer.testing import CliRunner

from hyvo import health
from hyvo.cli import app
from hyvo.daily import (
    AUTOPSY_AGENTS,
    DailySettings,
    DayRecord,
    NothingToPlay,
    PlayFailed,
    autopsy_settings,
    health_file,
    is_due,
    load_record,
    pick_for_day,
    pick_scenario,
    play_run,
    refusal,
    run_day,
    serve,
)
from hyvo.narrative.seedpack import NarrativeSettings
from hyvo.publish import PublishError
from hyvo.report.review import FLAG_INCOMPLETE
from hyvo.runfile import hash_run

GOLDEN = Path(__file__).resolve().parents[2] / "fixtures" / "golden-run.json"
DAY = date(2026, 11, 6)


def write_run(folder: Path, **changes: object) -> Path:
    """The golden run as a language model's run, with ``changes`` applied."""
    run = copy.deepcopy(json.loads(GOLDEN.read_text(encoding="utf-8")))
    run["crowd"]["model"]["agents"] = "@cf/meta/test-model"
    run["crowd"]["model"]["report"] = "@cf/meta/test-model"
    if "agents_model" in changes:
        run["crowd"]["model"]["agents"] = changes["agents_model"]
    if "flags" in changes:
        run["report"]["flags"] = changes["flags"]
    if "status" in changes:
        run["status"] = changes["status"]
        run["stopReason"] = "budget_exceeded"
    del run["hash"]
    run["hash"] = hash_run(run)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "run.json"
    path.write_text(json.dumps(run), encoding="utf-8")
    return path


class Stage:
    """Stand-ins for playing and publishing, which count their calls."""

    def __init__(self, tmp_path: Path, **run_changes: object) -> None:
        self.tmp_path = tmp_path
        self.run_changes = run_changes
        self.played = 0
        self.published: list[Path] = []
        self.play_errors: list[Exception] = []
        self.publish_errors: list[Exception] = []

    def play(self, settings: DailySettings, scenario: Path, day: date, attempt: int) -> Path:
        self.played += 1
        if self.play_errors:
            raise self.play_errors.pop(0)
        return write_run(self.tmp_path / f"played-{attempt}", **self.run_changes)

    def publish(self, settings: DailySettings, run_path: Path) -> tuple[str, str]:
        if self.publish_errors:
            raise self.publish_errors.pop(0)
        self.published.append(run_path)
        return "run_test", "0xhash"


@pytest.fixture
def settings(tmp_path: Path) -> DailySettings:
    scenarios = tmp_path / "scenarios"
    scenarios.mkdir()
    for name in ("a.md", "b.md", "c.md"):
        (scenarios / name).write_text("x", encoding="utf-8")
    return DailySettings(scenarios=scenarios, state_dir=tmp_path / "daily", api_url="http://api.test", token="t")


def go(settings: DailySettings, stage: Stage, now: float = 1000.0) -> DayRecord:
    return run_day(settings, DAY, play=stage.play, publish=stage.publish, log=lambda _: None, now=lambda: now)


def test_the_scenarios_take_turns_and_a_day_keeps_its_own(settings: DailySettings) -> None:
    picks = [pick_scenario(settings.scenarios, date.fromordinal(DAY.toordinal() + i)).name for i in range(6)]
    assert sorted(picks[:3]) == ["a.md", "b.md", "c.md"] and picks[:3] == picks[3:]
    assert pick_scenario(settings.scenarios, DAY) == pick_scenario(settings.scenarios, DAY)


def test_no_scenarios_is_a_clear_failure(tmp_path: Path) -> None:
    with pytest.raises(PlayFailed, match="no scenarios"):
        pick_scenario(tmp_path, DAY)


def test_a_good_run_is_published_once_however_often_the_day_is_tried(settings: DailySettings, tmp_path: Path) -> None:
    stage = Stage(tmp_path)
    record = go(settings, stage)
    assert record.status == "published" and record.run_id == "run_test" and record.attempts == 1
    assert go(settings, stage).status == "published"
    assert stage.played == 1 and len(stage.published) == 1


def test_a_restart_finds_the_day_where_it_was(settings: DailySettings, tmp_path: Path) -> None:
    stage = Stage(tmp_path)
    go(settings, stage)
    saved = load_record(settings, DAY)
    assert saved.status == "published" and saved.scenario.endswith(".md") and saved.history


def test_a_run_that_was_played_but_not_delivered_is_delivered_not_played_again(settings: DailySettings, tmp_path: Path) -> None:
    stage = Stage(tmp_path)
    stage.publish_errors.append(PublishError("cannot reach the API: ConnectError"))
    assert go(settings, stage).status == "played"
    assert go(settings, stage).status == "published"
    assert stage.played == 1 and len(stage.published) == 1


def test_a_failed_play_counts_and_the_attempts_run_out(settings: DailySettings, tmp_path: Path) -> None:
    stage = Stage(tmp_path)
    stage.play_errors = [PlayFailed("LLM provider returned HTTP 429")] * settings.max_attempts
    for attempt in range(1, settings.max_attempts + 1):
        record = go(settings, stage)
        assert record.status == "failed" and record.attempts == attempt and "429" in record.detail
    assert go(settings, stage).attempts == settings.max_attempts
    assert stage.played == settings.max_attempts and stage.published == []


def test_a_crash_during_a_run_still_counts_as_an_attempt(settings: DailySettings, tmp_path: Path) -> None:
    stage = Stage(tmp_path)
    stage.play_errors = [KeyboardInterrupt()]
    with pytest.raises(KeyboardInterrupt):
        go(settings, stage)
    assert load_record(settings, DAY).attempts == 1


@pytest.mark.parametrize(
    "changes, why",
    [
        ({"agents_model": "offline/rules-v1"}, "offline rules model"),
        ({"status": "partial"}, "stopped early"),
        ({"flags": [FLAG_INCOMPLETE]}, "could not finish"),
    ],
)
def test_a_run_that_did_not_pass_is_not_published(settings: DailySettings, tmp_path: Path, changes: dict, why: str) -> None:
    stage = Stage(tmp_path, **changes)
    record = go(settings, stage)
    assert record.status == "refused" and why in record.detail
    assert stage.published == []


def test_a_run_that_breaks_the_copy_rules_stays_refused_and_is_not_retried_as_delivery(settings: DailySettings, tmp_path: Path) -> None:
    stage = Stage(tmp_path)
    stage.publish_errors.append(PublishError("the run breaks the copy rules, and publishing commits it on-chain for good: post p1"))
    record = go(settings, stage)
    assert record.status == "refused" and "copy rules" in record.detail
    assert stage.published == []


def test_a_run_with_removed_posts_may_go_out(tmp_path: Path) -> None:
    assert refusal(write_run(tmp_path, flags=["posts_removed:2"])) is None


def test_it_is_due_after_its_hour_and_waits_between_attempts(settings: DailySettings) -> None:
    settings = DailySettings(**{**settings.__dict__, "at": clock(1, 0), "retry_after_s": 3600.0})
    early = datetime(2026, 11, 6, 0, 59, tzinfo=UTC)
    late = datetime(2026, 11, 6, 1, 1, tzinfo=UTC)
    fresh = DayRecord(day="2026-11-06")
    assert not is_due(settings, fresh, early)
    assert is_due(settings, fresh, late)
    tried = DayRecord(day="2026-11-06", status="failed", attempts=1, last_attempt_at=late.timestamp() - 60)
    assert not is_due(settings, tried, late)
    assert is_due(settings, DayRecord(**{**tried.__dict__, "last_attempt_at": late.timestamp() - 3601}), late)
    spent = DayRecord(day="2026-11-06", status="failed", attempts=settings.max_attempts)
    assert not is_due(settings, spent, late)
    assert not is_due(settings, DayRecord(day="2026-11-06", status="published", attempts=1), late)
    waiting = DayRecord(day="2026-11-06", status="played", attempts=settings.max_attempts)
    assert is_due(settings, waiting, late), "a played run is still delivered"


def test_the_loop_plays_when_due_and_stays_alive(settings: DailySettings, tmp_path: Path) -> None:
    stage = Stage(tmp_path)
    stop = threading.Event()
    calls = {"n": 0}

    def clock_now() -> datetime:
        calls["n"] += 1
        if calls["n"] > 2:
            stop.set()
        return datetime(2026, 11, 6, 2, 0, tzinfo=UTC)

    fast = DailySettings(**{**settings.__dict__, "tick_s": 0.01})
    serve(fast, stop, play=stage.play, publish=stage.publish, log=lambda _: None, clock_now=clock_now)
    assert stage.played == 1 and len(stage.published) == 1
    assert health.check(fast.state_dir / "daily.health", 60)[0]


def fake_python(tmp_path: Path, code: str) -> str:
    """A stand-in for ``python`` that runs ``code`` with the real arguments in ``sys.argv``."""
    script = tmp_path / "fake_hyvo.py"
    script.write_text(code, encoding="utf-8")
    if sys.platform == "win32":
        launcher = tmp_path / "fake_python.cmd"
        launcher.write_text(f'@"{sys.executable}" "{script}" %*\n', encoding="utf-8")
    else:
        launcher = tmp_path / "fake_python"
        launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n', encoding="utf-8")
        launcher.chmod(0o755)
    return str(launcher)


def test_a_real_process_writes_the_run_and_its_folder_is_found(settings: DailySettings, tmp_path: Path) -> None:
    code = """
import pathlib, sys
out = pathlib.Path(sys.argv[sys.argv.index("--out") + 1]) / "run_x"
out.mkdir(parents=True)
(out / "run.json").write_text("{}")
print("done", sys.argv[1:])
"""
    config = DailySettings(**{**settings.__dict__, "python": fake_python(tmp_path, code), "tick_s": 0.05})
    path = play_run(config, settings.scenarios / "a.md", DAY, 2)
    assert path.name == "run.json" and path.parent.name == "run_x"
    assert path.is_relative_to(config.state_dir / "2026-11-06" / "attempt-2")
    arguments = (path.parents[1] / "play.log").read_text(encoding="utf-8")
    for expected in ("-m", "hyvo", "run", "--fork", "202611062", "--max-llm-calls", "--quiet"):
        assert expected in arguments
    assert health.check(health_file(config), 60)[0]


def test_the_command_it_starts_is_one_the_cli_takes() -> None:
    """Every option ``play_run`` passes exists on ``hyvo run``."""
    result = CliRunner().invoke(app, ["run", "--help"], env={"COLUMNS": "200", "NO_COLOR": "1", "TERMINAL_WIDTH": "200"})
    for option in ("--scenario", "--agents", "--rounds", "--fork", "--seed", "--out", "--max-cost-usd", "--max-llm-calls", "--quiet"):
        assert option in result.output, option


def test_a_run_that_fails_says_why(settings: DailySettings, tmp_path: Path) -> None:
    code = 'import sys; print("hyvo: the LLM provider refused the key", file=sys.stderr); sys.exit(1)'
    config = DailySettings(**{**settings.__dict__, "python": fake_python(tmp_path, code), "tick_s": 0.05})
    with pytest.raises(PlayFailed, match="refused the key"):
        play_run(config, settings.scenarios / "a.md", DAY, 1)


def test_a_run_past_its_time_is_stopped_and_stays_healthy_until_then(settings: DailySettings, tmp_path: Path) -> None:
    code = "import time; time.sleep(60)"
    config = DailySettings(**{**settings.__dict__, "python": fake_python(tmp_path, code), "tick_s": 0.05, "timeout_s": 1.0})
    started = time.monotonic()
    with pytest.raises(PlayFailed, match="longer than"):
        play_run(config, settings.scenarios / "a.md", DAY, 1)
    assert time.monotonic() - started < 30
    ok, text = health.check(health_file(config), 60)
    assert ok and "playing 2026-11-06" in text


def test_a_bad_day_does_not_end_the_loop(settings: DailySettings, tmp_path: Path) -> None:
    stage = Stage(tmp_path)
    stage.play_errors = [ValueError("a bug")]
    stop = threading.Event()
    lines: list[str] = []
    calls = {"n": 0}

    def clock_now() -> datetime:
        calls["n"] += 1
        if stage.played >= 2 or calls["n"] > 200:
            stop.set()
        return datetime(2026, 11, 6, 2, 0, tzinfo=UTC)

    fast = DailySettings(**{**settings.__dict__, "tick_s": 0.01, "retry_after_s": 0.0})
    serve(fast, stop, play=stage.play, publish=stage.publish, log=lines.append, clock_now=clock_now)
    assert any("a bug" in line for line in lines)
    assert stage.played >= 2


def test_a_published_run_gets_its_post_thread(settings: DailySettings, tmp_path: Path) -> None:
    stage = Stage(tmp_path)
    site = DailySettings(**{**settings.__dict__, "site": "https://site.example"})
    record = go(site, stage)
    thread = Path(record.thread)
    assert thread.name == "thread.md" and thread.parent == stage.published[0].parent
    text = thread.read_text(encoding="utf-8")
    assert "https://site.example/run/" in text and "Synthetic crowd reaction. Not a trading signal." in text
    assert load_record(site, DAY).thread == record.thread


def test_a_thread_that_cannot_be_written_does_not_undo_the_publish(settings: DailySettings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(*args: object, **kwargs: object) -> Path:
        raise OSError("disk full")

    monkeypatch.setattr("hyvo.daily.write_thread", broken)
    lines: list[str] = []
    stage = Stage(tmp_path)
    record = run_day(settings, DAY, play=stage.play, publish=stage.publish, log=lines.append, now=lambda: 1000.0)
    assert record.status == "published" and record.thread == ""
    assert any("no post thread" in line for line in lines)


def seed_settings(settings: DailySettings, tmp_path: Path, **changes: object) -> DailySettings:
    narrative = NarrativeSettings(folder=tmp_path / "narrative", feeds=())
    return DailySettings(**{**settings.__dict__, "narrative": narrative, "reader": lambda: object(), **changes})


def test_a_seed_pack_is_the_days_scenario_when_there_is_one(settings: DailySettings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    class Pack:
        path = tmp_path / "scenario.md"

    monkeypatch.setattr("hyvo.daily.build_seed_pack", lambda *args, **kwargs: Pack())
    assert pick_for_day(seed_settings(settings, tmp_path), DAY, lambda _: None) == Pack.path


def test_a_thin_day_falls_back_to_an_example(settings: DailySettings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("hyvo.daily.build_seed_pack", lambda *args, **kwargs: None)
    assert pick_for_day(seed_settings(settings, tmp_path), DAY, lambda _: None).parent == settings.scenarios


def test_a_broken_narrative_engine_still_gives_the_day_its_run(settings: DailySettings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(*args: object, **kwargs: object) -> None:
        raise RuntimeError("the database is locked")

    monkeypatch.setattr("hyvo.daily.build_seed_pack", broken)
    lines: list[str] = []
    assert pick_for_day(seed_settings(settings, tmp_path), DAY, lines.append).parent == settings.scenarios
    assert any("no seed pack" in line for line in lines)


def test_a_seed_pack_is_never_built_without_a_reader(settings: DailySettings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def must_not_run(*args: object, **kwargs: object) -> None:
        raise AssertionError("built a pack that nobody can read")

    monkeypatch.setattr("hyvo.daily.build_seed_pack", must_not_run)
    unread = seed_settings(settings, tmp_path, reader=None)
    assert pick_for_day(unread, DAY, lambda _: None).parent == settings.scenarios


def test_nothing_to_play_ends_the_day_without_using_an_attempt(settings: DailySettings, tmp_path: Path) -> None:
    stage = Stage(tmp_path)

    def nothing(settings: DailySettings, day: date, log: object) -> Path:
        raise NothingToPlay("no tracked token moved")

    record = run_day(settings, DAY, pick=nothing, play=stage.play, publish=stage.publish, log=lambda _: None, now=lambda: 1000.0)
    assert record.status == "skipped" and record.attempts == 0 and stage.played == 0
    assert not is_due(settings, record, datetime(2026, 11, 6, 23, 0, tzinfo=UTC))


def test_having_no_scenario_is_recorded_like_any_failure(tmp_path: Path) -> None:
    empty = DailySettings(scenarios=tmp_path / "none", state_dir=tmp_path / "daily", api_url="http://api.test", token="t")
    (tmp_path / "none").mkdir()
    stage = Stage(tmp_path)
    record = go(empty, stage)
    assert record.status == "failed" and "no scenarios" in record.detail and stage.played == 0


def looped(settings: DailySettings, stage: Stage, *, ticks: int = 3, **kwargs: object) -> None:
    stop = threading.Event()
    calls = {"n": 0}

    def clock_now() -> datetime:
        calls["n"] += 1
        if calls["n"] > ticks:
            stop.set()
        return datetime(2026, 11, 6, 2, 0, tzinfo=UTC)

    fast = DailySettings(**{**settings.__dict__, "tick_s": 0.01})
    serve(fast, stop, play=stage.play, publish=stage.publish, log=lambda _: None, clock_now=clock_now, **kwargs)  # type: ignore[arg-type]


def test_the_autopsy_plays_small_after_the_days_run_is_out(settings: DailySettings, tmp_path: Path) -> None:
    stage = Stage(tmp_path)
    picked: list[int] = []

    def pick_second(second: DailySettings, day: date, log: object) -> Path:
        picked.append(second.agents)
        return settings.scenarios / "a.md"

    on = seed_settings(settings, tmp_path, autopsy=True)
    looped(on, stage, pick=lambda s, d, log: settings.scenarios / "b.md", pick_second=pick_second, refresh_graph=lambda *a: None)
    assert picked == [AUTOPSY_AGENTS] and stage.played == 2 and len(stage.published) == 2
    assert load_record(on, DAY).status == "published"
    second = autopsy_settings(on)
    assert second.state_dir != on.state_dir and second.rounds < on.rounds and not second.featured
    assert health_file(second) == health_file(on)
    assert load_record(second, DAY).status == "published"


def test_the_autopsy_waits_for_the_days_run(settings: DailySettings, tmp_path: Path) -> None:
    stage = Stage(tmp_path)
    stage.play_errors = [PlayFailed("the provider is down")]
    on = seed_settings(settings, tmp_path, autopsy=True, retry_after_s=1e9)
    second_runs: list[object] = []

    def pick_second(*args: object) -> Path:
        second_runs.append(args)
        return settings.scenarios / "a.md"

    looped(on, stage, ticks=2, pick=lambda s, d, log: settings.scenarios / "b.md", pick_second=pick_second, refresh_graph=lambda *a: None)
    assert load_record(on, DAY).status == "failed" and second_runs == []


def test_the_graph_is_refreshed_on_a_schedule(settings: DailySettings, tmp_path: Path) -> None:
    stage = Stage(tmp_path)
    seen: list[datetime] = []
    stop = threading.Event()
    moments = iter(datetime(2026, 11, 6, 0, minute, tzinfo=UTC) for minute in (0, 1, 2))

    def clock_now() -> datetime:
        try:
            return next(moments)
        except StopIteration:
            stop.set()
            return datetime(2026, 11, 6, 0, 3, tzinfo=UTC)

    on = seed_settings(settings, tmp_path, tick_s=0.01, refresh_every_s=120.0)
    serve(on, stop, play=stage.play, publish=stage.publish, log=lambda _: None, clock_now=clock_now, refresh_graph=lambda s, m, log: seen.append(m))
    assert [moment.minute for moment in seen] == [0, 2]


def test_a_failing_refresh_does_not_end_the_loop(settings: DailySettings, tmp_path: Path) -> None:
    stage = Stage(tmp_path)

    def broken(*args: object) -> None:
        raise RuntimeError("no network")

    on = seed_settings(settings, tmp_path)
    looped(on, stage, pick=lambda s, d, log: settings.scenarios / "b.md", refresh_graph=broken)
    assert load_record(on, DAY).status == "published"


def test_health_says_fresh_stale_and_missing(tmp_path: Path) -> None:
    path = tmp_path / "x.health"
    assert health.check(path, 60)[0] is False
    health.touch(path, "polling")
    ok, text = health.check(path, 60)
    assert ok and "polling" in text
    ok, text = health.check(path, 60, now=json.loads(path.read_text(encoding="utf-8"))["at"] + 61)
    assert not ok and "stale" in text
    path.write_text("not json", encoding="utf-8")
    assert health.check(path, 60)[0] is False


def test_the_health_command_exits_by_what_it_finds(tmp_path: Path) -> None:
    path = tmp_path / "x.health"
    runner = CliRunner()
    assert runner.invoke(app, ["health", str(path)]).exit_code == 1
    health.touch(path)
    result = runner.invoke(app, ["health", str(path), "--max-age", "60"])
    assert result.exit_code == 0 and "healthy" in result.output


def test_the_daily_command_needs_a_token_an_api_and_a_model(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("RUNNER_TOKEN", "HYVO_API_URL", "LLM_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    runner = CliRunner()
    assert "API URL" in runner.invoke(app, ["daily", "--once"]).output
    assert runner.invoke(app, ["daily", "--once"]).exit_code == 2
    monkeypatch.setenv("HYVO_API_URL", "http://api.test")
    assert "RUNNER_TOKEN" in runner.invoke(app, ["daily", "--once"]).output
    monkeypatch.setenv("RUNNER_TOKEN", "t")
    result = runner.invoke(app, ["daily", "--once"])
    assert result.exit_code == 2 and "language model" in result.output
