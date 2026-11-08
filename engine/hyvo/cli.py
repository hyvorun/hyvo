"""The ``hyvo`` command line (console script ``hyvo = hyvo.cli:main``).

- ``hyvo run --scenario FILE [options]`` plays one run and writes ``<out>/<runId>/run.json``
  next to ``llm-log.jsonl`` and ``events.jsonl``. It prints the run id, the status (with the stop
  reason of a partial run), the path, the hash, and the LLM calls and cost. Exit code 0 for a
  complete or a partial run, 2 for bad input (scenario, options, settings), 1 when the run fails,
  130 when interrupted. No traceback unless ``--debug``.
- ``hyvo verify PATH`` checks a run.json (or a run directory): the hash, the JSON Schema, the
  model rules and the price replay of every recorded swap. Exit code 0 when all pass, else 1.
- ``hyvo publish PATH`` verifies a run.json locally and publishes it to the API.
- ``hyvo runner`` pulls paid jobs from the API and plays them, one at a time, until stopped.

Output is UTF-8 safe on a Windows console that uses a legacy code page (cp1252): a console keeps
its encoding with unencodable characters replaced, and a pipe or file gets UTF-8.
"""

from __future__ import annotations

import json
import logging
import signal
import sys
import traceback
from pathlib import Path
from typing import Annotated, Any, NoReturn

import typer

DISCLAIMER = "Synthetic crowd reaction. Not a trading signal."
MAX_PROBLEMS = 10

app = typer.Typer(
    name="hyvo",
    help="Hyvo engine: synthetic crowd runs on a local Robinhood Chain world. "
    "Results are synthetic crowd reactions, never trading signals.",
    add_completion=False,
    no_args_is_help=True,
    rich_markup_mode=None,  # plain click output: no box drawing on legacy consoles
    pretty_exceptions_enable=False,
)


def main(argv: list[str] | None = None) -> None:
    """Entry point of the ``hyvo`` console script."""
    _safe_streams()
    app(args=argv, prog_name="hyvo")


@app.callback()
def _root() -> None:
    """Hyvo engine commands."""


_MIX_HELP = (
    "Persona mix summing to --agents, e.g. sniper=10,holder=15,panic_seller=10,skeptic=15 "
    "(default: in proportion 10:15:10:15)."
)
_FORK_HELP = "Fork RH_RPC_URL (default: fork when RH_RPC_URL is set) or run a plain local chain."


