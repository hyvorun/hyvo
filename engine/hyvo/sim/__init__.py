"""Hyvo simulation layer.

- ``oasis_boot``: :func:`import_oasis`, the one way Hyvo imports OASIS (light, quiet, outside the
  working directory).
- ``social``: :class:`SocialWorld`, the per-job OASIS social platform that Hyvo drives with
  direct action calls and reads from SQLite.
- ``loop``: :func:`run_simulation`, one whole run (world, rounds, report, run.json), configured
  by ``config.SimConfig`` and returning ``config.RunOutcome``.
- ``views``, ``rundoc``, ``events``: the glue between world, feed and decisions, the run.json
  assembly, and the ``events.jsonl`` writer.

Importing this package does not import OASIS; that happens in :func:`import_oasis`, which
:meth:`SocialWorld.start` and :func:`run_simulation` call. The loop (which imports web3) is loaded
on first use of ``run_simulation``, ``run_simulation_async`` or ``prepare_process``.
"""

from typing import Any

from hyvo.sim.config import RunOutcome, SimConfig, SimConfigError, SimulationError
from hyvo.sim.oasis_boot import import_oasis
from hyvo.sim.social import (
    Rejection,
    SocialActionRejected,
    SocialPost,
    SocialWorld,
    SocialWorldError,
    hot_score,
)

_LOOP_EXPORTS = ("prepare_process", "run_simulation", "run_simulation_async")

__all__ = [
    "Rejection",
    "RunOutcome",
    "SimConfig",
    "SimConfigError",
    "SimulationError",
    "SocialActionRejected",
    "SocialPost",
    "SocialWorld",
    "SocialWorldError",
    "hot_score",
    "import_oasis",
    "prepare_process",
    "run_simulation",
    "run_simulation_async",
]


def __getattr__(name: str) -> Any:
    if name in _LOOP_EXPORTS:
        from hyvo.sim import loop

        return getattr(loop, name)
    raise AttributeError(f"module 'hyvo.sim' has no attribute {name!r}")
