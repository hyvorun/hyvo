"""One public run a day (SPEC §10 "Daily run", §14 Phase 4), from the day's seed pack when the Narrative Engine is on.

Nobody reads a daily run before it goes out and its hash goes on-chain for good, so it publishes only what
passed everything: a language model played it to the end, the last read of its posts finished, and
``hyvo publish`` found it clean. Anything else is recorded and not published.

One JSON file per day keeps it safe to restart. An attempt is counted before it starts, so a crash loop cannot
spend the day's model allowance, and a run that was played but not delivered is delivered, not played again.

With ``--seed-packs`` the graph is refreshed every hour and the day's scenario comes from its seed pack, or from the example
scenarios on a thin day. Each published run gets a post thread (Swarm Cast). With ``--autopsy``, a tracked token that moved past the
threshold gets a smaller second run, once the day's run is out.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, date, datetime
from datetime import time as clock
from pathlib import Path

from hyvo import health
from hyvo.llm.types import LLMClient
from hyvo.narrative.autopsy import DEFAULT_THRESHOLD_PCT, build_autopsy
from hyvo.narrative.cast import DEFAULT_SITE, write_thread
from hyvo.narrative.graph import NarrativeGraph
from hyvo.narrative.seedpack import NarrativeSettings, build_seed_pack, refresh
from hyvo.publish import PublishError, publish_run
from hyvo.report.review import FLAG_INCOMPLETE
from hyvo.runfile import load_run

HEALTH_FILENAME = "daily.health"
AUTOPSY_AGENTS = 25
AUTOPSY_ROUNDS = 8
AUTOPSY_MAX_LLM_CALLS = 70
ENDED_FOR_THE_DAY = ("published", "skipped")


class PlayFailed(RuntimeError):
    """The run could not be played."""


class NothingToPlay(RuntimeError):
    """There is nothing to play today, and that is fine."""


@dataclass(frozen=True)
class DailySettings:
    scenarios: Path
    state_dir: Path
    api_url: str
    token: str
    agents: int = 50
    rounds: int = 10
    max_cost_usd: float = 0.2
    max_llm_calls: int = 130
    at: clock = clock(1, 0)  # UTC
    featured: bool = False
    max_attempts: int = 3
    retry_after_s: float = 3600.0
    tick_s: float = 60.0
    timeout_s: float = 1800.0
    python: str = sys.executable
    site: str = DEFAULT_SITE
    narrative: NarrativeSettings | None = None  # seed packs, when set
    reader: Callable[[], LLMClient] | None = None  # the report model, which reads a seed pack before it plays
    autopsy: bool = False
    autopsy_threshold_pct: float = DEFAULT_THRESHOLD_PCT
    refresh_every_s: float = 3600.0
    health_path: Path | None = None  # default: <state_dir>/daily.health


@dataclass
class DayRecord:
    """What happened on one day. ``status``: ``new``, ``played`` (not delivered yet), ``published``,
    ``refused`` (it did not pass), ``failed`` or ``skipped`` (nothing to play)."""

    day: str
    scenario: str = ""
    status: str = "new"
    attempts: int = 0
    last_attempt_at: float = 0.0
    run_path: str = ""
    run_id: str = ""
    hash: str = ""
    detail: str = ""
    history: list[str] = field(default_factory=list)
    thread: str = ""


Log = Callable[[str], None]
Pick = Callable[[DailySettings, date, Log], Path]
Play = Callable[[DailySettings, Path, date, int], Path]
Publish = Callable[[DailySettings, Path], tuple[str, str]]


def pick_scenario(folder: Path, day: date) -> Path:
    """The scenarios take turns, and the same day always gets the same one."""
    scenarios = sorted(folder.glob("*.md"))
    if not scenarios:
        raise PlayFailed(f"no scenarios in {folder}")
    return scenarios[day.toordinal() % len(scenarios)]


def pick_for_day(settings: DailySettings, day: date, log: Log) -> Path:
    """The day's seed pack when there is one, else an example. A pack is only ever played after the report model read it."""
    if settings.narrative is not None and settings.reader is not None:
        try:
            pack = build_seed_pack(settings.narrative, day, client=settings.reader(), log=log)
            if pack is not None:
                return pack.path
        except Exception as error:  # noqa: BLE001  (whatever broke the pack, the day still gets its run)
            log(f"daily {day}: no seed pack ({type(error).__name__}: {str(error)[:200]}); using an example scenario")
    return pick_scenario(settings.scenarios, day)


