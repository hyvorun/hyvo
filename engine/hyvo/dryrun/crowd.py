"""The users who try a dApp (SPEC §11.1). Archetypes, each with its own habits and its own money."""

from __future__ import annotations

import random
from dataclasses import dataclass

from eth_utils import to_wei


@dataclass(frozen=True)
class UserPersona:
    id: str
    label: str
    habit: str
    start_eth: str


NEWCOMER = UserPersona(
    "newcomer",
    "newcomer",
    "Has never used this dApp. Tries the obvious function first, with small amounts, and is easily confused by errors. Says so when something is unclear.",
    "1",
)
POWER_USER = UserPersona(
    "power_user",
    "power user",
    "Knows contracts. Goes through whole flows in order, uses every feature, and notices when a number does not add up.",
    "5",
)
ADVERSARIAL = UserPersona(
    "adversarial",
    "adversarial tester",
    "Tries to break it: zero amounts, huge amounts, calling things out of order, other people's addresses, and doing the same thing twice.",
    "5",
)
WHALE = UserPersona(
    "whale",
    "whale",
    "Moves large amounts, then takes them out again, and watches what its size does to everyone else.",
    "100",
)
PERSONAS = (NEWCOMER, POWER_USER, ADVERSARIAL, WHALE)
BY_ID = {persona.id: persona for persona in PERSONAS}


@dataclass(frozen=True)
class TestUser:
    agent_id: str
    persona: UserPersona

    @property
    def start_wei(self) -> int:
        return to_wei(self.persona.start_eth, "ether")


def make_crowd(size: int, seed: int) -> list[TestUser]:
    """The personas in turn, so every crowd has all four, in an order that follows from the seed."""
    order = list(PERSONAS)
    random.Random(seed).shuffle(order)
    return [TestUser(f"u{index + 1:02d}", order[index % len(order)]) for index in range(size)]
