"""Fixtures for the hyvo.sim tests: one light OASIS import per session, one world per test."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from types import ModuleType

import pytest

from hyvo.personas import AgentSpec, generate_crowd
from hyvo.sim.oasis_boot import import_oasis
from hyvo.sim.social import SocialWorld


@pytest.fixture(scope="session")
def oasis_module(tmp_path_factory: pytest.TempPathFactory) -> ModuleType:
    """OASIS, imported once for the whole session (light mode, logs in a temp dir)."""
    return import_oasis(log_dir=tmp_path_factory.mktemp("oasis-logs"))


@pytest.fixture
def crowd() -> list[AgentSpec]:
    """Five agents, ``a01``..``a05``."""
    return generate_crowd(5, seed=7)


@pytest.fixture
async def world(
    oasis_module: ModuleType, crowd: list[AgentSpec], tmp_path: Path
) -> AsyncIterator[SocialWorld]:
    """A started five-agent reddit world, already in round 1."""
    async with SocialWorld(tmp_path / "job", crowd) as social:
        social.set_round(1)
        yield social
