"""Fixtures for the world tests: one anvil per test module, a fresh market per test.

Tests that use them are marked ``anvil``, so they are skipped where Foundry is not installed.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from hyvo.world.anvil import AnvilInstance
from hyvo.world.market import Market


@pytest.fixture(scope="module")
def anvil() -> Iterator[AnvilInstance]:
    with AnvilInstance() as node:
        yield node


@pytest.fixture
def market(anvil: AnvilInstance) -> Market:
    return Market.deploy(anvil)
