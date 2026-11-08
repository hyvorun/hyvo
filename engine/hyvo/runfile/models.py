"""Pydantic v2 models for ``run.json`` version 1, mirroring docs/RUN_FORMAT.md.

JSON member names are camelCase (aliases); Python attributes are snake_case. Every model validates
strictly (no string-to-number coercion) and forbids unknown members. ``RunV1`` adds the cross-field
rules. The rules are kept identical to the zod schema in ``packages/schema/src/run.ts`` (its JSON
Schema export carries only the per-field rules). String lengths count Unicode code points, as
Python ``len()``, JSON Schema and the zod schema do; integers are limited to the safe range of
zod's ``z.int()`` (at most 2**53 - 1).

One deliberate difference: an integer field must hold a JSON integer here, so ``2.0`` is rejected,
while JavaScript cannot tell ``2.0`` from ``2`` and zod accepts it. Both canonicalize to ``2`` (same
hash), and the engine, the only producer of run.json, always writes integers.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
    SerializerFunctionWrapHandler,
    model_serializer,
)
from pydantic.alias_generators import to_camel
from pydantic_core import PydanticCustomError

DISCLAIMER = "Synthetic crowd reaction. Not a trading signal."
RUN_RULES_ERROR = "run_rules"

SWAP_KINDS = frozenset({"swap_buy", "swap_sell"})


def _check_calendar(value: str) -> str:
    datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")  # rejects impossible dates such as 02-30
    return value


def _check_six_decimals(value: float) -> float:
    if round(value, 6) != value:
        raise ValueError("costUsd must be rounded to 6 decimals")
    return value


def _check_four_decimals(value: float) -> float:
    if round(value, 4) != value:
        raise ValueError("sentiment must have at most 4 decimal places")
    return value


# Primitive formats (RUN_FORMAT.md "Primitive formats"). Explicit [0-9]: \d is Unicode-aware.
# A ULID is 128 bits, so its first Crockford character is 0-7.
RunId = Annotated[str, StringConstraints(pattern=r"^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$")]
Timestamp = Annotated[
    str,
    StringConstraints(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"),
    AfterValidator(_check_calendar),
]
Address = Annotated[str, StringConstraints(pattern=r"^0x[0-9a-fA-F]{40}$")]
Hash32 = Annotated[str, StringConstraints(pattern=r"^0x[0-9a-f]{64}$")]
DecimalStr = Annotated[str, StringConstraints(pattern=r"^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$")]
AgentId = Annotated[str, StringConstraints(pattern=r"^a[0-9]{2,4}$")]
PostId = Annotated[str, StringConstraints(pattern=r"^[pc][0-9]+$")]
Handle = Annotated[str, StringConstraints(pattern=r"^@[a-z0-9_]{3,30}$")]
SAFE_INT_MAX = 2**53 - 1  # zod z.int() accepts safe integers only
NonNegInt = Annotated[int, Field(ge=0, le=SAFE_INT_MAX)]
PositiveInt = Annotated[int, Field(ge=1, le=SAFE_INT_MAX)]
Sentiment = Annotated[
    float, Field(ge=-1.0, le=1.0, allow_inf_nan=False), AfterValidator(_check_four_decimals)
]
Title = Annotated[str, StringConstraints(min_length=1, max_length=200)]
SeedText = Annotated[str, StringConstraints(max_length=4000)]
EventText = Annotated[str, StringConstraints(min_length=1, max_length=500)]
SummaryText = Annotated[str, StringConstraints(max_length=1500)]
WhyText = Annotated[str, StringConstraints(max_length=800)]
ItemText = Annotated[str, StringConstraints(max_length=400)]
Note = Annotated[str, StringConstraints(min_length=1)]

Persona = Literal[
    "sniper", "holder", "panic_seller", "skeptic", "swing_trader", "whale", "kol_follower", "market_maker_bot", "stock_token_holder", "newcomer", "clone"
]
PERSONAS_STAGE1: tuple[str, ...] = ("sniper", "holder", "panic_seller", "skeptic")
PERSONAS_LATER: tuple[str, ...] = ("swing_trader", "whale", "kol_follower", "market_maker_bot", "stock_token_holder", "newcomer")
PERSONAS: tuple[str, ...] = (*PERSONAS_STAGE1, *PERSONAS_LATER)
RUN_PERSONAS: tuple[str, ...] = (*PERSONAS, "clone")  # a run has at most one clone, and a mix cannot ask for it
ActionKind = Literal["swap_buy", "swap_sell", "hold", "check_market"]
ActionStatus = Literal["ok", "reverted", "invalid"]
RunStatus = Literal["complete", "partial"]
StopReason = Literal["max_cost_usd", "max_llm_calls", "timeout"]


class _Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, extra="forbid", strict=True)


class SeedSource(_Model):
    kind: Literal["url", "onchain", "user"]
    ref: str


class InjectedEvent(_Model):
    round: PositiveInt
    text: EventText


class Scenario(_Model):
    title: Title
    seed_text: SeedText
    seed_sources: list[SeedSource]
    injected_events: list[InjectedEvent]


class Pool(_Model):
    address: Address
    token0: Address
    token1: Address
    kind: Literal["v2-test", "real"]
    fee_bps: int = Field(ge=0, le=10_000)


class TokenInfo(_Model):
    address: Address
    symbol: str
    name: str
    decimals: int = Field(ge=0, le=255)


class QuoteInfo(_Model):
    address: Address
    symbol: str
    decimals: int = Field(ge=0, le=255)


class Market(_Model):
    price: DecimalStr
    reserve0: DecimalStr
    reserve1: DecimalStr
    holders: NonNegInt


class World(_Model):
    chain_id: PositiveInt
    fork_block: NonNegInt | None
    pools: list[Pool] = Field(min_length=1)
    token: TokenInfo
    quote: QuoteInfo
    initial_market: Market  # after deploy, liquidity and token seeding; before round 1


class ModelInfo(_Model):
    agents: str = Field(min_length=1)
    report: str = Field(min_length=1)
    temperature: float = Field(ge=0.0, allow_inf_nan=False)


class Agent(_Model):
    agent_id: AgentId
    handle: Handle
    persona: Persona
    start_eth: DecimalStr
    start_tokens: DecimalStr


class PersonaMix(_Model):
    """Agents per archetype. Every Stage 1 archetype is present (zero allowed); a later one only when the crowd has it, so a
    run from before them reads and hashes as it did."""

    sniper: NonNegInt
    holder: NonNegInt
    panic_seller: NonNegInt = Field(alias="panic_seller")
    skeptic: NonNegInt
    swing_trader: NonNegInt | None = Field(default=None, alias="swing_trader")
    whale: NonNegInt | None = None
    kol_follower: NonNegInt | None = Field(default=None, alias="kol_follower")
    market_maker_bot: NonNegInt | None = Field(default=None, alias="market_maker_bot")
    stock_token_holder: NonNegInt | None = Field(default=None, alias="stock_token_holder")
    newcomer: NonNegInt | None = None
    clone: int | None = Field(default=None, ge=0, le=1)

    @model_serializer(mode="wrap")
    def _without_absent(self, handler: Any) -> dict[str, Any]:
        return {key: value for key, value in handler(self).items() if value is not None}

    def counts(self) -> dict[str, int]:
        return {persona: getattr(self, persona) or 0 for persona in RUN_PERSONAS}


class Crowd(_Model):
    size: PositiveInt
    persona_mix: PersonaMix
    model: ModelInfo
    agents: list[Agent]


class Post(_Model):
    id: PostId
    agent_id: AgentId
    text: str
    reply_to: PostId | None
    likes: NonNegInt

    @model_validator(mode="after")
    def _id_matches_reply(self) -> Post:
        if self.id.startswith("p") and self.reply_to is not None:
            raise ValueError("a reply must use a 'c<n>' id; 'p<n>' ids are top-level posts")
        if self.id.startswith("c") and self.reply_to is None:
            raise ValueError("a 'c<n>' id is a reply, so replyTo must be set")
        return self


class Action(_Model):
    agent_id: AgentId
    kind: ActionKind
    amount_in: DecimalStr | None
    amount_out: DecimalStr | None
    tx_hash: Hash32 | None
    status: ActionStatus
    note: Note | None

    @model_validator(mode="after")
    def _kind_rules(self) -> Action:
        if self.status == "invalid" and self.kind != "hold":
            raise ValueError("an invalid action is converted to hold, so kind must be 'hold'")
        if self.kind in SWAP_KINDS:
            if self.tx_hash is None:
                raise ValueError("a sent swap ('ok' or 'reverted') must have a txHash")
            if self.status == "ok" and (self.amount_in is None or self.amount_out is None):
                raise ValueError("an executed swap must have amountIn and amountOut")
            return self
        if self.amount_in is not None or self.amount_out is not None:
            raise ValueError(f"{self.kind} must have null amountIn and amountOut")
        if self.tx_hash is not None:
            raise ValueError(f"{self.kind} sends no transaction, so txHash must be null")
        if self.status == "reverted":
            raise ValueError(f"{self.kind} sends no transaction, so it cannot be 'reverted'")
        if self.status == "invalid" and self.note is None:
            raise ValueError("an invalid action needs a note saying why it was rejected")
        return self


class Round(_Model):
    n: PositiveInt
    posts: list[Post]
    actions: list[Action]
    market: Market


class TurningPoint(_Model):
    round: PositiveInt
    why: WhyText


class Report(_Model):
    summary: SummaryText
    turning_point: TurningPoint | None
    sentiment_by_round: list[Sentiment]
    objections: list[ItemText] = Field(max_length=5)
    price_drivers: list[ItemText] = Field(max_length=5)
    disclaimer: Literal["Synthetic crowd reaction. Not a trading signal."]
    flags: list[str]


class Usage(_Model):
    llm_calls: NonNegInt
    input_tokens: NonNegInt
    output_tokens: NonNegInt
    cost_usd: Annotated[float, Field(ge=0.0, allow_inf_nan=False), AfterValidator(_check_six_decimals)]


class QuestionAnswers(_Model):
    yes: int = Field(ge=0)
    no: int = Field(ge=0)
    unsure: int = Field(ge=0)


class CrowdQuestion(_Model):
    """What each agent expects, hashed with the run before the outcome is known."""

    text: str = Field(min_length=1, max_length=300)
    resolves_at: Timestamp
    answers: QuestionAnswers
    by_agent: dict[str, Literal["yes", "no", "unsure"]]
    expectation: Literal["yes", "no", "split"]


class RewindPoint(_Model):
    block: NonNegInt
    at: Timestamp
    price: DecimalStr
    reserve_eth: DecimalStr
    reserve_token: DecimalStr


class Rewind(_Model):
    """A real pool's past, read from the chain before the run started, and the one thing that differs."""

    pool: Address
    block: NonNegInt
    at: Timestamp
    hours: float = Field(gt=0, allow_inf_nan=False)
    change: str = Field(min_length=1, max_length=500)
    actual: list[RewindPoint] = Field(min_length=2)


