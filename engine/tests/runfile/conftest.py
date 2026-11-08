"""Fixtures for the run.json tests."""

from __future__ import annotations

from typing import Any

import pytest

from .samples import build_run


@pytest.fixture
def run_doc() -> dict[str, Any]:
    """A fresh, valid run document (with its hash) that a test may mutate."""
    return build_run()