@app.command("run")
def run_command(
    scenario: Annotated[
        Path,
        typer.Option(
            "--scenario", "-s", help="Scenario Markdown file (front matter, seed text, events)."
        ),
    ],
    agents: Annotated[int, typer.Option(min=1, max=9999, help="Crowd size.")] = 50,
    rounds: Annotated[int, typer.Option(min=1, max=1000, help="Rounds to play.")] = 10,
    mix: Annotated[str | None, typer.Option(help=_MIX_HELP)] = None,
    batch_size: Annotated[int, typer.Option(min=1, help="Agents per LLM call.")] = 10,
    max_concurrency: Annotated[
        int, typer.Option(min=1, max=64, help="LLM calls in flight at once.")
    ] = 4,
    max_cost_usd: Annotated[
        float | None,
        typer.Option(min=0.0, help="Run budget in USD (default MAX_COST_USD_DEFAULT)."),
    ] = None,
    max_llm_calls: Annotated[
        int | None,
        typer.Option(min=0, help="Run budget in LLM calls (default MAX_LLM_CALLS_DEFAULT)."),
    ] = None,
    offline: Annotated[
        bool,
        typer.Option("--offline", help="Use the offline rules model even when LLM_API_KEY is set."),
    ] = False,
    fork: Annotated[bool | None, typer.Option("--fork/--no-fork", help=_FORK_HELP)] = None,
    fork_block: Annotated[
        int | None, typer.Option(min=0, help="Block number to fork at (needs a fork).")
    ] = None,
    seed: Annotated[int | None, typer.Option(min=0, help="Seed (default: random).")] = None,
    out: Annotated[
        Path | None,
        typer.Option(help="Runs directory (default HYVO_RUNS_DIR or engine/.runs)."),
    ] = None,
    timeout_min: Annotated[
        float, typer.Option(help="Stop at the next round boundary after this many minutes.")
    ] = 30.0,
    max_slippage_bps: Annotated[
        int | None,
        typer.Option(min=0, max=10000, help="Slippage limit of every swap (default 1500)."),
    ] = None,
    quiet: Annotated[bool, typer.Option("--quiet", "-q", help="No per-round progress lines.")] = False,
    question: Annotated[str | None, typer.Option(help="What each agent is asked at the end of the run (needs --resolves-at).")] = None,
    resolves_at: Annotated[str | None, typer.Option(help="When the question's outcome can be recorded: 2026-12-01T00:00:00Z.")] = None,
    debug: Annotated[
        bool, typer.Option("--debug", help="Show tracebacks and engine log messages.")
    ] = False,
) -> None:
    """Play one run and write its run.json."""
    _setup_logging(debug)
    try:
        from hyvo.config import load_settings
        from hyvo.personas import parse_mix
        from hyvo.scenarios import load_scenario_file
        from hyvo.sim.config import SimConfig, SimConfigError

        settings = load_settings()
        if not scenario.is_file():
            raise SimConfigError(f"scenario file not found: {scenario}")
        parsed = load_scenario_file(scenario)
        parsed.check_rounds(rounds)
        if mix is not None:
            parse_mix(mix, agents)
        if out is not None:
            out = out.expanduser()
        extra: dict[str, Any] = {}
        if max_slippage_bps is not None:
            extra["max_slippage_bps"] = max_slippage_bps
        if (question is None) != (resolves_at is None):
            raise SimConfigError("--question and --resolves-at go together")
        if question is not None and resolves_at is not None:
            from hyvo.sim.question import CrowdQuestionSpec

            extra["question"] = CrowdQuestionSpec(question, resolves_at)
        config = SimConfig(
            scenario=parsed,
            agents=agents,
            rounds=rounds,
            mix=mix,
            batch_size=batch_size,
            max_concurrency=max_concurrency,
            max_cost_usd=max_cost_usd,
            max_llm_calls=max_llm_calls,
            offline=offline,
            fork=fork,
            fork_block=fork_block,
            seed=seed,
            runs_dir=out,
            timeout_s=timeout_min * 60.0,
            **extra,
        )
    except Exception as error:  # noqa: BLE001 (every input problem becomes a short message)
        _fail(error, debug, code=2 if _is_input_error(error) else 1)

    if offline:
        _say("Model: offline rules model (offline/rules-v1), as requested by --offline.")
    elif not settings.llm_api_key:
        _say("Model: LLM_API_KEY is not set, so this run uses the offline rules model (offline/rules-v1).")
    elif settings.llm_model_name:
        report = settings.report_model_name or settings.llm_model_name
        via = _host(settings.llm_base_url)
        _say(f"Model: {settings.llm_model_name} for the agents, {report} for the report, via {via}.")
    _say(f"Scenario: {parsed.title} ({scenario.name}); {agents} agents x {rounds} rounds.")

    try:
        from hyvo.sim.loop import run_simulation

        progress = None if quiet else (lambda line: typer.echo(f"  {line}", err=True))
        outcome = run_simulation(config, settings, progress=progress)
    except KeyboardInterrupt:
        typer.echo("interrupted: the run was stopped and its world torn down", err=True)
        raise typer.Exit(130) from None
    except Exception as error:  # noqa: BLE001
        _fail(error, debug, code=2 if _is_input_error(error) else 1)

    status = outcome.status if outcome.stop_reason is None else f"{outcome.status} ({outcome.stop_reason})"
    usage = outcome.usage
    _say(f"run id:     {outcome.run_id}")
    _say(f"status:     {status}")
    _say(f"run.json:   {outcome.path}")
    _say(f"hash:       {outcome.hash}")
    _say(
        f"LLM calls:  {usage['llmCalls']} ({usage['inputTokens']} input + {usage['outputTokens']} "
        f"output tokens), cost ${usage['costUsd']:.6f}"
    )
    _say(f"rounds:     {outcome.rounds} played in {outcome.elapsed_s:.1f} s (seed {outcome.seed})")
    _say(DISCLAIMER)