class RunV1(_Model):
    run_id: RunId
    version: int = Field(ge=1, le=1)  # strict int: Literal[1] would also accept True
    created_at: Timestamp
    status: RunStatus
    stop_reason: StopReason | None
    scenario: Scenario
    world: World
    crowd: Crowd
    rounds: list[Round]
    report: Report
    usage: Usage
    hash: Hash32
    question: CrowdQuestion | None = None
    rewind: Rewind | None = None

    @model_serializer(mode="wrap")
    def _no_question_no_field(self, handler: SerializerFunctionWrapHandler) -> dict[str, object]:
        # A run without a question or a rewind hashes as it always has: the field is absent, not null.
        data = handler(self)
        for optional in ("question", "rewind"):
            if data.get(optional) is None:
                data.pop(optional, None)
        return data

    @model_validator(mode="after")
    def _cross_field_rules(self) -> RunV1:
        problems = rule_violations(self)
        if problems:
            raise PydanticCustomError(
                RUN_RULES_ERROR, "{summary}", {"summary": "; ".join(problems), "problems": problems}
            )
        return self


def _question_violations(run: RunV1) -> list[str]:
    question = run.question
    if question is None:
        return []
    agents = [agent.agent_id for agent in run.crowd.agents]
    problems = []
    if set(question.by_agent) != set(agents):
        problems.append("question.byAgent must hold one answer per agent")
    given = list(question.by_agent.values())
    for answer in ("yes", "no", "unsure"):
        if getattr(question.answers, answer) != given.count(answer):
            problems.append(f"question.answers.{answer} is {getattr(question.answers, answer)} but byAgent has {given.count(answer)}")
    yes, no = question.answers.yes, question.answers.no
    lean = "yes" if yes > no else "no" if no > yes else "split"
    if question.expectation != lean:
        problems.append(f'question.expectation must be "{lean}" for these answers')
    return problems


