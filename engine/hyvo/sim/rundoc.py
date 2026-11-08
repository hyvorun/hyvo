"""Assemble ``run.json`` (docs/RUN_FORMAT.md) and the report input from a played run.

Rounds are recorded as they are played (:class:`RoundRecord`); posts are read from the social
world only at the end, so every post carries its final like count.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from hyvo.actions.models import ActionRecord
from hyvo.personas import ARCHETYPES, STAGE1, AgentSpec
from hyvo.report.types import ReportInput, RoundTrace
from hyvo.sim.social import SocialPost


@dataclass
class RoundRecord:
    """One played round.

    ``actions`` are in execution order (one per agent); ``swaps`` are the executed swaps in that
    order in the ``RoundTrace`` shape; ``sentiments`` hold reported sentiments only.
    """

    n: int
    actions: list[ActionRecord]
    swaps: list[dict[str, Any]]
    market: dict[str, Any]
    sentiments: dict[str, float]
    injected_events: list[str]
    posts: int = 0
    replies: int = 0
    likes: int = 0
    rejections: int = 0
    notes: list[str] = field(default_factory=list)

    @property
    def invalid_count(self) -> int:
        return sum(1 for record in self.actions if record.status == "invalid")

    @property
    def reverted_count(self) -> int:
        return sum(1 for record in self.actions if record.status == "reverted")

    def count(self, kind: str, status: str = "ok") -> int:
        return sum(1 for r in self.actions if r.kind == kind and r.status == status)


def persona_mix(crowd: Sequence[AgentSpec]) -> dict[str, int]:
    """run.json ``crowd.personaMix``, in archetype order: every Stage 1 archetype, and a later one only when the crowd has it."""
    counts = Counter(spec.persona.id for spec in crowd)
    return {pid: counts[pid] for pid in (*ARCHETYPES, "clone") if pid in STAGE1 or counts[pid] > 0}


def crowd_dict(
    crowd: Sequence[AgentSpec],
    agents_model: str,
    report_model: str,
    temperature: float,
    *,
    start: Mapping[str, Mapping[str, str]],
) -> dict[str, Any]:
    """run.json ``crowd``; ``start`` maps each agent id to its ``startEth``/``startTokens``."""
    return {
        "size": len(crowd),
        "personaMix": persona_mix(crowd),
        "model": {"agents": agents_model, "report": report_model, "temperature": float(temperature)},
        "agents": [{**spec.to_run_dict(), **start[spec.agent_id]} for spec in crowd],
    }


def post_dict(post: SocialPost, reply_targets: Mapping[str, str] | None = None) -> dict[str, Any]:
    """run.json ``posts[]`` entry. OASIS attaches every reply to its thread's post; when the
    agent answered a reply, ``replyTo`` names that reply (``reply_targets``) instead."""
    entry = post.to_run_dict()
    if reply_targets and post.ref in reply_targets:
        entry["replyTo"] = reply_targets[post.ref]
    return entry


def posts_by_round(content: Sequence[SocialPost]) -> dict[int, list[SocialPost]]:
    """Posts and replies grouped by round, each group in creation order."""
    grouped: dict[int, list[SocialPost]] = {}
    for post in content:
        grouped.setdefault(post.round, []).append(post)
    return grouped


def run_rounds(
    records: Sequence[RoundRecord],
    content: Sequence[SocialPost],
    reply_targets: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    """run.json ``rounds``: posts with final likes, actions in execution order, market after."""
    grouped = posts_by_round(content)
    return [
        {
            "n": record.n,
            "posts": [post_dict(post, reply_targets) for post in grouped.get(record.n, [])],
            "actions": [action.to_dict() for action in record.actions],
            "market": dict(record.market),
        }
        for record in records
    ]


def report_input(
    *,
    scenario: Mapping[str, Any],
    crowd: Mapping[str, Any],
    initial_market: Mapping[str, Any],
    records: Sequence[RoundRecord],
    content: Sequence[SocialPost],
    personas: Mapping[str, str],
    status: str,
    stop_reason: str | None,
    reply_targets: Mapping[str, str] | None = None,
) -> ReportInput:
    grouped = posts_by_round(content)
    traces = [
        RoundTrace(
            n=record.n,
            market_after=dict(record.market),
            swaps=[dict(swap) for swap in record.swaps],
            posts=[
                {**post_dict(post, reply_targets), "persona": personas[post.author_agent_id]}
                for post in grouped.get(record.n, [])
            ],
            sentiments=dict(record.sentiments),
            injected_events=list(record.injected_events),
            invalid_count=record.invalid_count,
            reverted_count=record.reverted_count,
        )
        for record in records
    ]
    return ReportInput(
        scenario=dict(scenario),
        crowd=dict(crowd),
        initial_market=dict(initial_market),
        rounds=traces,
        status=status,
        stop_reason=stop_reason,
    )


def run_document(
    *,
    run_id: str,
    created_at: str,
    status: str,
    stop_reason: str | None,
    scenario: Mapping[str, Any],
    world: Mapping[str, Any],
    crowd: Mapping[str, Any],
    rounds: Sequence[Mapping[str, Any]],
    report: Mapping[str, Any],
    usage: Mapping[str, Any],
    question: Mapping[str, Any] | None = None,
    rewind: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """The run.json document without its ``hash`` (``write_run`` sets it)."""
    return {
        "runId": run_id,
        "version": 1,
        "createdAt": created_at,
        "status": status,
        "stopReason": stop_reason,
        "scenario": dict(scenario),
        "world": dict(world),
        "crowd": dict(crowd),
        "rounds": [dict(rnd) for rnd in rounds],
        "report": dict(report),
        "usage": dict(usage),
        **({"question": dict(question)} if question else {}),
        **({"rewind": dict(rewind)} if rewind else {}),
    }
