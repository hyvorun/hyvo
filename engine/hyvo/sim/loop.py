"""The simulation loop: one run of a crowd on its own anvil world and OASIS feed.

Per run: a run id and a seed; ``<runs_dir>/<runId>/`` with ``llm-log.jsonl`` (every LLM call,
written by the metered clients), ``events.jsonl`` (engine events) and ``social.db`` (the OASIS
feed); one shared ``BudgetMeter``; the crowd; a fresh anvil (forked or not), the test market with
the scenario's overrides, funded wallets (ETH from the crowd, tokens seeded by persona weight,
router approved); and the social world. Then each round:

1. ``set_round(n)`` and the decision snapshot (``market.state()``); the round's injected events.
2. The shared context (feed, market panel, events) and one card per agent (balances, PnL, own
   posts, replies to it, and the detailed market when it chose ``check_market`` last round). A crowd
   above ``wave_size`` plays steps 2 to 6 once per wave: a seeded share of the crowd, deciding from
   what the wave before it left. Otherwise thousands of swaps would all be sized on the price at the
   start of the round, and most would hit their slippage limit.
3. Batches of ``batch_size`` agents decided concurrently (``asyncio.to_thread``, at most
   ``max_concurrency`` calls in flight); when the budget cannot pay for every batch of the round,
   the batches run one by one in agent order, so the same seed and limits always refuse the same
   batches. A refused call (``BudgetExceeded``) makes the remaining agents hold (note
   ``budget_exhausted``); the round is finished and the run stops ``partial``. A round in which no
   batch got a decision is not recorded: the run ends at the previous round (or fails, when even
   round 1 got none), so run.json never holds a round nobody decided.
4. Social actions in agent order through OASIS (rejections go to events.jsonl, nothing else).
5. Market actions one by one in a seeded shuffle of the agents, only through ``Market``; each
   becomes one run.json action, listed in execution order (the verifier replays that order).
6. The market after the round, checked against the engine's own replay of the round's swaps.

The run also stops at a round boundary when ``timeout_s`` has passed (``partial``, ``timeout``).
At the end: posts with their final likes, the report (metered report client), run.json
(validated, hashed, written atomically), then ``verify_run`` and the price replay
``check_run_market`` on the written file: any disagreement is a bug and raises. Teardown always
runs: the social world is closed and anvil is stopped, so nothing keeps running or holds a file
in the run directory.
"""

from __future__ import annotations

import asyncio
import random
import secrets
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, fields, replace
from decimal import Decimal
from pathlib import Path
from typing import Any

from hyvo.clone import clone_persona
from hyvo.actions.execute import execute
from hyvo.actions.models import ActionLimits, ActionRecord, CheckMarket, Hold
from hyvo.config import Settings, load_settings
from hyvo.decisions import (
    GAS_RESERVE_ETH,
    AgentCard,
    Decision,
    DecisionBatch,
    RoundContext,
    hold_decisions,
    register_offline,
    request_decisions,
)
from hyvo.decisions.prompt import (
    MAX_CARD_POSTS,
    MAX_SWAPS,
    build_messages,
    max_tokens_for,
)
from hyvo.llm.budget import BudgetMeter, estimate_call_cost_usd
from hyvo.llm.factory import make_clients
from hyvo.sim.question import FLAG_INCOMPLETE as QUESTION_INCOMPLETE
from hyvo.sim.question import QuestionCard, ask_crowd
from hyvo.llm.log import LLM_LOG_NAME, LLMLog
from hyvo.llm.metered import MeteredClient
from hyvo.llm.types import (
    OFFLINE_MODEL_LABEL,
    BudgetExceeded,
    LLMClient,
    LLMRequestError,
)
from hyvo.personas import AgentSpec, generate_crowd, join_crowd, parse_mix
from hyvo.report import build_report  # also registers the report offline responders
from hyvo.report.guard import REMOVED_TEXT, find_violations
from hyvo.report.review import PostReview, review_posts
from hyvo.runfile import load_run, new_run_id, utc_timestamp, verify_run, write_run
from hyvo.runfile.io import schema_path
from hyvo.scenarios import Scenario, load_scenario_file
from hyvo.sim.config import RunOutcome, SimConfig, SimConfigError, SimulationError
from hyvo.sim.events import EVENTS_LOG_NAME, EventLog
from hyvo.sim.oasis_boot import import_oasis
from hyvo.sim.repeats import SaidLines, named_mentions
from hyvo.sim.rundoc import (
    RoundRecord,
    crowd_dict,
    persona_mix,
    report_input,
    run_document,
    run_rounds,
)
from hyvo.sim.social import SocialActionRejected, SocialPost, SocialWorld
from hyvo.sim.views import (
    SWAP_KINDS,
    SwapTape,
    feed_post,
    market_view,
    plan_action,
    reported_sentiment,
)
from hyvo.world.anvil import AnvilInstance
from hyvo.world.market import Market, MarketConfig
from hyvo.world.state import AgentBalances, MarketState
from hyvo.world.units import ETH_DECIMALS, format_amount
from hyvo.world.verify import check_run_market
from hyvo.world.wallets import Wallets