@app.command("verify")
def verify_command(
    path: Annotated[
        Path, typer.Argument(help="A run.json file, or a run directory that holds one.")
    ],
    debug: Annotated[bool, typer.Option("--debug", help="Show tracebacks.")] = False,
) -> None:
    """Check a run.json: hash, JSON Schema, model rules and the price replay of its swaps."""
    _setup_logging(debug)
    try:
        from hyvo.runfile import load_run, verify_run
        from hyvo.runfile.io import RUN_FILENAME
        from hyvo.world.verify import check_run_market

        target = path / RUN_FILENAME if path.is_dir() else path
        _say(f"run.json:  {target}")
        try:
            doc = load_run(target)
        except (OSError, ValueError) as error:
            _say(f"read:      FAILED: {_short(error)}")
            raise typer.Exit(1) from None
        result = verify_run(doc)
        try:
            mismatches = check_run_market(doc)
        except Exception as error:  # noqa: BLE001 (a malformed document must not crash the check)
            mismatches = [f"the replay could not run: {_short(error)}"]
    except typer.Exit:
        raise
    except Exception as error:  # noqa: BLE001
        _fail(error, debug, code=1)

    rounds = doc.get("rounds") if isinstance(doc.get("rounds"), list) else []
    swaps = sum(
        1
        for rnd in rounds
        if isinstance(rnd, dict)
        for action in rnd.get("actions") or []
        if isinstance(action, dict)
        and action.get("status") == "ok"
        and action.get("kind") in ("swap_buy", "swap_sell")
    )
    _say(f"run id:    {doc.get('runId')} (status {doc.get('status')}, {len(rounds)} rounds)")
    hash_ok = result.expected is not None and result.expected == result.actual
    if hash_ok:
        _say(f"hash:      ok {result.actual}")
    else:
        _say(f"hash:      FAILED: recorded {result.actual}, recomputed {result.expected}")
    _section("schema", result.schema_errors)
    _section("rules", result.model_errors)
    _section("replay", mismatches, ok_text=f"ok ({swaps} swaps in {len(rounds)} rounds)")
    if hash_ok and result.ok and not mismatches:
        _say(f"verified. {DISCLAIMER}")
        return
    _say("NOT verified")
    raise typer.Exit(1)


@app.command("publish")
def publish_command(
    path: Annotated[
        Path, typer.Argument(help="A run.json file, or a run directory that holds one.")
    ],
    api: Annotated[
        str | None,
        typer.Option("--api", help="API base URL (default HYVO_API_URL), e.g. http://127.0.0.1:8787."),
    ] = None,
    featured: Annotated[
        bool, typer.Option("--featured", help="Show this run in the home page hero.")
    ] = False,
    debug: Annotated[bool, typer.Option("--debug", help="Show tracebacks.")] = False,
) -> None:
    """Verify a run.json locally and publish it to the Hyvo API (needs RUNNER_TOKEN)."""
    _setup_logging(debug)
    from hyvo.config import load_settings
    from hyvo.publish import PublishError, publish_run, run_file

    try:
        settings = load_settings()
        api_url = api or settings.hyvo_api_url
        if not api_url:
            raise _InputError("no API URL: pass --api or set HYVO_API_URL")
        if not settings.runner_token:
            raise _InputError("RUNNER_TOKEN is not set")
        if not run_file(path).is_file():
            raise _InputError(f"no run.json at {path}")
        result = publish_run(path, api_url, settings.runner_token, featured=featured)
    except _InputError as error:
        _fail(error, debug, code=2)
    except PublishError as error:
        _fail(error, debug, code=1)
    except Exception as error:  # noqa: BLE001
        _fail(error, debug, code=2 if _is_input_error(error) else 1)
    state = "published" if result.created else "already published (same hash)"
    _say(f"run id:     {result.run_id}")
    _say(f"status:     {state}{' as featured' if featured and result.created else ''}")
    _say(f"hash:       {result.hash}")
    _say(f"published:  {result.published_at} at {_host(api_url)}")
    _say(DISCLAIMER)


