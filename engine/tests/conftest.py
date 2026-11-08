"""Shared pytest configuration for the Hyvo engine.

Package-specific fixtures live in the conftest.py of each test subdirectory
(tests/world/, tests/actions/, ...) so parallel work does not collide here.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

# The repo's .env points at production: the API, the runner token and the real LLM. A test that
# reads it can poll the live queue or publish to the live site, so no test may, and neither may any
# process a test starts (they inherit this).
os.environ["HYVO_NO_DOTENV"] = "1"

ENGINE_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = ENGINE_ROOT.parent


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if shutil.which("anvil") is None:
        skip = pytest.mark.skip(reason="anvil not found on PATH")
        for item in items:
            if "anvil" in item.keywords:
                item.add_marker(skip)


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return REPO_ROOT
