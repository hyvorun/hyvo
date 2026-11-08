"""The job a runner receives from ``GET /internal/jobs/next`` (docs/API.md, "Runner jobs").

The spec is parsed strictly: an unknown member, a wrong JSON type or a value out of range rejects
the job, so the runner never plays something other than what was ordered. Member names are
camelCase on the wire. The envelope (``runId``, ``leaseId``...) is read first, so a job whose spec
this runner cannot read can still be reported back with ``fail``.
"""

from __future__ import annotations

import json
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from pydantic.alias_generators import to_camel

from hyvo.clone import CloneProfile
from hyvo.dryrun.spec import DryRunError, DryRunSpec, from_mapping
from hyvo.personas import MAX_CROWD_SIZE, parse_mix
from hyvo.runfile.canonical import run_id_to_bytes32
from hyvo.scenarios import MarketOverrides, Scenario, from_text, sanitize_line
from hyvo.scenarios.models import MAX_TOKEN_NAME_CHARS
from hyvo.scenarios.sanitize import MAX_EVENT_CHARS, MAX_SEED_CHARS, MAX_TITLE_CHARS
from hyvo.sim.config import MAX_ROUNDS, SimConfig
from hyvo.sim.question import MAX_QUESTION_CHARS, CrowdQuestionSpec

SPEC_VERSION = 1
_LEASE_RE = re.compile(r"^lease_[A-Za-z0-9_-]{16,64}$")


class JobError(ValueError):
    """A job from the API cannot be read or played as specified. ``run_id`` and ``lease_id``
    are set when the envelope could be read, so the runner can still call ``fail``."""

    def __init__(
        self, message: str, *, run_id: str | None = None, lease_id: str | None = None
    ) -> None:
        super().__init__(message)
        self.run_id = run_id
        self.lease_id = lease_id


class _Wire(BaseModel):
    model_config = ConfigDict(
        frozen=True, extra="forbid", strict=True, alias_generator=to_camel, populate_by_name=True
    )


class JobEvent(_Wire):
    round: int = Field(ge=1, le=MAX_ROUNDS)
    text: str = Field(min_length=1, max_length=MAX_EVENT_CHARS)


class JobMarket(_Wire):
    """Market overrides; decimal amounts travel as strings so no precision is lost."""

    token_symbol: str | None = None
    token_name: str | None = None
    liquidity_eth: str | None = None
    liquidity_tokens: str | None = None
    fee_bps: int | None = None


class JobScenario(_Wire):
    title: str = Field(min_length=1, max_length=MAX_TITLE_CHARS)
    seed_text: str = Field(max_length=MAX_SEED_CHARS)
    events: tuple[JobEvent, ...] = Field(default=(), max_length=50)
    market: JobMarket | None = None


class JobQuestion(_Wire):
    text: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
    resolves_at: str


class JobRewind(_Wire):
    pool: str = Field(pattern=r"^0x[0-9a-fA-F]{40}$")
    block: int = Field(ge=1)
    hours: int | float = Field(ge=1, le=72)


class JobSpec(_Wire):
    """What to play: fixed when the run was ordered and paid for."""

    version: Literal[1]
    scenario: JobScenario
    agents: int = Field(ge=1, le=MAX_CROWD_SIZE)
    rounds: int = Field(ge=1, le=MAX_ROUNDS)
    mix: dict[str, int] | None = None
    batch_size: int = Field(ge=1, le=MAX_CROWD_SIZE)
    max_cost_usd: float = Field(ge=0)
    max_llm_calls: int = Field(ge=0)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    question: JobQuestion | None = None
    clone: dict[str, Any] | None = None
    rewind: JobRewind | None = None

    def to_scenario(self) -> Scenario:
        """The engine scenario; text is sanitized and capped like any scenario (``from_text``)."""
        source = self.scenario
        return from_text(
            source.title,
            source.seed_text,
            [{"round": e.round, "text": e.text} for e in source.events],
            ref="api",
            market=_market(source.market),
        )

    def to_sim_config(
        self,
        *,
        run_id: str,
        runs_dir: Path,
        offline: bool,
        timeout_s: float,
        fork: bool | None = None,
    ) -> SimConfig:
        scenario = self.to_scenario()
        scenario.check_rounds(self.rounds)
        return SimConfig(
            scenario=scenario,
            agents=self.agents,
            rounds=self.rounds,
            mix=dict(self.mix) if self.mix is not None else None,
            batch_size=self.batch_size,
            max_cost_usd=self.max_cost_usd,
            max_llm_calls=self.max_llm_calls,
            offline=offline,
            fork=fork,
            seed=self.seed,
            runs_dir=runs_dir,
            timeout_s=timeout_s,
            run_id=run_id,
            question=CrowdQuestionSpec(self.question.text, self.question.resolves_at) if self.question else None,
            clone=CloneProfile.from_mapping(self.clone) if self.clone is not None else None,
        )