@app.command("runner")
def runner_command(
    api: Annotated[
        str | None,
        typer.Option("--api", help="API base URL (default HYVO_API_URL), e.g. http://127.0.0.1:8787."),
    ] = None,
    once: Annotated[
        bool, typer.Option("--once", help="Exit after one job (waits for one if the queue is empty).")
    ] = False,
    offline: Annotated[
        bool,
        typer.Option("--offline", help="Play every job with the offline rules model."),
    ] = False,
    fork: Annotated[bool | None, typer.Option("--fork/--no-fork", help=_FORK_HELP)] = None,
    work_dir: Annotated[
        Path | None,
        typer.Option(help="Where jobs, logs and run.json files are kept (default <runs dir>/runner)."),
    ] = None,
    poll_interval: Annotated[
        float, typer.Option(min=0.1, help="Seconds between polls of an empty queue.")
    ] = 15.0,
    debug: Annotated[bool, typer.Option("--debug", help="Show tracebacks.")] = False,
) -> None:
    """Pull paid jobs from the Hyvo API and play them (needs RUNNER_TOKEN); Ctrl+C stops."""
    _setup_logging(debug)
    _stop_on_sigterm()
    from hyvo.config import load_settings
    from hyvo.runner import JobsApi, Runner, RunnerOptions, RunnerStopped

    try:
        settings = load_settings()
        api_url = api or settings.hyvo_api_url
        if not api_url:
            raise _InputError("no API URL: pass --api or set HYVO_API_URL")
        if not settings.runner_token:
            raise _InputError("RUNNER_TOKEN is not set")
        folder = (work_dir.expanduser() if work_dir else settings.runs_dir / "runner").resolve()
        folder.mkdir(parents=True, exist_ok=True)
    except Exception as error:  # noqa: BLE001
        _fail(error, debug, code=2 if isinstance(error, _InputError) or _is_input_error(error) else 1)

    if offline:
        _say("Model: offline rules model (offline/rules-v1) for every job, as requested by --offline.")
    elif not settings.llm_api_key:
        _say("Model: LLM_API_KEY is not set, so jobs use the offline rules model (offline/rules-v1).")
    _say(f"Runner: polling {_host(api_url)} every {poll_interval:g} s; work directory {folder}.")
    options = RunnerOptions(
        work_dir=folder, offline=offline, fork=fork, poll_interval_s=poll_interval, health_file=folder / "runner.health"
    )
    with JobsApi(api_url, settings.runner_token) as client:
        runner = Runner(client, options, log=_say)
        try:
            results = runner.serve(max_jobs=1 if once else None)
        except KeyboardInterrupt:
            typer.echo("interrupted: the runner stopped", err=True)
            raise typer.Exit(130) from None
        except RunnerStopped as error:
            _fail(error, debug, code=1)
    if once and results and results[0].outcome != "completed":
        raise typer.Exit(1)


