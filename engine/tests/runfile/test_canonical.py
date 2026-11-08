"""RFC 8785 canonical JSON, keccak256, run hash and run id encoding."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import pytest

from hyvo.runfile import (
    CanonicalizationError,
    bytes32_to_run_id,
    canonical_json,
    hash_run,
    keccak256_hex,
    new_run_id,
    run_id_to_bytes32,
    scenario_hash,
    utc_timestamp,
)

from .samples import VECTORS_DIR, load_vector

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _vector_cases() -> list[dict[str, Any]]:
    if not (VECTORS_DIR / "canonical.json").is_file():
        return []
    data = load_vector("canonical.json")
    cases = data if isinstance(data, list) else data.get("cases") or data.get("vectors") or []
    return list(cases)


def _case_id(case: dict[str, Any] | None) -> str | None:
    return "absent" if case is None else case.get("name") or case.get("description")


@pytest.mark.parametrize("case", _vector_cases() or [None], ids=_case_id)
def test_shared_canonical_vectors(case: dict[str, Any] | None) -> None:
    if case is None:
        load_vector("canonical.json")  # skips with the reason when the file is absent
        pytest.fail("packages/schema/test-vectors/canonical.json contains no cases")
    canonical = canonical_json(json.loads(case["inputJson"]))
    assert canonical == case["canonical"]
    assert keccak256_hex(canonical.encode("utf-8")) == case["keccak256"]


def test_rfc8785_section_3_2_2_example() -> None:
    # "%" stands for a backslash, so the RFC text stays readable without escape soup.
    source = (
        '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],'
        + '"string":"%u20ac$%u000F%u000aA' + "'" + '%u0042%u0022%u005c%%%"%/",'
        + '"literals":[null,true,false]}'
    ).replace("%", chr(92))
    expected = (
        '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],'
        + '"string":"' + chr(0x20AC) + '$%u000f%nA' + "'" + 'B%"%%%%%"/"}'
    ).replace("%", chr(92))
    assert canonical_json(json.loads(source)) == expected


def test_members_sort_by_utf16_code_units() -> None:
    # RFC 8785 3.2.3: U+1F600 (surrogates D83D DE00) sorts before U+FB33 despite its code point.
    keys = ["€", "\r", "דּ", "1", "\U0001f600", "\u0080", "ö"]
    canonical = canonical_json({key: 0 for key in keys})
    assert list(json.loads(canonical)) == ["\r", "1", "\u0080", "ö", "€", "\U0001f600", "דּ"]


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (1.0, "1"),
        (0.1, "0.1"),
        (-0.0, "0"),
        (4.5, "4.5"),
        (1e20, "100000000000000000000"),
        (1e21, "1e+21"),
        (2.0**68, "295147905179352830000"),
        (9.999999999999997e22, "9.999999999999997e+22"),
        (1e23, "1e+23"),
        (1e-6, "0.000001"),
        (1e-7, "1e-7"),
        (5e-324, "5e-324"),
        (1.7976931348623157e308, "1.7976931348623157e+308"),
        (2**53 - 1, "9007199254740991"),
    ],
)
def test_numbers_serialize_like_ecmascript(value: float, expected: str) -> None:
    assert canonical_json(value) == expected


def test_strings_stay_utf8_and_escape_controls() -> None:
    assert canonical_json({"t": "café 🚀\n\t\u0001\u007f"}) == '{"t":"café 🚀\\n\\t\\u0001\u007f"}'


@pytest.mark.parametrize("value", [float("nan"), float("inf"), 2**53, {1: "a"}, "\ud800", {1, 2}])
def test_values_outside_jcs_are_rejected(value: Any) -> None:
    with pytest.raises(CanonicalizationError):
        canonical_json(value)


def test_keccak256_is_ethereum_keccak_not_sha3() -> None:
    assert keccak256_hex(b"") == "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert keccak256_hex(b"abc") == "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"


def test_hash_run_drops_only_the_top_level_hash(run_doc: dict[str, Any]) -> None:
    baseline = hash_run(run_doc)
    assert run_doc["hash"] == baseline
    assert hash_run(run_doc | {"hash": "0x" + "0" * 64}) == baseline
    assert hash_run({k: v for k, v in run_doc.items() if k != "hash"}) == baseline
    expected = keccak256_hex(canonical_json({k: v for k, v in run_doc.items() if k != "hash"}).encode())
    assert baseline == expected
    nested = json.loads(json.dumps(run_doc))
    nested["scenario"]["seedSources"][0]["ref"] = "changed"
    assert hash_run(nested) != baseline


def test_hash_is_independent_of_member_order(run_doc: dict[str, Any]) -> None:
    reordered = dict(reversed(list(run_doc.items())))
    reordered["world"] = dict(reversed(list(run_doc["world"].items())))
    assert hash_run(reordered) == hash_run(run_doc)


def test_scenario_hash(run_doc: dict[str, Any]) -> None:
    scenario = run_doc["scenario"]
    assert scenario_hash(scenario) == keccak256_hex(canonical_json(scenario).encode("utf-8"))
    assert re.fullmatch(r"0x[0-9a-f]{64}", scenario_hash(scenario))


def _independent_bytes32(run_id: str) -> str:
    value = 0
    for char in run_id.removeprefix("run_"):
        value = value * 32 + CROCKFORD.index(char)
    return "0x" + value.to_bytes(32, "big").hex()


@pytest.mark.parametrize(
    "run_id",
    ["run_00000000000000000000000000", "run_7ZZZZZZZZZZZZZZZZZZZZZZZZZ", "run_01JC8Z6Q3W1Y2V9K7T5R4N3M2P"],
)
def test_run_id_to_bytes32_matches_crockford_decoding(run_id: str) -> None:
    encoded = run_id_to_bytes32(run_id)
    assert encoded == _independent_bytes32(run_id)
    assert encoded.startswith("0x" + "0" * 32)
    assert bytes32_to_run_id(encoded) == run_id
    assert bytes32_to_run_id(bytes.fromhex(encoded[2:])) == run_id


def test_run_id_extremes() -> None:
    assert run_id_to_bytes32("run_00000000000000000000000000") == "0x" + "0" * 64
    assert run_id_to_bytes32("run_7ZZZZZZZZZZZZZZZZZZZZZZZZZ") == "0x" + "0" * 32 + "f" * 32


def test_new_run_id_round_trips() -> None:
    run_id = new_run_id()
    assert re.fullmatch(r"run_[0-9A-HJKMNP-TV-Z]{26}", run_id)
    assert bytes32_to_run_id(run_id_to_bytes32(run_id)) == run_id
    assert new_run_id() != run_id


@pytest.mark.parametrize(
    "run_id",
    [
        "run_80000000000000000000000000",  # exceeds 128 bits
        "run_01jc8z6q3w1y2v9k7t5r4n3m2p",  # lowercase
        "run_01JC8Z6Q3W1Y2V9K7T5R4N3M2",  # 25 characters
        "RUN_01JC8Z6Q3W1Y2V9K7T5R4N3M2P",
        "run_01JC8Z6Q3W1Y2V9K7T5R4N3M2U",  # U is not Crockford base32
        "01JC8Z6Q3W1Y2V9K7T5R4N3M2P",
    ],
)
def test_invalid_run_ids_are_rejected(run_id: str) -> None:
    with pytest.raises(ValueError):
        run_id_to_bytes32(run_id)


@pytest.mark.parametrize(
    "value",
    ["0x" + "0" * 31 + "1" + "0" * 32, "0x" + "0" * 63, "0" * 64, b"\x00" * 31, "0x" + "g" * 64],
)
def test_invalid_bytes32_values_are_rejected(value: str | bytes) -> None:
    with pytest.raises(ValueError):
        bytes32_to_run_id(value)


def test_utc_timestamp() -> None:
    moment = datetime(2026, 11, 3, 17, 0, 5, 999_000, tzinfo=timezone(timedelta(hours=7)))
    assert utc_timestamp(moment) == "2026-11-03T10:00:05Z"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", utc_timestamp())
    assert utc_timestamp(datetime(2026, 1, 2, tzinfo=UTC)) == "2026-01-02T00:00:00Z"
    with pytest.raises(ValueError):
        utc_timestamp(datetime(2026, 11, 3))
