"""Crowd generation: persona mix, agent ids, generated handles and starting wallets.

Everything is derived from ``seed`` with a private ``random.Random``, so the same inputs always
give the same crowd. Handles are adjective + animal + two digits from fixed word lists chosen
to avoid common given names, so a handle is never a real person's name.
"""

from __future__ import annotations

import random
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from decimal import Decimal

from .archetypes import ARCHETYPES, STAGE1, Persona

DEFAULT_WEIGHTS: Mapping[str, int] = {"sniper": 10, "holder": 15, "panic_seller": 10, "skeptic": 15}
MAX_CROWD_SIZE = 9999  # agent ids are a + up to 4 digits (run.json AgentId)

_ADJECTIVES = (
    "quiet", "brisk", "calm", "breezy", "eager", "foggy", "gentle", "hasty", "icy", "jumpy",
    "keen", "mellow", "nimble", "plucky", "rapid", "spry", "tidy", "vivid", "wary", "zesty",
    "bold", "chilly", "clever", "cosmic", "crisp", "daring", "fizzy", "fuzzy", "gloomy", "humble",
    "lofty", "moody", "noisy", "polar", "salty", "shy", "sleepy", "snowy", "steady", "witty",
)  # fmt: skip
_ANIMALS = (
    "ferret", "heron", "otter", "badger", "marmot", "lynx", "ibex", "gecko", "okapi", "puffin",
    "walrus", "bison", "beaver", "mole", "moth", "owl", "panda", "quokka", "raccoon", "sloth",
    "squid", "stoat", "tapir", "toad", "trout", "turtle", "viper", "vole", "weasel", "wombat",
    "yak", "zebra", "alpaca", "egret", "ibis", "koala", "lemur", "llama", "magpie", "narwhal",
)  # fmt: skip
_SUFFIXES = 90  # two-digit numbers 10..99

_WEI_PER_ETH = 10**18
_ETH_STEP = Decimal("0.0001")  # starting balances are whole multiples of this
_COUNT_RE = re.compile(r"^[0-9]+$")


class PersonaMixError(ValueError):
    """A persona mix is malformed or does not match the crowd size."""


@dataclass(frozen=True)
class AgentSpec:
    """One generated agent. ``to_run_dict`` gives the identity fields of its run.json
    ``crowd.agents`` entry; the simulation adds ``startEth``/``startTokens`` from the chain."""

    agent_id: str
    handle: str
    persona: Persona
    initial_eth_wei: int
    initial_token_weight: float
    per_agent_cap_eth: Decimal

    @property
    def per_agent_cap_wei(self) -> int:
        return int(self.per_agent_cap_eth * _WEI_PER_ETH)

    def to_run_dict(self) -> dict[str, str]:
        return {"agentId": self.agent_id, "handle": self.handle, "persona": self.persona.id}