@app.command("daily")
def daily_command(
    api: Annotated[str | None, typer.Option("--api", help="API base URL (default HYVO_API_URL).")] = None,
    once: Annotated[bool, typer.Option("--once", help="Try today's run now, then exit (0 when it is published).")] = False,
    at: Annotated[str, typer.Option("--at", help="When each day's run is due, HH:MM UTC.")] = "01:00",
    scenarios: Annotated[Path | None, typer.Option(help="Folder of scenario files (default examples/scenarios).")] = None,
    agents: Annotated[int, typer.Option(min=1)] = 50,
    rounds: Annotated[int, typer.Option(min=1)] = 10,
    featured: Annotated[bool, typer.Option("--featured", help="Show each day's run in the home page hero.")] = False,
    seed_packs: Annotated[bool, typer.Option("--seed-packs", help="Build each day's scenario from the Narrative Engine.")] = False,
    autopsy: Annotated[bool, typer.Option("--autopsy", help="Also play a smaller run when a tracked token moves far (needs --seed-packs).")] = False,
    site: Annotated[str | None, typer.Option("--site", help="The site's address, for post threads (default HYVO_SITE_URL).")] = None,
    debug: Annotated[bool, typer.Option("--debug", help="Show tracebacks.")] = False,
) -> None:
    """Play and publish one public run a day. It goes out only if it passes every check."""
    _setup_logging(debug)
    _stop_on_sigterm()
    import threading
    from datetime import UTC, datetime, time

    from hyvo.config import load_settings
    from hyvo.daily import DailySettings, run_day, serve
    from hyvo.llm.factory import make_clients
    from hyvo.narrative.cast import DEFAULT_SITE

    try:
        settings = load_settings()
        api_url = api or settings.hyvo_api_url
        if not api_url:
            raise _InputError("no API URL: pass --api or set HYVO_API_URL")
        if not settings.runner_token:
            raise _InputError("RUNNER_TOKEN is not set")
        if not settings.llm_api_key:
            raise _InputError("LLM_API_KEY is not set: a daily run needs a language model, not the offline rules model")
        folder = (scenarios or Path(__file__).resolve().parents[1] / "examples" / "scenarios").expanduser().resolve()
        due = time.fromisoformat(at)
    except Exception as error:  # noqa: BLE001
        _fail(error, debug, code=2 if isinstance(error, _InputError) or _is_input_error(error) else 1)
    config = DailySettings(
        scenarios=folder,
        state_dir=settings.runs_dir / "daily",
        api_url=api_url,
        token=settings.runner_token,
        agents=agents,
        rounds=rounds,
        at=due,
        featured=featured,
        site=site or settings.hyvo_site_url or DEFAULT_SITE,
        narrative=_narrative_settings(settings, rounds=rounds) if seed_packs else None,
        reader=(lambda: make_clients(settings, False)[1]) if seed_packs else None,
        autopsy=autopsy and seed_packs,
    )
    if once:
        record = run_day(config, datetime.now(UTC).date(), log=_say)
        raise typer.Exit(0 if record.status == "published" else 1)
    _say(f"Daily run: due at {at} UTC, publishing to {_host(api_url)}; state in {config.state_dir}.")
    try:
        serve(config, threading.Event(), log=_say)
    except KeyboardInterrupt:
        typer.echo("interrupted: the daily loop stopped", err=True)
        raise typer.Exit(130) from None


def _narrative_settings(settings: Any, *, rounds: int = 10, unread: bool = False) -> Any:
    from hyvo.narrative.rss import DEFAULT_FEEDS
    from hyvo.narrative.seedpack import NarrativeSettings

    # A pack nobody read must never be picked up by a daily run.
    folder = settings.runs_dir / ("narrative-unread" if unread else "narrative")
    return NarrativeSettings(folder=folder, feeds=settings.narrative_rss_urls or DEFAULT_FEEDS, neynar_key=settings.neynar_api_key, rounds=rounds)


@app.command("seedpack")
def seedpack_command(
    no_read: Annotated[bool, typer.Option("--no-read", help="Skip the report model's read. The pack is then only for looking at: a daily run will not use it.")] = False,
    debug: Annotated[bool, typer.Option("--debug", help="Show tracebacks.")] = False,
) -> None:
    """Build today's seed pack from the sources, and say what is in it. Plays nothing."""
    _setup_logging(debug)
    from datetime import UTC, datetime

    from hyvo.config import load_settings
    from hyvo.llm.factory import make_clients
    from hyvo.narrative.seedpack import build_seed_pack

    try:
        settings = load_settings()
        if not no_read and not settings.llm_api_key:
            raise _InputError("LLM_API_KEY is not set: the report model reads a seed pack. Pass --no-read to only look at one.")
        client = None if no_read else make_clients(settings, False)[1]
        pack = build_seed_pack(_narrative_settings(settings, unread=no_read), datetime.now(UTC).date(), client=client, log=_say)
    except Exception as error:  # noqa: BLE001
        _fail(error, debug, code=2 if isinstance(error, _InputError) or _is_input_error(error) else 1)
    if pack is None:
        _say("A thin day: nothing qualified, so a daily run would use an example scenario.")
        raise typer.Exit(0)
    typer.echo(pack.path)


