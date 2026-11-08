"""The action space from an ABI (SPEC §11.1): what users can call, what they can read, and what is kept for the owner.

Admin functions stay out of what the crowd plays. They are found by name, the only thing an ABI says about them, and a
function that is not really admin-only is caught later: the adversarial tester probes each one, and a call that goes through from a
stranger's wallet is a finding.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from eth_utils import is_address, to_checksum_address

from .spec import DryRunError

MAX_ARRAY_ITEMS = 16
_ADMIN = re.compile(
    r"^(?:set[A-Z_].*|transferOwnership|renounceOwnership|acceptOwnership|pause|unpause|upgrade.*|initialize|init|"
    r"grantRole|revokeRole|renounceRole|rescue.*|sweep.*|recover.*|emergency.*|withdrawFees?|claimFees?|collectFees?|"
    r"(?:admin|owner|governance|gov)[A-Z_].*|only[A-Z].*|kill|destroy|shutdown)$"
)
_INT = re.compile(r"^(u?)int([0-9]*)$")
_BYTES_N = re.compile(r"^bytes([0-9]+)$")
_ARRAY = re.compile(r"^(.*)\[([0-9]*)\]$")


@dataclass(frozen=True)
class Function:
    name: str
    signature: str
    fragment: Mapping[str, Any]
    payable: bool

    @property
    def inputs(self) -> Sequence[Mapping[str, Any]]:
        return self.fragment.get("inputs") or []

    def card(self) -> dict[str, Any]:
        """As the agents read it."""
        return {
            "function": self.signature,
            "payable": self.payable,
            "inputs": [{"name": item.get("name") or f"arg{i}", "type": item.get("type")} for i, item in enumerate(self.inputs)],
        }


@dataclass(frozen=True)
class ActionSpace:
    actions: tuple[Function, ...]  # what the crowd plays
    admin: tuple[Function, ...]  # kept out, and probed at the end
    reads: tuple[Function, ...]  # views without arguments: the state the crowd can see
    events: Mapping[str, str]  # topic0 is computed by the caller; name -> signature
    errors: tuple[Mapping[str, Any], ...]

    def find(self, signature_or_name: str) -> Function | None:
        for function in self.actions:
            if signature_or_name in (function.signature, function.name):
                return function
        return None


def signature_of(fragment: Mapping[str, Any]) -> str:
    return f"{fragment.get('name', '')}({','.join(_canonical_type(item) for item in fragment.get('inputs') or [])})"


def _canonical_type(item: Mapping[str, Any]) -> str:
    kind = str(item.get("type", ""))
    if kind.startswith("tuple"):
        inner = ",".join(_canonical_type(component) for component in item.get("components") or [])
        return f"({inner}){kind[len('tuple'):]}"
    return kind


def is_admin_name(name: str) -> bool:
    return bool(_ADMIN.match(name))


def action_space(abi: Sequence[Mapping[str, Any]]) -> ActionSpace:
    actions: list[Function] = []
    admin: list[Function] = []
    reads: list[Function] = []
    events: dict[str, str] = {}
    errors: list[Mapping[str, Any]] = []
    for fragment in abi:
        kind = fragment.get("type")
        if kind == "event":
            events[str(fragment.get("name"))] = signature_of(fragment)
        elif kind == "error":
            errors.append(fragment)
        elif kind == "function":
            mutability = fragment.get("stateMutability", "nonpayable")
            function = Function(str(fragment.get("name")), signature_of(fragment), fragment, mutability == "payable")
            if mutability in ("view", "pure"):
                if not function.inputs:
                    reads.append(function)
            elif is_admin_name(function.name):
                admin.append(function)
            else:
                actions.append(function)
    if not actions:
        raise DryRunError("the ABI has no function a user could call")
    return ActionSpace(tuple(actions), tuple(admin), tuple(reads), events, tuple(errors))


def coerce_args(function: Function, args: Any) -> list[Any]:
    """JSON from an agent as the values the ABI wants; raises ``DryRunError`` saying what is wrong."""
    inputs = function.inputs
    given = [] if args is None else args
    if not isinstance(given, list):
        raise DryRunError("args must be a list")
    if len(given) != len(inputs):
        raise DryRunError(f"{function.signature} takes {len(inputs)} arguments, got {len(given)}")
    return [_coerce(item.get("type", ""), value, item) for item, value in zip(inputs, given, strict=True)]


def _coerce(kind: str, value: Any, item: Mapping[str, Any]) -> Any:
    array = _ARRAY.match(kind)
    if array:
        if not isinstance(value, list):
            raise DryRunError(f"{kind} must be a list")
        if array.group(2) and len(value) != int(array.group(2)):
            raise DryRunError(f"{kind} must have {array.group(2)} items")
        if len(value) > MAX_ARRAY_ITEMS:
            raise DryRunError(f"at most {MAX_ARRAY_ITEMS} items in a list")
        return [_coerce(array.group(1), entry, item) for entry in value]
    if kind == "tuple":
        components = item.get("components") or []
        if isinstance(value, Mapping):
            value = [value.get(component.get("name")) for component in components]
        if not isinstance(value, list) or len(value) != len(components):
            raise DryRunError(f"a tuple of {len(components)} values is needed")
        return tuple(_coerce(component.get("type", ""), entry, component) for component, entry in zip(components, value, strict=True))
    integer = _INT.match(kind)
    if integer:
        return _coerce_int(value, kind, integer)
    if kind == "address":
        if not isinstance(value, str) or not is_address(value):
            raise DryRunError(f"{value!r} is not an address")
        return to_checksum_address(value)
    if kind == "bool":
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.lower() in ("true", "false"):
            return value.lower() == "true"
        raise DryRunError(f"{value!r} is not true or false")
    if kind == "string":
        if not isinstance(value, str):
            raise DryRunError("a string is needed")
        return value
    if kind == "bytes" or _BYTES_N.match(kind):
        return _coerce_bytes(value, kind)
    raise DryRunError(f"this Dry Run cannot call a function with a {kind} argument")


def _coerce_int(value: Any, kind: str, integer: re.Match[str]) -> int:
    if isinstance(value, bool):
        raise DryRunError(f"{kind} must be a number")
    try:
        number = int(str(value), 0) if isinstance(value, str) else int(value)
    except (TypeError, ValueError):
        raise DryRunError(f"{value!r} is not a whole number") from None
    if isinstance(value, float) and value != number:
        raise DryRunError(f"{value!r} is not a whole number")
    bits = int(integer.group(2) or 256)
    low, high = (0, 2**bits - 1) if integer.group(1) else (-(2 ** (bits - 1)), 2 ** (bits - 1) - 1)
    if not low <= number <= high:
        raise DryRunError(f"{number} does not fit in {kind}")
    return number


def _coerce_bytes(value: Any, kind: str) -> bytes:
    if not isinstance(value, str) or not re.fullmatch(r"0x(?:[0-9a-fA-F]{2})*", value):
        raise DryRunError(f"{kind} must be 0x and hex digits")
    data = bytes.fromhex(value[2:])
    fixed = _BYTES_N.match(kind)
    if fixed and len(data) != int(fixed.group(1)):
        raise DryRunError(f"{kind} must be {fixed.group(1)} bytes")
    return data


def wire(value: Any) -> Any:
    """A coerced value as JSON, for the record."""
    if isinstance(value, bytes):
        return "0x" + value.hex()
    if isinstance(value, (list, tuple)):
        return [wire(item) for item in value]
    if isinstance(value, bool) or isinstance(value, str):
        return value
    if isinstance(value, int):
        return str(value)
    return str(value)
