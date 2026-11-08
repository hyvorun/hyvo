"""Persona archetypes and crowd generation (SPEC 6.4)."""

from .archetypes import ARCHETYPES, STAGE1, Persona, get_persona
from .generator import (
    DEFAULT_WEIGHTS,
    MAX_CROWD_SIZE,
    AgentSpec,
    PersonaMixError,
    default_mix,
    generate_crowd,
    join_crowd,
    parse_mix,
)

__all__ = [
    "ARCHETYPES",
    "DEFAULT_WEIGHTS",
    "MAX_CROWD_SIZE",
    "STAGE1",
    "AgentSpec",
    "Persona",
    "PersonaMixError",
    "default_mix",
    "generate_crowd",
    "get_persona",
    "join_crowd",
    "parse_mix",
]
