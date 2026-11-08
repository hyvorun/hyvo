"""The shared packages/schema vectors: the sample run must validate and hash identically here."""

from __future__ import annotations

from typing import Any

import pytest

from hyvo.runfile import (
    bytes32_to_run_id,
    hash_run,
    load_run,
    model_errors,
    run_id_to_bytes32,
    scenario_hash,
    validate_json_schema,
    verify_run,
)

from .samples import SCHEMA_FILE, VECTORS_DIR, build_run, load_vector, require_file


@pytest.fixture
def sample_run() -> dict[str, Any]:
    return load_run(require_file(VECTORS_DIR / "sample-run.json"))


@pytest.fixture
def real_schema(monkeypatch: pytest.MonkeyPatch) -> None:
    require_file(SCHEMA_FILE)
    monkeypatch.delenv("HYVO_RUN_SCHEMA", raising=False)


def test_sample_run_passes_the_pydantic_models(sample_run: dict[str, Any]) -> None:
    assert model_errors(sample_run) == []


def test_sample_run_passes_the_json_schema(sample_run: dict[str, Any], real_schema: None) -> None:
    assert validate_json_schema(sample_run) == []


def test_sample_run_hash_matches(sample_run: dict[str, Any], real_schema: None) -> None:
    assert hash_run(sample_run) == sample_run["hash"]
    assert verify_run(VECTORS_DIR / "sample-run.json").ok


def test_sample_run_meta(sample_run: dict[str, Any]) -> None:
    meta = load_vector("sample-run.meta.json")
    assert scenario_hash(sample_run["scenario"]) == meta["scenarioHash"]
    assert run_id_to_bytes32(sample_run["runId"]) == meta["runIdBytes32"].lower()
    assert bytes32_to_run_id(meta["runIdBytes32"]) == sample_run["runId"]
    if "hash" in meta:
        assert meta["hash"] == sample_run["hash"]


def test_engine_fixture_passes_the_json_schema(real_schema: None) -> None:
    """A run the Python models accept must also pass the exported JSON Schema."""
    assert validate_json_schema(build_run()) == []