@app.command("autopsy")
def autopsy_command(
    threshold: Annotated[float, typer.Option("--threshold", min=1, help="Percent, over 24 hours.")] = 50.0,
    rounds: Annotated[int, typer.Option(min=3)] = 8,
    no_read: Annotated[bool, typer.Option("--no-read", help="Skip the report model's read; only for looking at.")] = False,
    debug: Annotated[bool, typer.Option("--debug", help="Show tracebacks.")] = False,
) -> None:
    """Build today's Autopsy scenario if a tracked token moved far enough. Plays nothing."""
    _setup_logging(debug)
    from datetime import UTC, datetime

    from hyvo.config import load_settings
    from hyvo.llm.factory import make_clients
    from hyvo.narrative.autopsy import build_autopsy

    try:
        settings = load_settings()
        if not no_read and not settings.llm_api_key:
            raise _InputError("LLM_API_KEY is not set: the report model reads the scenario. Pass --no-read to only look at one.")
        client = None if no_read else make_clients(settings, False)[1]
        path = build_autopsy(_narrative_settings(settings, unread=no_read), datetime.now(UTC).date(), client=client, threshold_pct=threshold, rounds=rounds, log=_say)
    except Exception as error:  # noqa: BLE001
        _fail(error, debug, code=2 if isinstance(error, _InputError) or _is_input_error(error) else 1)
    if path is None:
        raise typer.Exit(0)
    typer.echo(path)


@app.command("cast")
def cast_command(
    run: Annotated[Path, typer.Argument(help="A run.json, or a run's folder.")],
    site: Annotated[str | None, typer.Option("--site", help="The site's address (default HYVO_SITE_URL).")] = None,
    out: Annotated[Path | None, typer.Option("--out", help="Where to write thread.md and thread.json (default next to the run).")] = None,
) -> None:
    """Print a short post thread from a run's report (Swarm Cast). Posting it is by hand."""
    from hyvo.config import load_settings
    from hyvo.narrative.cast import DEFAULT_SITE, write_thread
    from hyvo.publish import run_file

    target = run_file(run)
    if not target.is_file():
        _say(f"error: no run at {target}")
        raise typer.Exit(2)
    path = write_thread(target, out_dir=out, site=site or load_settings().hyvo_site_url or DEFAULT_SITE)
    typer.echo(path.read_text(encoding="utf-8"))
    _say(f"Written to {path}")


@app.command("scrub")
def scrub_command(
    run: Annotated[Path, typer.Argument(help="An unpublished run.json, or its folder.")],
    remove: Annotated[str, typer.Option("--remove", help="Post ids a person reading it wants out, separated by commas.")] = "",
) -> None:
    """Take out what must not go on-chain before a run is published: posts that break the copy rules, and those you name.

    It changes the run's hash, which is the point: a run that is already published cannot be changed, and the API refuses a different hash for it.
    """
    from hyvo.publish import copy_problems, local_problems, run_file
    from hyvo.report.review import scrub_run
    from hyvo.runfile import load_run, write_run

    target = run_file(run)
    try:
        document = load_run(target)
        scrubbed, removed = scrub_run(document, [item.strip() for item in remove.split(",") if item.strip()])
    except (OSError, ValueError) as error:
        _say(f"error: {error}")
        raise typer.Exit(2) from None
    if removed:
        scrubbed.pop("hash", None)
        write_run(target.parent, scrubbed)
    problems = [*local_problems(target), *copy_problems(load_run(target))]
    for problem in problems:
        _say(f"problem: {problem}")
    typer.echo(f"{len(removed)} posts taken out{': ' + ', '.join(removed) if removed else ''}. Hash {load_run(target)['hash']}")
    raise typer.Exit(1 if problems else 0)