Progress = Callable[[str], None]

DECIDE_ATTEMPTS = 2  # a batch whose provider request failed is sent once more
REJECTED_RUN_NAME = "run.rejected.json"
_ORDER_DOMAIN = "hyvo.sim/market-order"
_WAVE_DOMAIN = "hyvo.sim/waves"


def prepare_process() -> None:
    """Process-wide setup, idempotent: import OASIS (it changes the working directory while it
    imports, so this runs before any worker thread) and register the offline responders."""
    import_oasis()
    register_offline()


def run_simulation(
    config: SimConfig,
    settings: Settings | None = None,
    *,
    clients: tuple[LLMClient, LLMClient] | None = None,
    progress: Progress | None = None,
) -> RunOutcome:
    """Play one run and write its ``run.json``; blocks until the run is over.

    Args:
        config: the run parameters.
        settings: engine settings (default: ``load_settings()``).
        clients: ``(agents_client, report_client)`` to use instead of ``make_clients``; they
            are wrapped in the run's metered clients (budget and llm-log.jsonl).
        progress: called with one line of text after each round.

    Raises ``SimConfigError``, ``ScenarioError``, ``PersonaMixError``, ``ConfigError`` or
    ``PricingUnknown`` before anything starts, and ``SimulationError`` (or the world's own
    errors) when the run fails; the world is torn down in every case.
    """
    settings = load_settings() if settings is None else settings
    simulation = _Simulation(config, settings, clients, progress)
    simulation.resolve()  # bad input fails here, before OASIS is imported or anything starts
    prepare_process()
    return asyncio.run(simulation.run())


async def run_simulation_async(
    config: SimConfig,
    settings: Settings | None = None,
    *,
    clients: tuple[LLMClient, LLMClient] | None = None,
    progress: Progress | None = None,
) -> RunOutcome:
    """``run_simulation`` for callers that already run an event loop. Call
    ``prepare_process()`` once before starting worker threads."""
    settings = load_settings() if settings is None else settings
    simulation = _Simulation(config, settings, clients, progress)
    simulation.resolve()
    prepare_process()
    return await simulation.run()


@dataclass(frozen=True)
class _BatchResult:
    decisions: DecisionBatch
    outcome: str  # "ok" | "budget_exhausted" | "llm_request_failed"
    error: str | None