def default_mix(size: int) -> dict[str, int]:
    """Split ``size`` in proportion to ``DEFAULT_WEIGHTS`` (largest remainder method).

    Ties go to the archetype listed first. Like every mix in this module, the result is in
    ``ARCHETYPES`` order with every Stage 1 archetype, zeros included, and a later one only when it
    has agents, which is the shape of run.json ``crowd.personaMix``.
    """
    _check_size(size)
    total = sum(DEFAULT_WEIGHTS.values())
    counts = {pid: size * weight // total for pid, weight in DEFAULT_WEIGHTS.items()}
    order = list(DEFAULT_WEIGHTS)
    by_remainder = sorted(
        order, key=lambda pid: (-(size * DEFAULT_WEIGHTS[pid] % total), order.index(pid))
    )
    for pid in by_remainder[: size - sum(counts.values())]:
        counts[pid] += 1
    return _canonical_mix(counts, size)


def parse_mix(text: str, size: int | None = None) -> dict[str, int]:
    """Parse ``"sniper=10,holder=15,panic_seller=10,skeptic=15"``.

    Archetypes left out count as zero. Returns the full mix in archetype order. With ``size``,
    the counts must sum to it.
    """
    if not text or not text.strip():
        raise PersonaMixError("persona mix is empty")
    mix: dict[str, int] = {}
    for part in text.split(","):
        item = part.strip()
        name, sep, count = (s.strip() for s in item.partition("="))
        if not sep or not name:
            raise PersonaMixError(f"persona mix entry {item!r} must look like 'sniper=10'")
        if name not in ARCHETYPES:
            raise PersonaMixError(f"unknown persona {name!r}; known: {', '.join(ARCHETYPES)}")
        if name in mix:
            raise PersonaMixError(f"persona {name!r} appears more than once in the mix")
        if not _COUNT_RE.match(count):
            raise PersonaMixError(f"count for {name!r} must be a whole number, got {count!r}")
        mix[name] = int(count)
    return _canonical_mix(mix, size)


def generate_crowd(
    size: int, mix: Mapping[str, int] | None = None, seed: int = 0
) -> list[AgentSpec]:
    """Generate ``size`` agents ``a01``... (ids zero-padded to ``max(2, digits(size))``).

    ``mix`` defaults to ``default_mix(size)``. Personas are shuffled across ids, handles are
    unique, and each wallet's starting ETH is drawn from its persona's ``initial_eth`` range.
    """
    _check_size(size)
    mix = default_mix(size) if mix is None else _canonical_mix(mix, size)
    rng = random.Random(f"hyvo.personas:{seed}")
    persona_ids = [pid for pid, count in mix.items() for _ in range(count)]
    rng.shuffle(persona_ids)
    handles = _handles(size, rng)
    width = max(2, len(str(size)))
    agents = []
    for index, (pid, handle) in enumerate(zip(persona_ids, handles, strict=True), start=1):
        persona = ARCHETYPES[pid]
        agents.append(
            AgentSpec(
                agent_id=f"a{index:0{width}d}",
                handle=handle,
                persona=persona,
                initial_eth_wei=_initial_eth_wei(persona, rng),
                initial_token_weight=persona.initial_token_weight,
                per_agent_cap_eth=Decimal(str(persona.per_agent_cap_eth)),
            )
        )
    return agents


def join_crowd(crowd: Sequence[AgentSpec], persona: Persona, seed: int) -> list[AgentSpec]:
    """``crowd`` with one agent, chosen by the seed, playing ``persona``. It keeps its id and handle, and takes the persona's wallet and limits."""
    rng = random.Random(f"hyvo.personas.join:{seed}")
    index = rng.randrange(len(crowd))
    joined = replace(
        crowd[index],
        persona=persona,
        initial_eth_wei=_initial_eth_wei(persona, rng),
        initial_token_weight=persona.initial_token_weight,
        per_agent_cap_eth=Decimal(str(persona.per_agent_cap_eth)),
    )
    return [*crowd[:index], joined, *crowd[index + 1 :]]


def _check_size(size: int) -> None:
    if isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= MAX_CROWD_SIZE:
        raise PersonaMixError(f"crowd size must be a whole number from 1 to {MAX_CROWD_SIZE}")


def _canonical_mix(mix: Mapping[str, int], size: int | None) -> dict[str, int]:
    for name, count in mix.items():
        if name not in ARCHETYPES:
            raise PersonaMixError(f"unknown persona {name!r}; known: {', '.join(ARCHETYPES)}")
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise PersonaMixError(f"count for {name!r} must be a whole number >= 0")
    total = sum(mix.values())
    if total == 0:
        raise PersonaMixError("persona mix must contain at least one agent")
    if size is not None and total != size:
        raise PersonaMixError(f"persona mix sums to {total}, but the crowd size is {size}")
    return {pid: mix.get(pid, 0) for pid in ARCHETYPES if pid in STAGE1 or mix.get(pid, 0) > 0}


def _handles(count: int, rng: random.Random) -> list[str]:
    """Distinct handles: each index of the adjective x animal x suffix space is used once."""
    picks = rng.sample(range(len(_ADJECTIVES) * len(_ANIMALS) * _SUFFIXES), count)
    handles = []
    for pick in picks:
        rest, suffix = divmod(pick, _SUFFIXES)
        adjective, animal = divmod(rest, len(_ANIMALS))
        handles.append(f"@{_ADJECTIVES[adjective]}{_ANIMALS[animal]}{suffix + 10}")
    return handles


def _initial_eth_wei(persona: Persona, rng: random.Random) -> int:
    low, high = (Decimal(str(v)) for v in persona.initial_eth)
    steps = int((high - low) / _ETH_STEP)
    return int((low + _ETH_STEP * rng.randint(0, steps)) * _WEI_PER_ETH)
