from __future__ import annotations

import re
from dataclasses import fields

import pytest

from hyvo.personas import ARCHETYPES, STAGE1, Persona, get_persona

# Advice and prediction phrasing that must never appear in persona text (SPEC 2, 6.7, 13).
ADVICE_RE = re.compile(
    r"\b(you|we|traders?|investors?|holders?|everyone)\s+(should|must|need\s+to)\b"
    r"|\b(buy|sell)\s+(now|signal|the\s+dip)\b"
    r"|\bguarantee[ds]?\b|\bwill\s+(pump|moon|\d+x)\b|\b(good|bad)\s+token\b"
    r"|\bnot\s+financial\s+advice\b",
    re.IGNORECASE,
)


def texts(persona: Persona) -> list[str]:
    return [
        persona.label,
        persona.goal,
        persona.risk_tolerance,
        persona.time_horizon,
        persona.posting_style,
        *persona.triggers,
    ]


def test_the_archetypes_of_the_spec_in_order():
    assert list(STAGE1) == ["sniper", "holder", "panic_seller", "skeptic"]
    assert list(ARCHETYPES) == [*STAGE1, "swing_trader", "whale", "kol_follower", "market_maker_bot", "stock_token_holder", "newcomer"]
    assert all(pid == p.id for pid, p in ARCHETYPES.items())


@pytest.mark.parametrize("persona", list(ARCHETYPES.values()), ids=list(ARCHETYPES))
def test_each_archetype_is_complete_english_and_never_advice(persona):
    for text in texts(persona):
        assert text.strip() and text.isascii(), text
        assert not ADVICE_RE.search(text), text
    assert len(persona.triggers) >= 3


@pytest.mark.parametrize("persona", list(ARCHETYPES.values()), ids=list(ARCHETYPES))
def test_each_archetype_has_coherent_sizes(persona):
    low, high = persona.typical_size_eth
    assert 0 < low < high <= persona.per_agent_cap_eth
    start_low, start_high = persona.initial_eth
    # every wallet can afford at least one swap at the cap
    assert persona.per_agent_cap_eth < start_low < start_high
    assert 0.0 <= persona.initial_token_weight <= 10.0


def test_archetypes_are_distinct():
    for name in ("goal", "posting_style", "triggers", "risk_tolerance", "time_horizon"):
        values = [getattr(p, name) for p in ARCHETYPES.values()]
        assert len(set(values)) == len(values), name
    caps = [p.per_agent_cap_eth for p in ARCHETYPES.values()]
    assert len(set(caps)) == len(caps)


def test_risk_appetite_orders_the_caps():
    assert (
        ARCHETYPES["sniper"].per_agent_cap_eth
        > ARCHETYPES["holder"].per_agent_cap_eth
        > ARCHETYPES["panic_seller"].per_agent_cap_eth
        > ARCHETYPES["skeptic"].per_agent_cap_eth
    )


def test_describe_renders_every_field():
    sniper = get_persona("sniper")
    text = sniper.describe()
    assert text.startswith("Archetype: Sniper\n")
    assert sniper.goal in text and sniper.posting_style in text
    assert all(trigger in text for trigger in sniper.triggers)
    assert "0.05 to 0.25 ETH" in text and "0.3 ETH in one swap" in text


def test_personas_are_immutable_and_lookup_is_strict():
    with pytest.raises(AttributeError):
        ARCHETYPES["holder"].goal = "x"  # type: ignore[misc]
    with pytest.raises(TypeError):
        ARCHETYPES["wizard"] = ARCHETYPES["holder"]  # type: ignore[index]
    with pytest.raises(KeyError, match="known: sniper, holder, panic_seller, skeptic"):
        get_persona("wizard")
    assert {f.name for f in fields(Persona)} >= {
        "goal", "risk_tolerance", "time_horizon", "triggers", "posting_style", "typical_size_eth",
    }  # fmt: skip