def _rewind_violations(run: RunV1) -> list[str]:
    """A rewind starts where the fork starts, and its path runs forward."""
    rewind = run.rewind
    if rewind is None:
        return []
    problems = []
    if run.world.fork_block != rewind.block:
        problems.append("rewind.block must be the block the run was forked at")
    if rewind.actual[0].block != rewind.block:
        problems.append("rewind.actual must start at the rewind's block")
    if any(later.block <= earlier.block for earlier, later in zip(rewind.actual, rewind.actual[1:], strict=False)):
        problems.append("rewind.actual must run forward")
    return problems


def rule_violations(run: RunV1) -> list[str]:
    """Return the cross-field rule violations of an otherwise well-typed run (empty when valid)."""
    problems = [*_crowd_violations(run.crowd), *_question_violations(run), *_rewind_violations(run)]
    seeded = sum(agent.start_tokens != "0" for agent in run.crowd.agents)
    if run.world.initial_market.holders != seeded:
        problems.append(
            f"world.initialMarket.holders is {run.world.initial_market.holders}, but {seeded} "
            "agents have startTokens > 0"
        )
    if run.status == "complete" and run.stop_reason is not None:
        problems.append("status 'complete' requires stopReason null")
    if run.status == "partial" and run.stop_reason is None:
        problems.append("status 'partial' requires a stopReason")
    agent_order = [agent.agent_id for agent in run.crowd.agents]
    problems += _round_violations(run.rounds, agent_order, run.crowd.size)
    report = run.report
    if len(report.sentiment_by_round) != len(run.rounds):
        problems.append(
            f"report.sentimentByRound has {len(report.sentiment_by_round)} values, "
            f"expected one per round ({len(run.rounds)})"
        )
    if report.turning_point is not None and report.turning_point.round > len(run.rounds):
        problems.append(
            f"report.turningPoint.round {report.turning_point.round} is not a round of this run"
        )
    return problems


