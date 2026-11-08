from __future__ import annotations

import json
import shutil

import pytest

from hyvo.config import REPO_ROOT
from hyvo.world.artifacts import (
    ARTIFACTS_ENV,
    DEFAULT_ARTIFACTS_DIR,
    ArtifactError,
    artifacts_dir,
    load_artifact,
)

NAMES = ("TestToken", "TestWETH", "HyvoV2Pair", "HyvoV2Router")


@pytest.mark.parametrize("name", NAMES)
def test_loads_every_exported_artifact(name, monkeypatch):
    monkeypatch.delenv(ARTIFACTS_ENV, raising=False)
    artifact = load_artifact(name)
    assert artifact.name == name
    assert artifact.bytecode.startswith("0x") and len(artifact.bytecode) > 1000
    assert any(item.get("type") == "function" for item in artifact.abi)


def test_pair_and_router_expose_the_functions_the_market_uses(monkeypatch):
    monkeypatch.delenv(ARTIFACTS_ENV, raising=False)
    pair = {item.get("name") for item in load_artifact("HyvoV2Pair").abi}
    router = {item.get("name") for item in load_artifact("HyvoV2Router").abi}
    assert {"getReserves", "token0", "token1", "feeBps", "Swap"} <= pair
    assert {
        "swapExactETHForTokens",
        "swapExactTokensForETH",
        "addLiquidityETH",
        "quoteBuy",
    } <= router


def test_directory_comes_from_the_environment(tmp_path, monkeypatch):
    monkeypatch.delenv(ARTIFACTS_ENV, raising=False)
    assert artifacts_dir() == DEFAULT_ARTIFACTS_DIR
    shutil.copy(DEFAULT_ARTIFACTS_DIR / "TestWETH.json", tmp_path / "TestWETH.json")
    monkeypatch.setenv(ARTIFACTS_ENV, str(tmp_path))
    assert artifacts_dir() == tmp_path
    assert load_artifact("TestWETH").name == "TestWETH"
    with pytest.raises(ArtifactError, match="export-artifacts"):
        load_artifact("TestToken")  # not copied
    monkeypatch.setenv(ARTIFACTS_ENV, "chain/artifacts")  # relative to the repo root
    assert artifacts_dir() == REPO_ROOT / "chain" / "artifacts"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda data: data.update(extra=1),
        lambda data: data.update(contractName="Other"),
        lambda data: data.update(bytecode="0x123"),
        lambda data: data.update(bytecode="6080"),
        lambda data: data.update(abi={}),
    ],
)
def test_rejects_malformed_artifacts(tmp_path, mutate):
    data = json.loads((DEFAULT_ARTIFACTS_DIR / "TestWETH.json").read_text(encoding="utf-8"))
    mutate(data)
    (tmp_path / "TestWETH.json").write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ArtifactError):
        load_artifact("TestWETH", tmp_path)


def test_rejects_names_that_are_not_contract_names(tmp_path):
    (tmp_path / "bad.json").write_text("not json", encoding="utf-8")
    with pytest.raises(ArtifactError):
        load_artifact("bad", tmp_path)
    for name in ("../TestWETH", "Test WETH", ""):
        with pytest.raises(ValueError):
            load_artifact(name, tmp_path)