def pick_autopsy(settings: DailySettings, day: date, log: Log) -> Path:
    if settings.narrative is None or settings.reader is None:
        raise NothingToPlay("the Narrative Engine is off")
    path = build_autopsy(
        settings.narrative,
        day,
        client=settings.reader(),
        threshold_pct=settings.autopsy_threshold_pct,
        rounds=settings.rounds,
        log=log,
    )
    if path is None:
        raise NothingToPlay("no tracked token moved far enough today")
    return path


def autopsy_settings(settings: DailySettings) -> DailySettings:
    """A smaller run with its own records: the free allowance has to cover the day's run first."""
    return replace(
        settings,
        state_dir=settings.state_dir / "autopsy",
        health_path=health_file(settings),
        agents=AUTOPSY_AGENTS,
        rounds=AUTOPSY_ROUNDS,
        max_llm_calls=AUTOPSY_MAX_LLM_CALLS,
        featured=False,
    )


def refresh_narrative(settings: DailySettings, moment: datetime, log: Log) -> None:
    if settings.narrative is not None:
        with NarrativeGraph(settings.narrative.graph_path) as graph:
            refresh(graph, settings.narrative, moment, log)


def load_record(settings: DailySettings, day: date) -> DayRecord:
    path = _record_path(settings, day)
    try:
        return DayRecord(**json.loads(path.read_text(encoding="utf-8")))
    except FileNotFoundError:
        return DayRecord(day=day.isoformat())


def refusal(run_path: Path) -> str | None:
    """Why a played run must not go out unread; ``None`` when it may."""
    doc = load_run(run_path)
    if doc["crowd"]["model"]["agents"].startswith("offline/") or doc["crowd"]["model"]["report"].startswith("offline/"):
        return "it was played by the offline rules model, and the site says a crowd of AI traders"
    if doc["status"] != "complete":
        return f"it stopped early ({doc.get('stopReason')})"
    if FLAG_INCOMPLETE in doc["report"]["flags"]:
        return "the last read of its posts could not finish"
    return None


def play_run(settings: DailySettings, scenario: Path, day: date, attempt: int) -> Path:
    """Play the day's run in its own process, on a fork of the real chain."""
    out = settings.state_dir / day.isoformat() / f"attempt-{attempt}"
    out.mkdir(parents=True, exist_ok=True)
    command = [
        settings.python, "-m", "hyvo", "run",
        "--scenario", str(scenario),
        "--agents", str(settings.agents),
        "--rounds", str(settings.rounds),
        "--fork",
        "--seed", f"{day:%Y%m%d}{attempt}",
        "--out", str(out),
        "--max-cost-usd", f"{settings.max_cost_usd:g}",
        "--max-llm-calls", str(settings.max_llm_calls),
        "--quiet",
    ]  # fmt: skip
    log_path = out / "play.log"
    with log_path.open("w", encoding="utf-8", errors="replace") as log_file:
        process = subprocess.Popen(
            command,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            env={**os.environ, "PYTHONUTF8": "1"},
        )
        try:
            _wait_alive(settings, process, day)
        except BaseException:
            process.kill()
            process.wait()
            raise
    if process.returncode != 0:
        lines = log_path.read_text(encoding="utf-8", errors="replace").strip().splitlines()
        raise PlayFailed(lines[-1][:300] if lines else f"the run exited with code {process.returncode}")
    runs = sorted(out.glob("*/run.json"), key=lambda path: path.stat().st_mtime)
    if not runs:
        raise PlayFailed("the run wrote no run.json")
    return runs[-1]


def _wait_alive(settings: DailySettings, process: subprocess.Popen[bytes], day: date) -> None:
    """Wait for the run, keeping the health file fresh: a run takes far longer than a health check allows."""
    deadline = time.monotonic() + settings.timeout_s
    while True:
        health.touch(health_file(settings), f"playing {day}")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise PlayFailed(f"the run took longer than {settings.timeout_s:g} s")
        try:
            process.wait(timeout=min(remaining, settings.tick_s))
            return
        except subprocess.TimeoutExpired:
            pass


def health_file(settings: DailySettings) -> Path:
    return settings.health_path or settings.state_dir / HEALTH_FILENAME


def deliver(settings: DailySettings, run_path: Path) -> tuple[str, str]:
    result = publish_run(run_path, settings.api_url, settings.token, featured=settings.featured)
    return result.run_id, result.hash


