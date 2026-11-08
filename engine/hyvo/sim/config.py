"""Run parameters (:class:`SimConfig`) and the result of a run (:class:`RunOutcome`).

``SimConfig`` holds what one run needs besides the engine settings: the scenario, the crowd, the
LLM limits, the world and the stop rules. ``None`` means "use the default": the budget limits
fall back to ``Settings`` (``MAX_COST_USD_DEFAULT``, ``MAX_LLM_CALLS_DEFAULT``), the runs
directory to ``Settings.runs_dir``, the seed to a fresh random one, and ``fork`` to "fork when
``RH_RPC_URL`` is set".
"""

from __future__ import annotations

import math
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

from hyvo.clone import CloneProfile
from hyvo.personas import MAX_CROWD_SIZE
from hyvo.runfile.canonical import run_id_to_bytes32
from hyvo.scenarios import Scenario
from hyvo.sim.question import CrowdQuestionSpec

MAX_ROUNDS = 1000
DEFAULT_TIMEOUT_S = 1800.0
DEFAULT_TEMPERATURE = 0.8
# Each agent starts with initial_token_weight x this share of the pool's initial token liquidity
# (holders 1%, panic sellers 0.6%, snipers and skeptics none).
DEFAULT_SEED_TOKEN_SHARE = Decimal("0.01")
# A swap reverts when it would fill more than this below the output expected at the round's
# decision snapshot. Every agent of a round decides on the same snapshot and the swaps then run
# one after another, so on a thin launch pool a tight limit lets only the first few trades of a
# round fill: with 5% on the example scenario's 5 ETH pool, 19 of 21 round-1 buys reverted and
# trading stopped after round 6. 15% (a common setting for new-token trades) keeps reverts to the
# opening rush and lets the crowd trade in every round.
DEFAULT_MAX_SLIPPAGE_BPS = 1500


DEFAULT_WAVE_SIZE = 100


class SimConfigError(ValueError):
    """A run parameter is out of range. Messages name the parameter and the allowed values."""


class SimulationError(RuntimeError):
    """The run could not finish correctly: the provider failed, the world disagreed with the
    engine's bookkeeping, the written run.json did not verify, or teardown left something behind."""


