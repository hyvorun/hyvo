"""What a developer submits: a contract, by address or as bytecode with its ABI, and what it is for."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from hyvo.scenarios.sanitize import sanitize_text

MAX_INITCODE_HEX_CHARS = 2 + 2 * 49_152  # EIP-3860's limit on creation code
MAX_ABI_ENTRIES = 300
MAX_DESCRIPTION_CHARS = 2000
MAX_INVARIANTS = 10
MAX_CONSTRUCTOR_ARGS = 16
MIN_AGENTS, MAX_AGENTS = 4, 40
MIN_ROUNDS, MAX_ROUNDS = 1, 30
DEFAULT_AGENTS = 12
DEFAULT_ROUNDS = 8

_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
_BYTECODE = re.compile(r"^0x(?:[0-9a-fA-F]{2})+$")
_IDENTIFIER = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")


class DryRunError(ValueError):
    """A submission cannot be played as written. The message says what to change."""


@dataclass(frozen=True)
class DryRunSpec:
    description: str
    abi: tuple[Mapping[str, Any], ...] | None = None
    address: str | None = None
    bytecode: str | None = None
    constructor_args: tuple[Any, ...] = ()
    invariants: tuple[str, ...] = ()
    agents: int = DEFAULT_AGENTS
    rounds: int = DEFAULT_ROUNDS
    seed: int | None = None
    max_cost_usd: float | None = None
    max_llm_calls: int | None = None
    fork_block: int | None = None
    extra: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if (self.address is None) == (self.bytecode is None):
            raise DryRunError("give either a contract address or bytecode with its ABI")
        if self.address is not None and not _ADDRESS.match(self.address):
            raise DryRunError("the address must be 0x and 40 hex digits")
        if self.bytecode is not None:
            if not _BYTECODE.match(self.bytecode):
                raise DryRunError("the bytecode must be 0x and an even number of hex digits")
            if len(self.bytecode) > MAX_INITCODE_HEX_CHARS:
                raise DryRunError("the bytecode is longer than a contract's creation code can be (49,152 bytes)")
            if self.abi is None:
                raise DryRunError("bytecode needs its ABI")
        if self.abi is not None:
            check_abi(self.abi)
        description = sanitize_text(self.description, MAX_DESCRIPTION_CHARS)
        if not description:
            raise DryRunError("describe the dApp in plain language, for the crowd to read")
        object.__setattr__(self, "description", description)
        if len(self.constructor_args) > MAX_CONSTRUCTOR_ARGS:
            raise DryRunError(f"at most {MAX_CONSTRUCTOR_ARGS} constructor arguments")
        if len(self.invariants) > MAX_INVARIANTS:
            raise DryRunError(f"at most {MAX_INVARIANTS} invariants")
        for name in self.invariants:
            if not isinstance(name, str) or not _IDENTIFIER.match(name):
                raise DryRunError(f"an invariant is the name of a view function, not {name!r}")
        if not MIN_AGENTS <= self.agents <= MAX_AGENTS:
            raise DryRunError(f"the crowd must be from {MIN_AGENTS} to {MAX_AGENTS} agents")
        if not MIN_ROUNDS <= self.rounds <= MAX_ROUNDS:
            raise DryRunError(f"a Dry Run has {MIN_ROUNDS} to {MAX_ROUNDS} rounds")


def check_abi(abi: Sequence[Mapping[str, Any]]) -> None:
    if not isinstance(abi, Sequence) or isinstance(abi, (str, bytes)):
        raise DryRunError("the ABI must be a JSON list")
    if len(abi) > MAX_ABI_ENTRIES:
        raise DryRunError(f"the ABI has more than {MAX_ABI_ENTRIES} entries")
    for entry in abi:
        if not isinstance(entry, Mapping) or not isinstance(entry.get("type"), str):
            raise DryRunError("every ABI entry must be an object with a type")


def from_mapping(data: Mapping[str, Any]) -> DryRunSpec:
    """A submission as JSON, the same shape from a file and from the API."""
    known = {"description", "abi", "address", "bytecode", "constructorArgs", "invariants", "agents", "rounds", "seed", "maxCostUsd", "maxLlmCalls", "forkBlock"}
    unknown = set(data) - known
    if unknown:
        raise DryRunError(f"unknown field: {sorted(unknown)[0]}")
    if not isinstance(data.get("description"), str):
        raise DryRunError("describe the dApp in plain language, for the crowd to read")
    abi = data.get("abi")
    return DryRunSpec(
        description=data["description"],
        abi=tuple(abi) if isinstance(abi, list) else (abi if abi is None else _not_a_list()),
        address=data.get("address"),
        bytecode=data.get("bytecode"),
        constructor_args=tuple(data.get("constructorArgs") or ()),
        invariants=tuple(data.get("invariants") or ()),
        agents=_whole(data.get("agents", DEFAULT_AGENTS), "agents"),
        rounds=_whole(data.get("rounds", DEFAULT_ROUNDS), "rounds"),
        seed=data.get("seed"),
        max_cost_usd=data.get("maxCostUsd"),
        max_llm_calls=data.get("maxLlmCalls"),
        fork_block=data.get("forkBlock"),
    )


def load_spec_file(path: Path) -> DryRunSpec:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        raise DryRunError(f"cannot read {path.name}: {error}") from None
    if not isinstance(data, Mapping):
        raise DryRunError(f"{path.name} must hold a JSON object")
    return from_mapping(data)


def _whole(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise DryRunError(f"{name} must be a whole number")
    return value


def _not_a_list() -> tuple[Mapping[str, Any], ...]:
    raise DryRunError("the ABI must be a JSON list")