def _crowd_violations(crowd: Crowd) -> list[str]:
    problems: list[str] = []
    mix = crowd.persona_mix.counts()
    mix_total = sum(mix.values())
    if mix_total != crowd.size:
        problems.append(f"crowd.personaMix sums to {mix_total}, expected crowd.size {crowd.size}")
    if len(crowd.agents) != crowd.size:
        problems.append(f"crowd.agents has {len(crowd.agents)} entries, expected {crowd.size}")
    width = max(2, len(str(crowd.size)))
    seen: set[str] = set()
    persona_counts: dict[str, int] = {}
    for index, agent in enumerate(crowd.agents):
        where = f"crowd.agents[{index}]"
        if agent.agent_id in seen:
            problems.append(f"{where}.agentId {agent.agent_id!r} is duplicated")
        seen.add(agent.agent_id)
        if len(agent.agent_id) - 1 != width:
            problems.append(
                f"{where}.agentId {agent.agent_id!r} must be zero-padded to {width} digits"
            )
        persona_counts[agent.persona] = persona_counts.get(agent.persona, 0) + 1
    for persona, expected in mix.items():
        count = persona_counts.get(persona, 0)
        if expected != count:
            problems.append(f"crowd.personaMix.{persona} is {expected}, but {count} agents have it")
    return problems


def _round_violations(rounds: list[Round], agent_order: list[str], size: int) -> list[str]:
    problems: list[str] = []
    agent_ids = set(agent_order)
    post_ids: set[str] = set()
    for r_index, rnd in enumerate(rounds):
        if rnd.n != r_index + 1:
            problems.append(f"rounds[{r_index}].n is {rnd.n}, expected {r_index + 1}")
        for p_index, post in enumerate(rnd.posts):
            where = f"rounds[{r_index}].posts[{p_index}]"
            if post.agent_id not in agent_ids:
                problems.append(f"{where}.agentId {post.agent_id!r} is not in crowd.agents")
            if post.reply_to is not None and post.reply_to not in post_ids:
                problems.append(f"{where}.replyTo {post.reply_to!r} does not point to an earlier post")
            if post.id in post_ids:
                problems.append(f"{where}.id {post.id!r} is duplicated")
            post_ids.add(post.id)
        acted: set[str] = set()
        for a_index, action in enumerate(rnd.actions):
            where = f"rounds[{r_index}].actions[{a_index}]"
            if action.agent_id not in agent_ids:
                problems.append(f"{where}.agentId {action.agent_id!r} is not in crowd.agents")
            if action.agent_id in acted:
                problems.append(f"{where}: agent {action.agent_id!r} already acted in round {rnd.n}")
            acted.add(action.agent_id)
        missing = [agent_id for agent_id in agent_order if agent_id not in acted]
        if missing:
            problems.append(f"rounds[{r_index}].actions has no action for {', '.join(missing)}")
        if rnd.market.holders > size:
            problems.append(f"rounds[{r_index}].market.holders exceeds crowd.size ({size})")
    return problems