def run_day(
    settings: DailySettings,
    day: date,
    *,
    pick: Pick = pick_for_day,
    play: Play = play_run,
    publish: Publish = deliver,
    log: Log = print,
    now: Callable[[], float] = time.time,
) -> DayRecord:
    """One attempt at the day's run; does nothing when it is over for the day or out of attempts."""
    record = load_record(settings, day)
    if record.status in ENDED_FOR_THE_DAY or (record.status != "played" and record.attempts >= settings.max_attempts):
        return record

    if record.status != "played":
        record = replace(record, attempts=record.attempts + 1, last_attempt_at=now())
        _save(settings, record)
        try:
            scenario = pick(settings, day, log)
        except NothingToPlay as error:
            return _ended(settings, replace(record, attempts=record.attempts - 1), "skipped", str(error), log)
        except PlayFailed as error:
            return _ended(settings, record, "failed", str(error), log)
        record = replace(record, scenario=str(scenario))
        _save(settings, record)
        log(f"daily {day}: attempt {record.attempts} with {scenario}")
        try:
            run_path = play(settings, scenario, day, record.attempts)
        except PlayFailed as error:
            return _ended(settings, record, "failed", str(error), log)
        record = replace(record, status="played", run_path=str(run_path))
        _save(settings, record)

    run_path = Path(record.run_path)
    if not run_path.is_file():
        return _ended(settings, replace(record, run_path=""), "failed", f"the played run is gone: {run_path}", log)
    reason = refusal(run_path)
    if reason:
        return _ended(settings, record, "refused", reason, log)
    try:
        run_id, run_hash = publish(settings, run_path)
    except PublishError as error:
        text = str(error)
        status = "refused" if "copy rules" in text or "does not verify" in text else "played"
        return _ended(settings, replace(record, last_attempt_at=now()), status, text, log)
    record = replace(record, run_id=run_id, hash=run_hash, thread=_thread(settings, run_path, day, log))
    return _ended(settings, record, "published", f"{run_id} {run_hash}", log)


def _thread(settings: DailySettings, run_path: Path, day: date, log: Log) -> str:
    """The run is out whatever happens here: a thread that cannot be written is only logged."""
    try:
        return str(write_thread(run_path, site=settings.site))
    except (OSError, ValueError, KeyError, TypeError) as error:
        log(f"daily {day}: no post thread: {type(error).__name__}: {error}")
        return ""


def is_due(settings: DailySettings, record: DayRecord, moment: datetime) -> bool:
    if moment.time() < settings.at or record.status in ENDED_FOR_THE_DAY:
        return False
    if record.status != "played" and record.attempts >= settings.max_attempts:
        return False
    return moment.timestamp() - record.last_attempt_at >= settings.retry_after_s


def serve(
    settings: DailySettings,
    stop: threading.Event,
    *,
    pick: Pick = pick_for_day,
    pick_second: Pick = pick_autopsy,
    play: Play = play_run,
    publish: Publish = deliver,
    log: Log = print,
    clock_now: Callable[[], datetime] = lambda: datetime.now(UTC),
    refresh_graph: Callable[[DailySettings, datetime, Log], None] = refresh_narrative,
) -> None:
    """Run each day's run when it is due, until ``stop`` is set."""
    refreshed: datetime | None = None

    def now() -> float:
        return clock_now().timestamp()

    while not stop.is_set():
        moment = clock_now()
        day = moment.date()
        health.touch(health_file(settings), "waiting")
        if settings.narrative is not None and (refreshed is None or (moment - refreshed).total_seconds() >= settings.refresh_every_s):
            refreshed = moment
            _guarded(lambda: refresh_graph(settings, moment, log), day, log)
        if is_due(settings, load_record(settings, day), moment):
            _guarded(lambda: run_day(settings, day, pick=pick, play=play, publish=publish, log=log, now=now), day, log)
        if settings.autopsy and load_record(settings, day).status == "published":
            second = autopsy_settings(settings)
            if is_due(second, load_record(second, day), moment):
                _guarded(lambda: run_day(second, day, pick=pick_second, play=play, publish=publish, log=log, now=now), day, log)
        stop.wait(settings.tick_s)


def _guarded(work: Callable[[], object], day: date, log: Log) -> None:
    """One bad day must not end the loop."""
    try:
        work()
    except Exception as error:  # noqa: BLE001
        log(f"daily {day}: {type(error).__name__}: {error}")


def _ended(settings: DailySettings, record: DayRecord, status: str, detail: str, log: Callable[[str], None]) -> DayRecord:
    record = replace(record, status=status, detail=detail, history=[*record.history, f"{status}: {detail[:200]}"])
    _save(settings, record)
    log(f"daily {record.day}: {status}: {detail}")
    return record


def _record_path(settings: DailySettings, day: date) -> Path:
    return settings.state_dir / f"{day.isoformat()}.json"


def _save(settings: DailySettings, record: DayRecord) -> None:
    path = _record_path(settings, date.fromisoformat(record.day))
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(asdict(record), indent=1), encoding="utf-8")
    os.replace(temporary, path)
