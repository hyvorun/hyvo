"""Fixtures for the action tests: one anvil per test module, a fresh market and wallets per test.

Tests that use them are marked ``anvil``, so they are skipped where Foundry is not installed.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from hyvo.world.anvil import AnvilInstance
from hyvo.world.market import Market
from hyvo.world.wallets import Wallets


@pytest.fixture(scope="module")
def anvil() -> Iterator[AnvilInstance]:
    with AnvilInstance() as node:
        yield node


@pytest.fixture
def market(anvil: AnvilInstance) -> Market:
    return Market.deploy(anvil)


@pytest.fixture
def wallets(market: Market) -> Wallets:
    return Wallets(market, run_seed="actions")
