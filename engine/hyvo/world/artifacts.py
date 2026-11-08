"""Loader for the exported contract artifacts ``chain/artifacts/<Name>.json``.

Each file holds exactly ``{"contractName", "abi", "bytecode"}`` with 0x-prefixed creation code;
the files are written by ``chain/scripts/export-artifacts.mjs``. The directory is
``$HYVO_CHAIN_ARTIFACTS`` when set (a relative path counts from the repo root), else
``<repo>/chain/artifacts``.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from hyvo.config import REPO_ROOT

ARTIFACTS_ENV = "HYVO_CHAIN_ARTIFACTS"
DEFAULT_ARTIFACTS_DIR = REPO_ROOT / "chain" / "artifacts"

_KEYS = {"contractName", "abi", "bytecode"}
_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_BYTECODE = re.compile(r"0x(?:[0-9a-fA-F]{2})+")


class ArtifactError(RuntimeError):
    """An artifact file is missing or malformed."""


@dataclass(frozen=True)
class Artifact:
    name: str
    abi: list[dict[str, Any]]
    bytecode: str  # 0x-prefixed creation code


def artifacts_dir() -> Path:
    """The artifacts directory, read from the environment at call time."""
    raw = os.environ.get(ARTIFACTS_ENV, "").strip()
    if not raw:
        return DEFAULT_ARTIFACTS_DIR
    path = Path(raw).expanduser()
    return path if path.is_absolute() else REPO_ROOT / path


def load_artifact(name: str, directory: Path | None = None) -> Artifact:
    """Read and check ``<directory>/<name>.json`` (default directory: :func:`artifacts_dir`)."""
    if not _NAME.fullmatch(name):
        raise ValueError(f"not a contract name: {name!r}")
    path = (artifacts_dir() if directory is None else Path(directory)) / f"{name}.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ArtifactError(
            f"{path} not found; build it with `node scripts/export-artifacts.mjs` in chain/"
        ) from None
    except (OSError, ValueError) as error:
        raise ArtifactError(f"cannot read {path}: {error}") from error

    if not isinstance(data, dict) or set(data) != _KEYS:
        raise ArtifactError(f"{path} must hold exactly the keys {sorted(_KEYS)}")
    if data["contractName"] != name:
        raise ArtifactError(f"{path} holds {data['contractName']!r}, expected {name!r}")
    if not isinstance(data["abi"], list) or not all(isinstance(item, dict) for item in data["abi"]):
        raise ArtifactError(f"{path}: abi must be a list of objects")
    if not isinstance(data["bytecode"], str) or not _BYTECODE.fullmatch(data["bytecode"]):
        raise ArtifactError(f"{path}: bytecode must be 0x-prefixed hex creation code")
    return Artifact(name=name, abi=data["abi"], bytecode=data["bytecode"])
