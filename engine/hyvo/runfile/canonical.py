"""Canonical JSON, keccak256 and run identifiers (docs/RUN_FORMAT.md, "Hashing").

``hash = "0x" + hex(keccak256(utf8(JCS(run without its top-level "hash"))))``, where JCS is the
JSON Canonicalization Scheme of RFC 8785 and keccak256 is Ethereum's original Keccak-256.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import rfc8785
from eth_hash.auto import keccak
from ulid import ULID

RUN_ID_PREFIX = "run_"
_RUN_ID = re.compile(r"run_[0-7][0-9A-HJKMNP-TV-Z]{25}")
_BYTES32_HEX = re.compile(r"0x[0-9a-fA-F]{64}")

CanonicalizationError = rfc8785.CanonicalizationError


def canonical_json(obj: Any) -> str:
    """Serialize a JSON-compatible value with RFC 8785 (sorted members, no whitespace).

    Raises ``CanonicalizationError`` for values JCS cannot represent: NaN or infinite floats,
    integers outside +-(2**53 - 1), non-string object keys, lone surrogates, non-JSON types.
    """
    return rfc8785.dumps(obj).decode("utf-8")


def keccak256_hex(data: bytes) -> str:
    """Keccak-256 (Ethereum, not NIST SHA3-256) as ``0x`` + 64 lowercase hex digits."""
    return "0x" + keccak(data).hex()


def hash_run(run: Mapping[str, Any]) -> str:
    """The run hash: keccak256 of the canonical JSON of ``run`` without its top-level ``hash``.

    Only the top-level member is dropped; a nested ``hash`` key is hashed like any other member.
    """
    body = {key: value for key, value in run.items() if key != "hash"}
    return keccak256_hex(rfc8785.dumps(body))


def scenario_hash(scenario: Mapping[str, Any]) -> str:
    """``scenarioHash`` for the oracle: keccak256 of the canonical JSON of ``run.scenario``."""
    return keccak256_hex(rfc8785.dumps(dict(scenario)))


def new_run_id() -> str:
    """A fresh run id: ``run_`` + a ULID (uppercase Crockford base32, 26 characters)."""
    return RUN_ID_PREFIX + str(ULID())


def run_id_to_bytes32(run_id: str) -> str:
    """Encode a run id as the oracle's ``bytes32``, returned as ``0x`` + 64 lowercase hex digits.

    The ULID's 128-bit value is written big-endian into the low 16 bytes; the high 16 bytes are 0.
    """
    if not isinstance(run_id, str) or not _RUN_ID.fullmatch(run_id):
        raise ValueError(f"not a run id: {run_id!r}")
    ulid = ULID.from_str(run_id[len(RUN_ID_PREFIX) :])  # raises when the value exceeds 128 bits
    return "0x" + (bytes(16) + ulid.bytes).hex()


def bytes32_to_run_id(value: str | bytes) -> str:
    """Invert ``run_id_to_bytes32``; accepts ``0x``-prefixed hex or 32 raw bytes."""
    if isinstance(value, (bytes, bytearray)):
        raw = bytes(value)
        if len(raw) != 32:
            raise ValueError(f"bytes32 must be 32 bytes, got {len(raw)}")
    elif isinstance(value, str) and _BYTES32_HEX.fullmatch(value):
        raw = bytes.fromhex(value[2:])
    else:
        raise ValueError(f"not a bytes32 value: {value!r}")
    if any(raw[:16]):
        raise ValueError("a run id bytes32 must have its high 16 bytes set to zero")
    return RUN_ID_PREFIX + str(ULID.from_bytes(raw[16:]))


def utc_timestamp(moment: datetime | None = None) -> str:
    """Format a moment (default: now) as a run ``Timestamp``: UTC, seconds precision, ``Z``."""
    moment = datetime.now(UTC) if moment is None else moment
    if moment.tzinfo is None:
        raise ValueError("timestamp needs a timezone-aware datetime")
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