class _Simulation:
    def __init__(
        self,
        config: SimConfig,
        settings: Settings,
        clients: tuple[LLMClient, LLMClient] | None,
        progress: Progress | None,
    ) -> None:
        self.config = config
        self.settings = settings
        self._clients = clients
        self._progress = progress
        self.started = time.monotonic()
        self.anvil: AnvilInstance | None = None
        self.social: SocialWorld | None = None
        self.events: EventLog | None = None
        self.records: list[RoundRecord] = []
        self.checkers: set[str] = set()  # chose check_market in the previous round
        self.recent_swaps: list[dict[str, Any]] = []  # every executed swap, prompt shape
        self.reply_targets: dict[str, str] = {}  # reply ref -> the post or reply it answered
        self.start_balances: dict[str, AgentBalances] = {}
        self._budget_noted = False
        self._resolved = False

    # --- setup ----------------------------------------------------------------------------------

    def resolve(self) -> None:
        """Everything that can be checked before a process, file or directory is created
        (idempotent)."""
        if self._resolved:
            return
        config, settings = self.config, self.settings
        if isinstance(config.scenario, Scenario):
            self.scenario = config.scenario
        else:
            scenario_file = Path(config.scenario).expanduser()
            if not scenario_file.is_file():
                raise SimConfigError(f"scenario file not found: {scenario_file}")
            self.scenario = load_scenario_file(scenario_file)
        schema = schema_path()
        if not schema.is_file():
            raise SimConfigError(
                f"run.json schema not found at {schema}: set HYVO_RUN_SCHEMA or run "
                "'pnpm --filter @hyvo/schema gen'"
            )
        self.scenario.check_rounds(config.rounds)
        self.seed = config.seed if config.seed is not None else secrets.randbelow(2**31)
        mix = parse_mix(config.mix, config.agents) if isinstance(config.mix, str) else config.mix
        self.crowd: list[AgentSpec] = generate_crowd(config.agents, mix, seed=self.seed)
        if config.clone is not None:
            self.crowd = join_crowd(self.crowd, clone_persona(config.clone), self.seed)
        self.personas = {spec.agent_id: spec.persona.id for spec in self.crowd}
        self.profiles = {spec.persona.id: spec.persona.describe() for spec in self.crowd}
        self.limits = {
            spec.persona.id: ActionLimits(
                per_agent_cap_eth=spec.per_agent_cap_eth,
                keep_eth=GAS_RESERVE_ETH,
                max_slippage_bps=config.max_slippage_bps,
            )
            for spec in self.crowd
        }
        self.fork_url = self._fork_url()
        self.market_config = market_config(self.scenario)
        self.max_cost_usd = (
            settings.max_cost_usd_default if config.max_cost_usd is None else config.max_cost_usd
        )
        self.max_llm_calls = (
            settings.max_llm_calls_default if config.max_llm_calls is None else config.max_llm_calls
        )
        if self._clients is not None:
            self.raw_agents, self.raw_report = self._clients
        else:
            self.raw_agents, self.raw_report = make_clients(settings, config.offline, seed=self.seed)
        self.offline = self.raw_agents.model_label == OFFLINE_MODEL_LABEL
        self.said = SaidLines(exact_only=self.offline)
        runs_dir = settings.runs_dir if config.runs_dir is None else Path(config.runs_dir)
        self.runs_dir = runs_dir.expanduser().resolve()
        self._resolved = True

    def _fork_url(self) -> str | None:
        url = self.settings.rh_rpc_url
        if self.config.fork is True and not url:
            raise SimConfigError("a fork was requested, but RH_RPC_URL is not set")
        if self.config.fork is False or not url:
            if self.config.fork_block is not None:
                raise SimConfigError("fork_block needs a fork: set RH_RPC_URL (and do not pass --no-fork)")
            return None
        return url

    def _make_anvil(self) -> AnvilInstance:
        extra: dict[str, Any] = {}
        if self.config.anvil_dir is not None:
            extra["base_dir"] = Path(self.config.anvil_dir)
        if self.fork_url is None:
            return AnvilInstance(**extra)
        return AnvilInstance.from_settings(
            self.settings, fork_block_number=self.config.fork_block, **extra
        )

    def _seed_tokens(self, spec: AgentSpec) -> str:
        """Whole tokens an agent starts with: its persona's token weight times
        ``seed_token_share`` of the pool's initial token liquidity, rounded down to base units."""
        share = Decimal(str(spec.initial_token_weight)) * self.config.seed_token_share
        units = int(share * self.market_config.liquidity_token_units)
        return format_amount(units, 18)

    async def _build_world(self) -> None:
        started = time.monotonic()
        self.anvil = self._make_anvil()
        self.anvil.start()
        self.market = Market.deploy(self.anvil, self.market_config)
        self.wallets = Wallets(self.market, run_seed=self.seed)
        for spec in self.crowd:
            self.wallets.add(
                spec.agent_id,
                eth=format_amount(spec.initial_eth_wei, ETH_DECIMALS),
                tokens=self._seed_tokens(spec),
            )
        self.initial_state = self.market.state()
        self.start_balances = {spec.agent_id: self.wallets.balances(spec.agent_id) for spec in self.crowd}
        self.previous_price = self.initial_state.price
        self.social = SocialWorld(self.run_dir, self.crowd)
        await self.social.start()
        self._event(
            "world_ready",
            anvil={
                "pid": self.anvil.pid,
                "port": self.anvil.port,
                "forked": self.anvil.forked,
                "forkBlock": self.anvil.fork_block,
            },
            market={
                "token": self.market.addresses.token,
                "weth": self.market.addresses.weth,
                "pair": self.market.addresses.pair,
                "router": self.market.addresses.router,
                "feeBps": self.market.fee_bps,
            },
            initialMarket=self.initial_state.to_run_market(),
            seconds=round(time.monotonic() - started, 3),
        )

    # --- the run --------------------------------------------------------------------------------

    async def run(self) -> RunOutcome:
        self.resolve()
        self.run_id = self.config.run_id or new_run_id()
        self.created_at = utc_timestamp()
        self.run_dir = self.runs_dir / self.run_id
        self.run_dir.mkdir(parents=True, exist_ok=False)
        self.events = EventLog(self.run_dir / EVENTS_LOG_NAME)
        self.budget = BudgetMeter(self.max_cost_usd, self.max_llm_calls)
        llm_log = LLMLog(self.run_dir / LLM_LOG_NAME)
        self.agents_client = MeteredClient(self.raw_agents, self.budget, llm_log)
        self.report_client = MeteredClient(self.raw_report, self.budget, llm_log)
        failure: BaseException | None = None
        try:
            self._event_started()
            await self._build_world()
            stop_reason = await self._play()
            return await self._finish(stop_reason)
        except BaseException as error:
            failure = error
            self._event("run_failed", error=_describe(error))
            raise
        finally:
            await self._teardown(failure)

    def _event_started(self) -> None:
        config = self.config
        self._event(
            "run_started",
            runId=self.run_id,
            seed=self.seed,
            scenario=self.scenario.title,
            agents=config.agents,
            rounds=config.rounds,
            personaMix=persona_mix(self.crowd),
            batchSize=config.batch_size,
            waveSize=config.wave_size,
            maxConcurrency=config.max_concurrency,
            maxCostUsd=self.max_cost_usd,
            maxLlmCalls=self.max_llm_calls,
            timeoutS=config.timeout_s,
            temperature=config.temperature,
            offline=self.offline,
            models={"agents": self.raw_agents.model_label, "report": self.raw_report.model_label},
            fork=self.fork_url is not None,
            forkBlock=config.fork_block,
            market={f.name: str(getattr(self.market_config, f.name)) for f in fields(MarketConfig)},
        )

    async def _play(self) -> str | None:
        """Play the rounds; return the stop reason, or None when every round was played."""
        rounds = self.config.rounds
        deadline = self.started + self.config.timeout_s
        for n in range(1, rounds + 1):
            # A round starts only if the agents can still pay for a call, and it is recorded
            # only if at least one batch got a decision.
            reason = self.budget.would_refuse("agents")
            record = await self._round(n) if reason is None else None
            if record is None:
                reason = reason or self.budget.stop_reason or "max_llm_calls"
                if not self.records:
                    raise SimulationError(
                        f"the LLM budget is too small for one round ({reason}): no agent decision "
                        "was made, so there is nothing to record"
                    )
                self._event(
                    "stopped",
                    reason=reason,
                    afterRound=n - 1,
                    elapsedS=round(time.monotonic() - self.started, 3),
                    usage=self.budget.usage(),
                )
                return reason
            self.records.append(record)
            self._report_progress(record)
            reason = self.budget.stop_reason
            if reason is None and n < rounds and time.monotonic() >= deadline:
                reason = "timeout"
            if reason is not None:
                self._event(
                    "stopped",
                    reason=reason,
                    afterRound=n,
                    elapsedS=round(time.monotonic() - self.started, 3),
                    usage=self.budget.usage(),
                )
                return reason
        return None

    async def _round(self, n: int) -> RoundRecord | None:
        """Play round ``n``; None when no batch got a decision (nothing was executed)."""
        started = time.monotonic()
        social = self._social_world()
        social.set_round(n)
        first = self.market.state()
        events_now = [event.text for event in self.scenario.events_at(n)]
        self._event(
            "round_started", round=n, injectedEvents=events_now, market=first.to_run_market()
        )
        record = RoundRecord(n=n, actions=[], swaps=[], market={}, sentiments={}, injected_events=events_now)
        snapshot = first
        for wave, members in enumerate(self._waves(n)):
            ctx = RoundContext(
                scenario_title=self.scenario.title,
                scenario_text=self.scenario.seed_text,
                round_n=n,
                total_rounds=self.config.rounds,
                events_now=events_now,
                events_earlier=[
                    (event.round, event.text)
                    for event in sorted(self.scenario.injected_events, key=lambda e: e.round)
                    if event.round < n
                ],
                market=market_view(
                    snapshot,
                    start_price=self.initial_state.price,
                    previous_price=self.previous_price if wave == 0 else first.price,
                    recent_swaps=self.recent_swaps[-MAX_SWAPS:],
                    change_period="last round" if wave == 0 else "so far this round",
                ),
                feed=[
                    feed_post(post)
                    for post in social.feed(self.config.feed_posts, self.config.feed_replies)
                ],
            )
            # Each agent's own posts and replies, newest first (what SocialWorld.posts_by returns),
            # from one read of the feed; only agents with content can have replies to them.
            own: dict[str, list[SocialPost]] = {}
            for post in reversed(social.all_content()):
                own.setdefault(post.author_agent_id, []).append(post)
            feed_ids = {post.id for post in ctx.feed}
            cards = [self._card(spec, snapshot, own.get(spec.agent_id, []), feed_ids) for spec in members]
            decisions, decided_batches = await self._decide(n, ctx, cards)
            if decided_batches == 0 and wave == 0:
                self._event("round_dropped", round=n, reason=self.budget.stop_reason)
                return None
            record.sentiments.update(
                {
                    agent_id: sentiment
                    for agent_id, decision in decisions.items()
                    if (sentiment := reported_sentiment(decision)) is not None
                }
            )
            await self._social_actions(n, members, decisions, record)
            tape = self._market_actions(n, wave, members, decisions, snapshot, record)
            snapshot = self.market.state()
            if snapshot.reserves != tape.reserves:
                raise SimulationError(
                    f"round {n}: the pool holds {snapshot.reserves}, but the executed swaps give "
                    f"{tape.reserves}"
                )
        record.market = snapshot.to_run_market()
        self.checkers = {
            r.agent_id for r in record.actions if r.kind == "check_market" and r.status == "ok"
        }
        self.previous_price = first.price
        self._event(
            "round_finished",
            round=n,
            market=record.market,
            swaps={kind: record.count(kind) for kind in SWAP_KINDS},
            reverted=record.reverted_count,
            invalid=record.invalid_count,
            posts=record.posts,
            replies=record.replies,
            likes=record.likes,
            rejected=record.rejections,
            seconds=round(time.monotonic() - started, 3),
            usage=self.budget.usage(),
        )
        return record

    def _waves(self, n: int) -> list[list[AgentSpec]]:
        """Who plays together in round ``n``: everyone in agent order, or for a large crowd groups of
        ``wave_size`` in a seeded order, so that who moves first changes from round to round."""
        size = self.config.wave_size
        if len(self.crowd) <= size:
            return [list(self.crowd)]
        order = list(self.crowd)
        random.Random(f"{_WAVE_DOMAIN}:{self.seed}:{n}").shuffle(order)
        return [order[start : start + size] for start in range(0, len(order), size)]

    def _card(
        self,
        spec: AgentSpec,
        snapshot: MarketState,
        own_posts: Sequence[SocialPost],
        feed_ids: set[str],
    ) -> AgentCard:
        social = self._social_world()
        balances = self.wallets.balances(spec.agent_id)
        pnl = self.wallets.pnl(spec.agent_id, snapshot.reserves)
        replies = social.replies_to(spec.agent_id, MAX_CARD_POSTS) if own_posts else []
        shown = feed_ids | {post.ref for post in replies}
        return AgentCard(
            agent_id=spec.agent_id,
            handle=spec.handle,
            persona_id=spec.persona.id,
            profile=self.profiles[spec.persona.id],
            eth_balance=format_amount(balances.eth, ETH_DECIMALS),
            token_balance=format_amount(balances.token, self.market.token_decimals),
            token_value_eth=format_amount(pnl.token_value, ETH_DECIMALS),
            pnl_eth=pnl.to_dict()["pnl_eth"],
            cap_eth=str(spec.per_agent_cap_eth),
            own_recent_posts=[feed_post(post) for post in own_posts[:MAX_CARD_POSTS]],
            replies_to_me=[feed_post(post) for post in replies],
            detailed_market=(
                snapshot.to_prompt_dict() if spec.agent_id in self.checkers else None
            ),
            liked=sorted(social.liked_by(spec.agent_id) & shown),
        )

    # --- decisions ------------------------------------------------------------------------------

    async def _decide(
        self, n: int, ctx: RoundContext, cards: Sequence[AgentCard]
    ) -> tuple[dict[str, Decision], int]:
        """Every agent's decision and the number of batches that got one."""
        size = self.config.batch_size
        batches = [list(cards[start : start + size]) for start in range(0, len(cards), size)]
        if self._budget_covers(ctx, batches):
            semaphore = asyncio.Semaphore(self.config.max_concurrency)

            async def decide(index: int, batch: list[AgentCard]) -> _BatchResult:
                async with semaphore:
                    return await self._decide_batch(n, index, ctx, batch)

            results = list(await asyncio.gather(*(decide(i, b) for i, b in enumerate(batches))))
        else:
            # The budget runs out in this round: decide in agent order so that the batches
            # refused are always the same ones (thread timing must not pick them).
            results = [await self._decide_batch(n, i, ctx, b) for i, b in enumerate(batches)]
        if all(result.outcome == "llm_request_failed" for result in results):
            raise SimulationError(
                f"round {n}: every decision call failed at the LLM provider "
                f"(last error: {results[-1].error})"
            )
        decisions: dict[str, Decision] = {}
        for result in results:
            decisions.update(result.decisions)
        decided = sum(1 for result in results if result.outcome == "ok")
        return {card.agent_id: decisions[card.agent_id] for card in cards}, decided

    def _budget_covers(self, ctx: RoundContext, batches: Sequence[Sequence[AgentCard]]) -> bool:
        """Whether the budget can pay for one call per batch at the pre-call estimates."""
        prices = self.raw_agents.prices
        estimate = sum(
            estimate_call_cost_usd(build_messages(ctx, list(batch)), max_tokens_for(len(batch)), prices)
            for batch in batches
        )
        return self.budget.would_refuse("agents", estimate, calls=len(batches)) is None

    async def _decide_batch(
        self, n: int, index: int, ctx: RoundContext, batch: list[AgentCard]
    ) -> _BatchResult:
        agent_ids = [card.agent_id for card in batch]
        started = time.monotonic()
        outcome, error, decided = "budget_exhausted", None, None
        for _ in range(DECIDE_ATTEMPTS):
            if self.budget.stop_reason is not None:
                outcome = "budget_exhausted"
                break
            try:
                decided = await asyncio.to_thread(
                    request_decisions,
                    self.agents_client,
                    ctx,
                    batch,
                    temperature=self.config.temperature,
                )
            except BudgetExceeded:
                outcome = "budget_exhausted"
                break
            except LLMRequestError as failed:
                outcome, error = "llm_request_failed", str(failed)
                continue
            outcome = "ok"
            break
        if decided is None:
            decided = hold_decisions(agent_ids, outcome)
            decided.notes.append(outcome)
        if outcome == "budget_exhausted" and not self._budget_noted:
            self._budget_noted = True
            self._event(
                "budget_exhausted",
                round=n,
                reason=self.budget.stop_reason,
                usage=self.budget.usage(),
            )
        if outcome == "llm_request_failed":
            self._event("llm_request_failed", round=n, batch=index, agents=agent_ids, error=error)
        self._event(
            "batch",
            round=n,
            batch=index,
            agents=agent_ids,
            outcome=outcome,
            notes=list(decided.notes),
            error=error,
            seconds=round(time.monotonic() - started, 3),
            decisions=[decided[agent_id].to_dict() for agent_id in agent_ids],
        )
        return _BatchResult(decided, outcome, error)

    # --- actions --------------------------------------------------------------------------------

    async def _social_actions(
        self, n: int, members: Sequence[AgentSpec], decisions: dict[str, Decision], record: RoundRecord
    ) -> None:
        """Posts, replies and likes in agent order; rejected ones are logged and skipped."""
        social = self._social_world()
        handles = {spec.agent_id: spec.handle for spec in self.crowd}
        for spec in members:
            decision = decisions[spec.agent_id]
            post = decision.post
            text = "" if post is None else named_mentions(post.text, handles)
            if post is not None and self._already_said(n, spec.agent_id, text):
                post = None
            if post is not None:
                try:
                    if post.reply_to is None:
                        await social.create_post(spec.agent_id, text)
                        record.posts += 1
                    else:
                        ref = await social.create_reply(spec.agent_id, post.reply_to, text)
                        self.reply_targets[ref] = post.reply_to
                        record.replies += 1
                except SocialActionRejected as rejected:
                    self._rejected(rejected.rejection, record)
            for ref in decision.likes:
                if await social.like(spec.agent_id, ref):
                    record.likes += 1
                else:
                    self._rejected(social.rejections[-1], record)

    def _already_said(self, n: int, agent_id: str, text: str) -> bool:
        """Remember what the crowd posted; True when anyone already posted this line (hyvo.sim.repeats)."""
        if self.said.repeats(text):
            self._event("post_repeat_dropped", round=n, agentId=agent_id)
            return True
        return False

    def _rejected(self, rejection: Any, record: RoundRecord) -> None:
        record.rejections += 1
        self._event(
            "social_rejected",
            round=rejection.round,
            agentId=rejection.agent_id,
            action=rejection.action,
            target=rejection.target,
            reason=rejection.reason,
        )

    def _market_actions(
        self,
        n: int,
        wave: int,
        members: Sequence[AgentSpec],
        decisions: dict[str, Decision],
        snapshot: MarketState,
        record: RoundRecord,
    ) -> SwapTape:
        """One market action per agent, sequentially, in a seeded shuffle of those playing."""
        order = list(members)
        random.Random(f"{_ORDER_DOMAIN}:{self.seed}:{n}" + (f":{wave}" if wave else "")).shuffle(order)
        tape = SwapTape(snapshot.reserves, self.market.token_decimals)
        for spec in order:
            decision = decisions[spec.agent_id]
            action = self._act(spec, decision, snapshot)
            record.actions.append(action)
            if action.status == "ok" and action.kind in SWAP_KINDS:
                if action.amount_in is None or action.amount_out is None:
                    raise SimulationError(f"round {n}: executed swap of {spec.agent_id} has no amounts")
                before, after = tape.apply(action.kind, action.amount_in, action.amount_out)
                record.swaps.append(
                    {
                        "agentId": spec.agent_id,
                        "persona": spec.persona.id,
                        "kind": action.kind,
                        "amountIn": action.amount_in,
                        "amountOut": action.amount_out,
                        "priceBefore": before,
                        "priceAfter": after,
                        "reason": decision.reason,
                    }
                )
                self.recent_swaps.append(
                    {
                        "handle": spec.handle,
                        "kind": action.kind,
                        "amountIn": action.amount_in,
                        "amountOut": action.amount_out,
                        "priceAfter": after,
                    }
                )
            if action.kind != "hold" or action.status != "ok" or action.note is not None:
                self._event("action", round=n, persona=spec.persona.id, **action.to_dict())
        return tape

    def _act(self, spec: AgentSpec, decision: Decision, snapshot: MarketState) -> ActionRecord:
        plan = plan_action(decision)
        if plan.invalid is not None:
            return ActionRecord.invalid(spec.agent_id, plan.invalid)
        if plan.forced is not None:
            return ActionRecord(
                agent_id=spec.agent_id,
                kind="hold",
                amount_in=None,
                amount_out=None,
                tx_hash=None,
                status="ok",
                note=plan.forced,
            )
        if isinstance(plan.action, (Hold, CheckMarket)):
            return ActionRecord.no_tx(spec.agent_id, plan.action.kind)
        return execute(
            self.market,
            self.wallets[spec.agent_id],
            plan.action,
            snapshot.reserves,
            self.limits[spec.persona.id],
        )

    # --- the end --------------------------------------------------------------------------------

    async def _finish(self, stop_reason: str | None) -> RunOutcome:
        status = "complete" if stop_reason is None else "partial"
        content, review_flags = await asyncio.to_thread(self._reviewed, self._social_world().all_content())
        crowd = crowd_dict(
            self.crowd,
            self.agents_client.model_label,
            self.report_client.model_label,
            self.config.temperature,
            start={
                agent_id: {
                    "startEth": format_amount(balances.eth, ETH_DECIMALS),
                    "startTokens": format_amount(balances.token, self.market.token_decimals),
                }
                for agent_id, balances in self.start_balances.items()
            },
        )
        scenario = self.scenario.to_run_dict()
        inp = report_input(
            scenario=scenario,
            crowd=crowd,
            initial_market=self.initial_state.to_run_market(),
            records=self.records,
            content=content,
            personas=self.personas,
            status=status,
            stop_reason=stop_reason,
            reply_targets=self.reply_targets,
        )
        report = await asyncio.to_thread(build_report, inp, self.report_client)
        question, question_flags = await asyncio.to_thread(self._ask_crowd, content)
        self._event(
            "report",
            llmUsed=report.llm_used,
            notes=report.notes,
            flags=report.report.get("flags", []),
        )
        document = run_document(
            run_id=self.run_id,
            created_at=self.created_at,
            status=status,
            stop_reason=stop_reason,
            scenario=scenario,
            world=self.market.run_world(self.initial_state.to_run_market()),
            crowd=crowd,
            rounds=run_rounds(self.records, content, self.reply_targets),
            report={**report.report, "flags": [*report.report.get("flags", []), *review_flags, *question_flags]},
            usage=self.budget.usage(),
            question=question,
            rewind=self.config.rewind,
        )
        path = write_run(self.run_dir, document)
        written, mismatches = self._check_written(path)
        elapsed = round(time.monotonic() - self.started, 3)
        outcome = RunOutcome(
            run_id=self.run_id,
            run_dir=self.run_dir,
            path=path,
            status=status,
            stop_reason=stop_reason,
            hash=written["hash"],
            usage=dict(written["usage"]),
            mismatches=mismatches,
            seed=self.seed,
            rounds=len(self.records),
            offline=self.offline,
            models={"agents": crowd["model"]["agents"], "report": crowd["model"]["report"]},
            elapsed_s=elapsed,
        )
        self._event(
            "run_finished",
            status=status,
            stopReason=stop_reason,
            rounds=len(self.records),
            hash=outcome.hash,
            path=str(path),
            usage=outcome.usage,
            elapsedS=elapsed,
        )
        return outcome

    def _ask_crowd(self, content: list[SocialPost]) -> tuple[dict[str, Any] | None, list[str]]:
        """What each agent expects, when the run has a question. It comes after the report, so that a run that spent its
        budget still has its report; the agents it could not ask stay unsure, and the flag says so."""
        question = self.config.question
        if question is None:
            return None, []
        said: dict[str, str] = {}
        for post in content:
            if post.text != REMOVED_TEXT:
                said[post.author_agent_id] = post.text
        cards = []
        for spec in self.crowd:
            balances = self.wallets.balances(spec.agent_id)
            cards.append(
                QuestionCard(
                    agent_id=spec.agent_id,
                    persona=spec.persona.id,
                    eth=format_amount(balances.eth, ETH_DECIMALS),
                    tokens=format_amount(balances.token, self.market.token_decimals),
                    said=said.get(spec.agent_id, ""),
                )
            )
        start, end = self.initial_state.to_run_market()["price"], self.records[-1].market["price"]
        story = f"{self.scenario.title}\nThe test market's price went from {start} to {end} ETH over {len(self.records)} rounds."
        answers = ask_crowd(question, cards, story, self.agents_client, temperature=self.config.temperature)
        self._event("crowd_question", answers=answers.section["answers"], complete=answers.complete)
        return answers.section, [] if answers.complete else [QUESTION_INCOMPLETE]

    def _reviewed(self, content: list[SocialPost]) -> tuple[list[SocialPost], list[str]]:
        """The last read of the posts, before the run is hashed: the report model's (hyvo.report.review), and the copy guard's. A post
        that breaks a rule goes here, so that one bad line does not cost a whole run at ``hyvo publish``. The offline model writes from
        templates, so the model has nothing to read there."""
        if not content:
            return content, []
        review = (
            PostReview(frozenset(), True)
            if self.offline
            else review_posts([(post.ref, post.text) for post in content], self.report_client)
        )
        broken = {post.ref for post in content if post.text != REMOVED_TEXT and find_violations(post.text)}
        self._event("post_review", flagged=sorted(review.flagged), broken=sorted(broken), complete=review.complete)
        final = PostReview(review.flagged | broken, review.complete)
        return (
            [replace(post, text=REMOVED_TEXT) if post.ref in final.flagged else post for post in content],
            final.flags(),
        )

    def _check_written(self, path: Path) -> tuple[dict[str, Any], list[str]]:
        """Verify the written file (hash, models, JSON Schema) and replay its swaps from the
        reserves before round 1. A failure is an engine bug: the file is renamed to
        ``run.rejected.json`` so no unverified run.json is left behind, and the run fails."""
        problems: list[str] = []
        written: dict[str, Any] = {}
        mismatches: list[str] = []
        try:
            verified = verify_run(path)
            if not verified.ok:
                if verified.expected != verified.actual:
                    problems.append(f"hash {verified.actual} != recomputed {verified.expected}")
                problems += [*verified.model_errors, *verified.schema_errors]
            written = load_run(path)
            if written["world"]["initialMarket"] != self.initial_state.to_run_market():
                problems.append("world.initialMarket differs from the chain before round 1")
            mismatches = check_run_market(written)
            problems += mismatches
        except Exception as error:  # noqa: BLE001 (an unverifiable file must not stay as run.json)
            problems.append(f"verification failed: {_describe(error)}")
        if problems:
            path.replace(path.with_name(REJECTED_RUN_NAME))
            raise SimulationError(
                f"the written run.json failed verification ({len(problems)} problems, "
                f"kept as {REJECTED_RUN_NAME}): {'; '.join(problems[:5])}"
            )
        return written, mismatches

    async def _teardown(self, failure: BaseException | None) -> None:
        """Close the social world and stop anvil, whatever happened; raise if either is left
        behind after an otherwise successful run."""
        problems: list[str] = []
        cancelled: BaseException | None = None
        if self.social is not None:
            try:
                await self.social.close()
            except asyncio.CancelledError as error:
                cancelled = error
            except Exception as error:  # noqa: BLE001 (teardown must reach anvil.stop)
                problems.append(f"social world: {_describe(error)}")
        if self.anvil is not None:
            try:
                self.anvil.stop()
            except Exception as error:  # noqa: BLE001
                problems.append(f"anvil: {_describe(error)}")
        if self.events is not None:
            self._event("teardown", ok=not problems, problems=problems)
            self.events.close()
        if cancelled is not None:
            raise cancelled
        if problems and failure is None:
            raise SimulationError("teardown failed: " + "; ".join(problems))

    # --- helpers --------------------------------------------------------------------------------

    def _social_world(self) -> SocialWorld:
        if self.social is None:
            raise SimulationError("the social world is not running")
        return self.social

    def _event(self, name: str, **data: Any) -> None:
        if self.events is not None and not self.events.closed:
            self.events.write(name, **data)

    def _report_progress(self, record: RoundRecord) -> None:
        if self._progress is None:
            return
        usage = self.budget.usage()
        self._progress(
            f"round {record.n}/{self.config.rounds}: price {record.market['price']} ETH, "
            f"{record.count('swap_buy')} buys, {record.count('swap_sell')} sells, "
            f"{record.reverted_count} reverted, {record.invalid_count} invalid, "
            f"{record.posts} posts, {record.replies} replies, {record.likes} likes, "
            f"{usage['llmCalls']} LLM calls"
        )


def market_config(scenario: Scenario) -> MarketConfig:
    """The world's market: ``MarketConfig`` defaults with the scenario's overrides."""
    overrides = scenario.market
    if overrides is None:
        return MarketConfig()
    values = {
        f.name: getattr(overrides, f.name)
        for f in fields(overrides)
        if getattr(overrides, f.name) is not None
    }
    return MarketConfig(**values)


def _describe(error: BaseException) -> str:
    text = str(error).strip()
    return f"{type(error).__name__}: {text}" if text else type(error).__name__
