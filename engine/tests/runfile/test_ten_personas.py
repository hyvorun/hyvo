"""A real run with every kind of trader in it (fixtures/ten-personas-run.json). The TypeScript side reads the same file."""

from __future__ import annotations

import json
from pathlib import Path

from hyvo.personas import ARCHETYPES
from hyvo.runfile import verify_run
from hyvo.runfile.models import PERSONAS, PersonaMix
from hyvo.world.verify import check_run_market

FIXTURES = Path(__file__).resolve().parents[3] / "fixtures"
TEN = FIXTURES / "ten-personas-run.json"
GOLDEN = FIXTURES / "golden-run.json"


def test_the_format_knows_every_archetype() -> None:
    assert list(PERSONAS) == list(ARCHETYPES)


def test_a_run_with_all_of_them_verifies_and_replays() -> None:
    result = verify_run(TEN)
    assert result.ok, (result.schema_errors, result.model_errors)
    assert check_run_market(json.loads(TEN.read_text(encoding="utf-8"))) == []


def test_every_kind_of_trader_is_in_it_and_counted() -> None:
    crowd = json.loads(TEN.read_text(encoding="utf-8"))["crowd"]
    assert crowd["personaMix"] == dict.fromkeys(PERSONAS, 2)
    assert {agent["persona"] for agent in crowd["agents"]} == set(PERSONAS)


def test_a_run_from_before_them_stays_as_it_was() -> None:
    mix = json.loads(GOLDEN.read_text(encoding="utf-8"))["crowd"]["personaMix"]
    assert list(mix) == ["sniper", "holder", "panic_seller", "skeptic"]
    model = PersonaMix.model_validate(mix)
    assert model.model_dump(by_alias=True) == mix
    assert model.counts()["whale"] == 0
    assert verify_run(GOLDEN).ok
