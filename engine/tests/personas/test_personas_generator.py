from __future__ import annotations

import json
import re
from decimal import Decimal
from pathlib import Path

import jsonschema
import pytest

from hyvo.personas.archetypes import STAGE1
from hyvo.personas import (
    ARCHETYPES,
    DEFAULT_WEIGHTS,
    PersonaMixError,
    default_mix,
    generate_crowd,
    generator,
    parse_mix,
)

SCHEMA_FILE = Path(__file__).resolve().parents[3] / "packages" / "schema" / "run.schema.json"
HANDLE_RE = re.compile(r"^@[a-z0-9_]{3,30}$")
AGENT_ID_RE = re.compile(r"^a[0-9]{2,4}$")
# Common given names and nicknames that word lists must avoid (handles are never real names).
GIVEN_NAMES = {
    "amber", "ruby", "jade", "rose", "grace", "frank", "sandy", "rusty", "robin", "jay",
    "martin", "drake", "wren", "raven", "finch", "swift", "hazel", "ivy", "olive", "violet",
    "sunny", "stormy", "misty", "rocky", "lucky", "scarlet", "dawn", "summer", "autumn",
    "sky", "river", "faith", "hope", "joy", "dusty", "sly", "ginger", "honey", "earnest",
    "newt", "dizzy", "buck", "colt", "fawn", "bunny", "kitty", "goose", "bear", "fox",
}  # fmt: skip


def mix(sniper=0, holder=0, panic_seller=0, skeptic=0) -> dict[str, int]:
    return {"sniper": sniper, "holder": holder, "panic_seller": panic_seller, "skeptic": skeptic}


def test_default_mix_for_fifty_matches_the_spec():
    assert default_mix(50) == mix(10, 15, 10, 15)
    assert default_mix(100) == mix(20, 30, 20, 30)


@pytest.mark.parametrize(
    ("size", "expected"),
    [(1, mix(holder=1)), (2, mix(holder=1, skeptic=1)), (3, mix(1, 1, 0, 1)), (7, mix(2, 2, 1, 2))],
)
def test_largest_remainder_with_ties_to_the_first_listed(size, expected):
    assert default_mix(size) == expected


@pytest.mark.parametrize("size", range(1, 301))
def test_default_mix_sums_to_size_and_stays_proportional(size):
    result = default_mix(size)
    assert list(result) == list(STAGE1)  # every Stage 1 archetype, zeros included, in order
    assert sum(result.values()) == size
    total = sum(DEFAULT_WEIGHTS.values())
    for pid, weight in DEFAULT_WEIGHTS.items():
        assert abs(result[pid] - size * weight / total) < 1


def test_parse_mix_accepts_spacing_and_returns_the_full_mix_in_order():
    parsed = parse_mix(" skeptic = 15 , sniper=10,holder=15, panic_seller=10 ", size=50)
    assert parsed == mix(10, 15, 10, 15) and list(parsed) == list(STAGE1)
    assert parse_mix("holder=3,sniper=0") == mix(holder=3)


def test_a_later_archetype_is_in_the_mix_only_when_the_crowd_has_it():
    parsed = parse_mix("newcomer=2,whale=1,holder=3")
    assert parsed == {"sniper": 0, "holder": 3, "panic_seller": 0, "skeptic": 0, "whale": 1, "newcomer": 2}
    assert list(parsed) == [*STAGE1, "whale", "newcomer"]
    assert "whale" not in parse_mix("whale=0,holder=3")
    assert [spec.persona.id for spec in generate_crowd(1, {"whale": 1})] == ["whale"]


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("", "empty"),
        ("sniper", "must look like"),
        ("=4", "must look like"),
        ("sniper=10,,holder=2", "must look like"),
        ("wizard=3", "unknown persona"),
        ("sniper=2,sniper=3", "more than once"),
        ("sniper=-1", "whole number"),
        ("sniper=1.5", "whole number"),
        ("sniper=²", "whole number"),
        ("sniper=0", "at least one agent"),
        ("sniper=10,holder=15", "sums to 25, but the crowd size is 50"),
    ],
)
def test_parse_mix_rejects_bad_input(text, message):
    with pytest.raises(PersonaMixError, match=message):
        parse_mix(text, size=50)


