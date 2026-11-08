"""Inputs of the report agent. The simulation layer (``hyvo.sim``) builds these from a run."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class RoundTrace:
    """What happened in one round: run.json shapes plus the facts only the simulation knows.

    Attributes:
        n: round number, 1-based and consecutive.
        market_after: the run.json ``market`` object after the round's actions (``price``,
            ``reserve0``, ``reserve1`` as Decimal strings, ``holders`` as an int).
        swaps: the round's executed swaps (status ``ok``) in execution order, each a dict with
            ``agentId``, ``persona``, ``kind`` (``swap_buy`` | ``swap_sell``), ``amountIn``,
            ``amountOut``, ``priceBefore``, ``priceAfter`` (Decimal strings; ETH per token) and
            ``reason`` (the agent's stated reason, may be empty).
        posts: the round's posts, each a dict with ``id``, ``agentId``, ``persona``, ``text``,
            ``replyTo`` and ``likes`` (the run.json post plus ``persona``).
        sentiments: agentId -> the sentiment in [-1, 1] the agent reported this round.
        injected_events: texts of the scenario events injected at this round.
        invalid_count: actions rejected by validation (recorded as ``hold``/``invalid``).
        reverted_count: swaps that were sent and reverted.
    """

    n: int
    market_after: dict[str, Any]
    swaps: list[dict[str, Any]] = field(default_factory=list)
    posts: list[dict[str, Any]] = field(default_factory=list)
    sentiments: dict[str, float] = field(default_factory=dict)
    injected_events: list[str] = field(default_factory=list)
    invalid_count: int = 0
    reverted_count: int = 0


@dataclass(frozen=True)
class ReportInput:
    """Everything the report agent reads.

    Attributes:
        scenario: the run.json ``scenario`` object.
        crowd: the run.json ``crowd`` object (``size`` and ``personaMix`` are read).
        initial_market: the ``market`` object before round 1 (same shape as ``market_after``).
        rounds: one trace per recorded round, in order.
        status: run.json ``status`` (``complete`` | ``partial``).
        stop_reason: run.json ``stopReason``.
    """

    scenario: dict[str, Any]
    crowd: dict[str, Any]
    initial_market: dict[str, Any]
    rounds: list[RoundTrace]
    status: str = "complete"
    stop_reason: str | None = None