@dataclass(frozen=True)
class SimConfig:
    """Parameters of one run.

    Attributes:
        scenario: a scenario Markdown file (path) or a parsed ``Scenario``.
        agents: crowd size, 1 to 9,999.
        rounds: rounds to play, 1 to 1,000.
        mix: persona mix, ``"sniper=10,holder=15,..."`` or a mapping; ``None`` is the default mix.
        batch_size: agents decided per LLM call.
        wave_size: a crowd larger than this plays each round in waves of this many agents, in a seeded
            order, each deciding from the market and the feed the wave before it left. A crowd of this
            size or smaller plays one wave, in agent order.
        max_concurrency: batch calls in flight at once.
        max_cost_usd, max_llm_calls: run budget; ``None`` takes the settings defaults.
        offline: use the offline rules model even when ``LLM_API_KEY`` is set.
        fork: ``True`` forks ``RH_RPC_URL`` (required then), ``False`` never forks, ``None``
            forks when ``RH_RPC_URL`` is set.
        fork_block: block to fork at (needs a fork); ``None`` is the latest block.
        seed: seeds the crowd, the agent addresses, the offline model and the order of market
            actions; ``None`` draws a random seed (recorded in events.jsonl).
        runs_dir: parent of the run directory ``<runs_dir>/<runId>/``; ``None`` is
            ``Settings.runs_dir``.
        timeout_s: wall-clock limit; checked between rounds, so a run stops at a round boundary.
        temperature: sampling temperature of the agents model.
        feed_posts, feed_replies: posts in the shared feed and replies shown under each.
        seed_token_share: token seeding, see ``DEFAULT_SEED_TOKEN_SHARE``.
        max_slippage_bps: how far below the output expected at decision time a swap may fill.
        anvil_dir: parent of anvil's data directory; ``None`` is ``engine/.anvil``.
        run_id: the run id (``run_`` + a ULID), such as an API job's; ``None`` is a fresh one.
        question: what each agent is asked at the end of the run; ``None`` asks nothing.
        clone: a wallet's numbers, played by one agent of the crowd; ``None`` has no clone.
        rewind: the ``rewind`` section of run.json, for a run that replays a real moment (``hyvo.rewind``).
    """

    scenario: Scenario | str | os.PathLike[str]
    agents: int = 50
    rounds: int = 10
    mix: str | Mapping[str, int] | None = None
    batch_size: int = 10
    wave_size: int = DEFAULT_WAVE_SIZE
    max_concurrency: int = 4
    max_cost_usd: float | None = None
    max_llm_calls: int | None = None
    offline: bool = False
    fork: bool | None = None
    fork_block: int | None = None
    seed: int | None = None
    runs_dir: str | os.PathLike[str] | None = None
    timeout_s: float = DEFAULT_TIMEOUT_S
    temperature: float = DEFAULT_TEMPERATURE
    feed_posts: int = 10
    feed_replies: int = 2
    seed_token_share: Decimal = DEFAULT_SEED_TOKEN_SHARE
    max_slippage_bps: int = DEFAULT_MAX_SLIPPAGE_BPS
    anvil_dir: str | os.PathLike[str] | None = None
    run_id: str | None = None
    question: CrowdQuestionSpec | None = None
    clone: CloneProfile | None = None
    rewind: Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.scenario, (Scenario, str, os.PathLike)):
            raise SimConfigError("scenario must be a file path or a Scenario")
        _check_int("agents", self.agents, 1, MAX_CROWD_SIZE)
        _check_int("rounds", self.rounds, 1, MAX_ROUNDS)
        _check_int("batch_size", self.batch_size, 1, MAX_CROWD_SIZE)
        _check_int("wave_size", self.wave_size, 1, MAX_CROWD_SIZE)
        _check_int("max_concurrency", self.max_concurrency, 1, 64)
        _check_int("feed_posts", self.feed_posts, 0, 100)
        _check_int("feed_replies", self.feed_replies, 0, 10)
        _check_int("max_slippage_bps", self.max_slippage_bps, 0, 10_000)
        if self.mix is not None and not isinstance(self.mix, (str, Mapping)):
            raise SimConfigError("mix must be a string such as 'sniper=10,holder=15' or a mapping")
        if self.max_cost_usd is not None:
            _check_number("max_cost_usd", self.max_cost_usd)
        if self.max_llm_calls is not None:
            _check_int("max_llm_calls", self.max_llm_calls, 0, 10**9)
        if self.fork not in (None, True, False):
            raise SimConfigError("fork must be True, False or None")
        if self.fork_block is not None:
            _check_int("fork_block", self.fork_block, 0, 2**63 - 1)
            if self.fork is False:
                raise SimConfigError("fork_block needs a fork; it cannot be used with fork=False")
        if self.seed is not None:
            _check_int("seed", self.seed, 0, 2**63 - 1)
        if self.run_id is not None:
            try:
                run_id_to_bytes32(self.run_id)
            except ValueError:
                raise SimConfigError(
                    f"run_id must be 'run_' and a ULID, got {self.run_id!r}"
                ) from None
        _check_number("timeout_s", self.timeout_s, positive=True)
        _check_number("temperature", self.temperature, maximum=2.0)
        if (
            not isinstance(self.seed_token_share, Decimal)
            or not self.seed_token_share.is_finite()
            or not 0 <= self.seed_token_share <= 1
        ):
            raise SimConfigError("seed_token_share must be a Decimal from 0 to 1")


@dataclass(frozen=True)
class RunOutcome:
    """What a finished run produced.

    ``path`` is the written ``run.json`` (inside ``run_dir``, next to ``llm-log.jsonl`` and
    ``events.jsonl``). ``usage`` is run.json ``usage``. ``mismatches`` lists the price-replay
    disagreements of the written run; it is always empty, because any mismatch raises.
    """

    run_id: str
    run_dir: Path
    path: Path
    status: str
    stop_reason: str | None
    hash: str
    usage: dict[str, Any]
    mismatches: list[str] = field(default_factory=list)
    seed: int = 0
    rounds: int = 0
    offline: bool = False
    models: dict[str, str] = field(default_factory=dict)
    elapsed_s: float = 0.0


def _check_int(name: str, value: Any, low: int, high: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise SimConfigError(f"{name} must be a whole number from {low:,} to {high:,}, got {value!r}")


def _check_number(
    name: str, value: Any, *, positive: bool = False, maximum: float | None = None
) -> None:
    ok = (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
        and (value > 0 if positive else value >= 0)
        and (maximum is None or value <= maximum)
    )
    if not ok:
        bound = "> 0" if positive else ">= 0"
        if maximum is not None:
            bound += f" and <= {maximum:g}"
        raise SimConfigError(f"{name} must be a finite number {bound}, got {value!r}")