@app.command("rewind")
def rewind_command(
    pool: Annotated[str, typer.Argument(help="The pool's address on Robinhood Chain.")],
    block: Annotated[int, typer.Argument(help="The block to go back to.")],
    change: Annotated[str, typer.Argument(help="The one thing that is different this time.")],
    at_round: Annotated[int, typer.Option("--round", help="The round it happens in.")] = 3,
    hours: Annotated[float, typer.Option(help="How far ahead to compare with what actually happened.")] = 6.0,
    agents: Annotated[int, typer.Option(help="Crowd size.")] = 50,
    rounds: Annotated[int, typer.Option(help="Rounds to play.")] = 10,
    seed: Annotated[int | None, typer.Option(help="Seed of the crowd.")] = None,
    context: Annotated[str, typer.Option(help="What else the crowd should know.")] = "",
    offline: Annotated[bool, typer.Option("--offline", help="Use the offline rules model.")] = False,
    out: Annotated[Path | None, typer.Option(help="Where to write run.json (default <runs dir>).")] = None,
) -> None:
    """Play a past moment of a real pool again with one thing changed, next to what actually happened. Needs RH_RPC_URL."""
    from hyvo.config import load_settings
    from hyvo.rewind import Chain, ChainUnreachable, RewindError, RewindRequest, plan_rewind
    from hyvo.scenarios import ScenarioError, from_text
    from hyvo.sim.config import SimConfig
    from hyvo.sim.loop import run_simulation

    settings = load_settings()
    if not settings.rh_rpc_url:
        _say("error: a rewind needs RH_RPC_URL")
        raise typer.Exit(2)
    try:
        scenario = from_text(f"Rewind of block {block}", context, [{"round": at_round, "text": change}], ref="cli")
        plan = plan_rewind(RewindRequest(pool, block, hours), scenario, rounds, Chain(settings.rh_rpc_url))
        plan.scenario.check_rounds(rounds)
    except (RewindError, ScenarioError) as error:
        _say(f"error: {error}")
        raise typer.Exit(2) from None
    except ChainUnreachable as error:
        _say(f"error: {error}")
        raise typer.Exit(1) from None
    config = SimConfig(scenario=plan.scenario, agents=agents, rounds=rounds, offline=offline, fork=True, fork_block=plan.block, seed=seed, runs_dir=out, rewind=plan.section)
    outcome = run_simulation(config, settings)
    actual = plan.section["actual"]
    typer.echo(f"run.json:   {outcome.path}")
    typer.echo(f"hash:       {outcome.hash}")
    typer.echo(f"the pool:   {actual[0]['price']} to {actual[-1]['price']} ETH per token, what actually happened")
    typer.echo("Synthetic crowd reaction. Not a trading signal.")


@app.command("dryrun")
def dryrun_command(
    spec_file: Annotated[Path, typer.Argument(help="A JSON file: description, abi, address or bytecode, invariants, agents, rounds, seed.")],
    offline: Annotated[bool, typer.Option("--offline", help="Use the offline rules model, which plays like a small fuzzer.")] = False,
    out: Annotated[Path | None, typer.Option(help="Where to write dryrun.json (default <runs dir>/dryruns).")] = None,
    debug: Annotated[bool, typer.Option("--debug", help="Show tracebacks.")] = False,
) -> None:
    """Let a crowd of synthetic users try a contract in a private sandbox, and report what they ran into. It is not an audit."""
    _setup_logging(debug)
    from hyvo.config import load_settings
    from hyvo.dryrun.document import NOT_AN_AUDIT
    from hyvo.dryrun.play import DryRunFailed, play_dry_run
    from hyvo.dryrun.spec import DryRunError, load_spec_file

    try:
        settings = load_settings()
        spec = load_spec_file(spec_file)
        outcome = play_dry_run(spec, settings, runs_dir=(out or settings.runs_dir / "dryruns").expanduser().resolve(), offline=offline, progress=_say)
    except DryRunError as error:
        _fail(error, debug, code=2)
    except (DryRunFailed, Exception) as error:  # noqa: BLE001
        _fail(error, debug, code=2 if _is_input_error(error) else 1)
    report = json.loads(outcome.path.read_text(encoding="utf-8"))
    typer.echo(f"{outcome.findings} findings, {len(report['calls'])} calls, hash {outcome.hash}")
    for finding in report["findings"]:
        typer.echo(f"  {finding['severity']:<6} {finding['title']}")
    typer.echo(f"report: {outcome.path}")
    typer.echo(f"{DISCLAIMER} {NOT_AN_AUDIT}")