@pytest.mark.parametrize(
    ("size", "first", "last"),
    [(1, "a01", "a01"), (9, "a01", "a09"), (50, "a01", "a50"), (100, "a001", "a100"),
     (1000, "a0001", "a1000")],
)  # fmt: skip
def test_agent_ids_are_zero_padded(size, first, last):
    crowd = generate_crowd(size, seed=1)
    ids = [a.agent_id for a in crowd]
    assert (ids[0], ids[-1], len(set(ids))) == (first, last, size)
    assert all(AGENT_ID_RE.match(i) for i in ids)


def test_crowd_follows_the_mix_and_shuffles_personas():
    wanted = mix(5, 20, 5, 20)
    crowd = generate_crowd(50, wanted, seed=11)
    counts = {pid: sum(a.persona.id == pid for a in crowd) for pid in STAGE1}
    assert counts == wanted
    order = [a.persona.id for a in crowd]
    assert order != sorted(order, key=list(ARCHETYPES).index)


def test_a_mix_may_leave_archetypes_out():
    crowd = generate_crowd(4, {"holder": 4}, seed=0)
    assert {a.persona.id for a in crowd} == {"holder"}


def test_crowd_is_deterministic_per_seed():
    assert generate_crowd(50, seed=42) == generate_crowd(50, seed=42)
    assert generate_crowd(50, seed=42) != generate_crowd(50, seed=43)


def test_handles_are_unique_and_well_formed_even_for_big_crowds():
    crowd = generate_crowd(9999, seed=3)
    handles = [a.handle for a in crowd]
    assert len(set(handles)) == len(handles)
    assert all(HANDLE_RE.match(h) for h in handles)
    assert all(re.search(r"[1-9][0-9]$", h) for h in handles)


def test_word_lists_avoid_names_and_never_collide():
    words = set(generator._ADJECTIVES) | set(generator._ANIMALS)
    assert not words & GIVEN_NAMES
    assert all(w.isascii() and w.isalpha() and w.islower() for w in words)
    combos = {a + b for a in generator._ADJECTIVES for b in generator._ANIMALS}
    assert len(combos) == len(generator._ADJECTIVES) * len(generator._ANIMALS)


def test_wallets_start_inside_the_persona_range_in_exact_wei():
    for agent in generate_crowd(200, seed=9):
        low, high = (Decimal(str(v)) * 10**18 for v in agent.persona.initial_eth)
        assert low <= agent.initial_eth_wei <= high
        assert agent.initial_eth_wei % 10**14 == 0
        assert agent.per_agent_cap_eth == Decimal(str(agent.persona.per_agent_cap_eth))
        assert agent.per_agent_cap_wei == int(agent.per_agent_cap_eth * 10**18)
        assert agent.initial_token_weight == agent.persona.initial_token_weight


def test_run_dict_matches_the_run_json_agent_entry():
    agent = generate_crowd(5, seed=0)[0]
    assert agent.to_run_dict() == {
        "agentId": agent.agent_id,
        "handle": agent.handle,
        "persona": agent.persona.id,
    }


@pytest.mark.parametrize("size", [1, 2, 7, 50, 333])
def test_mix_and_agents_match_the_run_json_schema(size):
    if not SCHEMA_FILE.is_file():
        pytest.skip(f"{SCHEMA_FILE} is missing; it is produced by packages/schema")
    crowd_schema = json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))["properties"]["crowd"]
    props = crowd_schema["properties"]
    jsonschema.validate(default_mix(size), props["personaMix"])
    # The simulation adds each agent's start balances, read from the chain after seeding.
    agents = [
        {**a.to_run_dict(), "startEth": "1", "startTokens": "0"} for a in generate_crowd(size, seed=size)
    ]
    jsonschema.validate(agents, props["agents"])


@pytest.mark.parametrize("size", [0, -1, 10_000, True, 2.0])
def test_crowd_size_is_validated(size):
    with pytest.raises(PersonaMixError, match="crowd size"):
        generate_crowd(size)  # type: ignore[arg-type]


def test_mix_must_match_size_and_known_personas():
    with pytest.raises(PersonaMixError, match="sums to 3"):
        generate_crowd(4, {"holder": 3})
    with pytest.raises(PersonaMixError, match="unknown persona"):
        generate_crowd(3, {"wizard": 3})
    with pytest.raises(PersonaMixError, match="whole number"):
        generate_crowd(3, {"holder": 3.0})  # type: ignore[dict-item]