class CloneJobSpec(_Wire):
    """The wallet that signed in and asked for its clone. The API puts it here; nothing else chooses it."""

    address: str = Field(pattern=r"^0x[0-9a-fA-F]{40}$")


class Job(BaseModel):
    """A claimed job. ``lease_id`` proves this runner holds it on every later call."""

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    run_id: str
    lease_id: str
    attempt: int
    heartbeat_interval_s: float
    timeout_s: float
    spec: JobSpec | DryRunSpec | CloneJobSpec
    kind: Literal["run", "dryrun", "clone"] = "run"
    raw_spec: dict[str, Any] | None = None  # a Dry Run's spec, as it came


def parse_job(payload: Any) -> Job:
    """Parse the ``job`` member of ``GET /internal/jobs/next``; raises ``JobError``.

    When only the spec is unreadable, the error carries ``run_id`` and ``lease_id`` so the runner
    can still call ``fail``.
    """
    if not isinstance(payload, dict):
        raise JobError("the job is not a JSON object")
    run_id, lease_id = payload.get("runId"), payload.get("leaseId")
    if not isinstance(run_id, str) or not _is_run_id(run_id):
        raise JobError(f"the job has no valid runId: {str(run_id)[:40]!r}")
    if not isinstance(lease_id, str) or not _LEASE_RE.match(lease_id):
        raise JobError("the job has no valid leaseId")
    attempt = payload.get("attempt")
    beat = payload.get("heartbeatIntervalS")
    timeout = payload.get("timeoutS")
    try:
        if isinstance(attempt, bool) or not isinstance(attempt, int) or attempt < 1:
            raise JobError("attempt must be a whole number >= 1")
        for name, value in (("heartbeatIntervalS", beat), ("timeoutS", timeout)):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not value > 0:
                raise JobError(f"{name} must be a number > 0")
        kind = payload.get("kind", "run")
        if kind == "dryrun":
            raw = payload.get("spec")
            if not isinstance(raw, dict):
                raise JobError("spec must be a JSON object")
            return Job(
                run_id=run_id,
                lease_id=lease_id,
                attempt=attempt,
                heartbeat_interval_s=float(beat),
                timeout_s=float(timeout),
                spec=from_mapping(raw),
                kind="dryrun",
                raw_spec=raw,
            )
        if kind == "clone":
            return Job(
                run_id=run_id,
                lease_id=lease_id,
                attempt=attempt,
                heartbeat_interval_s=float(beat),
                timeout_s=float(timeout),
                spec=CloneJobSpec.model_validate(payload.get("spec")),
                kind="clone",
            )
        if kind != "run":
            raise JobError(f"this runner cannot play a job of kind {str(kind)[:40]!r}")
        spec = JobSpec.model_validate_json(json.dumps(payload.get("spec")))
        if spec.mix is not None:
            parse_mix(",".join(f"{name}={count}" for name, count in spec.mix.items()), spec.agents)
        # Sanitizing can still empty a title or break a market value; events must fit the rounds.
        spec.to_scenario().check_rounds(spec.rounds)
    except JobError as error:
        raise JobError(str(error), run_id=run_id, lease_id=lease_id) from None
    except ValidationError as error:
        problem = error.errors()[0]
        where = ".".join(str(part) for part in problem["loc"]) or "spec"
        raise JobError(
            f"spec.{where}: {problem['msg']}", run_id=run_id, lease_id=lease_id
        ) from None
    except DryRunError as error:
        raise JobError(f"spec: {error}", run_id=run_id, lease_id=lease_id) from None
    except ValueError as error:  # ScenarioError and friends
        raise JobError(f"spec.scenario: {error}", run_id=run_id, lease_id=lease_id) from None
    return Job(
        run_id=run_id,
        lease_id=lease_id,
        attempt=attempt,
        heartbeat_interval_s=float(beat),
        timeout_s=float(timeout),
        spec=spec,
    )


def _market(market: JobMarket | None) -> MarketOverrides | None:
    if market is None:
        return None
    return MarketOverrides(
        token_symbol=market.token_symbol,
        # User text like the rest of the scenario; empty after sanitizing means the default name.
        token_name=sanitize_line(market.token_name, MAX_TOKEN_NAME_CHARS) or None if market.token_name else None,
        liquidity_eth=_decimal("liquidityEth", market.liquidity_eth),
        liquidity_tokens=_decimal("liquidityTokens", market.liquidity_tokens),
        fee_bps=market.fee_bps,
    )


def _decimal(name: str, value: str | None) -> Decimal | None:
    if value is None:
        return None
    if not re.fullmatch(r"[0-9]+(\.[0-9]+)?", value):
        raise JobError(f"{name} must be a decimal string such as '5' or '0.25'")
    try:
        return Decimal(value)
    except InvalidOperation:  # pragma: no cover (the pattern only lets valid decimals through)
        raise JobError(f"{name} is not a decimal number") from None


def _is_run_id(value: str) -> bool:
    try:
        run_id_to_bytes32(value)
    except ValueError:
        return False
    return True