@app.command("health")
def health_command(
    path: Annotated[Path, typer.Argument(help="A health file: <work dir>/runner.health or <runs dir>/daily/daily.health.")],
    max_age: Annotated[float, typer.Option("--max-age", min=1, help="Seconds since the loop last touched it.")] = 300.0,
) -> None:
    """Exit 0 when a long-running loop touched its health file recently, for a container's health check."""
    from hyvo import health

    healthy, text = health.check(path, max_age)
    _say(text)
    raise typer.Exit(0 if healthy else 1)


def _stop_on_sigterm() -> None:
    """``docker stop`` sends SIGTERM: stop the way Ctrl+C does, so a run is torn down and the API hears at once."""
    signal.signal(signal.SIGTERM, signal.default_int_handler)


class _InputError(ValueError):
    """A problem with what the user passed or configured (exit code 2)."""


# --- helpers --------------------------------------------------------------------------------------


def _section(name: str, problems: list[str], ok_text: str = "ok") -> None:
    label = f"{name}:".ljust(10)
    if not problems:
        _say(f"{label} {ok_text}")
        return
    _say(f"{label} FAILED ({len(problems)} problem{'s' if len(problems) != 1 else ''})")
    for problem in problems[:MAX_PROBLEMS]:
        _say(f"  - {problem}")
    if len(problems) > MAX_PROBLEMS:
        _say(f"  ... and {len(problems) - MAX_PROBLEMS} more")


def _fail(error: BaseException, debug: bool, *, code: int) -> NoReturn:
    if debug:
        traceback.print_exception(error, file=sys.stderr)
    typer.echo(f"error: {_short(error, lines=MAX_PROBLEMS + 1)}", err=True)
    raise typer.Exit(code)


def _short(error: BaseException, *, lines: int = 1) -> str:
    text = str(error).strip() or type(error).__name__
    kept = text.splitlines()
    shown = "\n".join(kept[:lines])
    if len(kept) > lines:
        shown += f"\n  ... ({len(kept) - lines} more lines)"
    return shown


def _is_input_error(error: BaseException) -> bool:
    """Errors in what the user asked for (exit code 2) rather than failures of the run."""
    from hyvo.config import ConfigError
    from hyvo.llm.pricing import PricingUnknown
    from hyvo.personas import PersonaMixError
    from hyvo.scenarios import ScenarioError
    from hyvo.sim.config import SimConfigError

    input_errors = (
        ConfigError,
        PricingUnknown,
        PersonaMixError,
        ScenarioError,
        SimConfigError,
    )
    return isinstance(error, input_errors)


def _say(text: str) -> None:
    typer.echo(text)


def _host(url: str | None) -> str:
    from urllib.parse import urlsplit

    if not url:
        return "the default OpenAI endpoint"
    try:
        return urlsplit(url).hostname or "the configured endpoint"
    except ValueError:
        return "the configured endpoint"


def _setup_logging(debug: bool) -> None:
    logging.basicConfig(
        level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s", stream=sys.stderr
    )
    logging.getLogger("hyvo").setLevel(logging.INFO if debug else logging.WARNING)


def _safe_streams() -> None:
    """Never fail on a character the console cannot show: a console keeps its encoding and
    replaces such characters; a pipe or file that is not UTF-8 is switched to UTF-8."""
    for stream in (sys.stdout, sys.stderr):
        encoding = (getattr(stream, "encoding", None) or "").lower().replace("-", "").replace("_", "")
        if encoding.startswith("utf8") or not hasattr(stream, "reconfigure"):
            continue
        try:
            if stream.isatty():
                stream.reconfigure(errors="replace")
            else:
                stream.reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            continue


if __name__ == "__main__":
    main()
