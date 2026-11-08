"""Scenario builders: a Markdown file for the CLI, plain fields for API jobs.

Markdown format::

    ---
    title: Fictional token GLINT lists with a 5% creator tax
    token_symbol: GLINT
    liquidity_eth: 5
    ---

    Seed text: what the crowd reads before round 1.

    ## Events

    - round 3: A large wallet enters.
    - round 5: Rumor: the dev wallet sold 20%.

The front matter is flat ``key: value`` lines: a required ``title``, the optional market
overrides ``token_symbol``, ``token_name``, ``liquidity_eth``, ``liquidity_tokens``, ``fee_bps``,
and optional ``sources``: what the scenario was built from, as ``url https://… | onchain robinhood:0x…``.
Without it the run records the file's name. Values may be quoted; there are no inline comments and no
nesting; full-line ``#`` comments are allowed. The optional ``## Events`` section must be the last section. All text is sanitized and
capped (see ``sanitize``).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from decimal import Decimal
from pathlib import Path
from typing import Any

from .models import (
    MAX_TOKEN_NAME_CHARS,
    InjectedEvent,
    MarketOverrides,
    Scenario,
    ScenarioError,
    SeedSource,
    check_market_field,
)
from .sanitize import MAX_EVENT_CHARS, MAX_TITLE_CHARS, sanitize_line, sanitize_text

MARKET_KEYS = ("token_symbol", "token_name", "liquidity_eth", "liquidity_tokens", "fee_bps")
FRONT_MATTER_KEYS = ("title", "sources", *MARKET_KEYS)

_KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)[ \t]*:(.*)$")
_HEADING_RE = re.compile(r"^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$")
_EVENT_RE = re.compile(r"^[-*][ \t]*round[ \t]+([0-9]+)[ \t]*:(.*)$", re.IGNORECASE)
_DECIMAL_RE = re.compile(r"^[0-9]+(\.[0-9]+)?$")
_INT_RE = re.compile(r"^[0-9]+$")


def load_scenario_file(path: str | Path) -> Scenario:
    """Read a UTF-8 scenario file. Only the file name is recorded as the seed source ref,
    so local directory names never reach the published run.json."""
    path = Path(path)
    return parse_scenario_markdown(path.read_text(encoding="utf-8-sig"), ref=path.name)


def parse_scenario_markdown(text: str, ref: str = "scenario.md") -> Scenario:
    text = text.removeprefix("\N{BYTE ORDER MARK}")
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if lines[0].strip() != "---":
        raise ScenarioError(
            "line 1: a scenario starts with front matter: a '---' line, 'title: ...', "
            "and a closing '---' line"
        )
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        raise ScenarioError("front matter opened on line 1 is never closed with a '---' line")
    meta = _front_matter(lines[1:end], first_lineno=2)
    seed_lines, events = _body(lines[end + 1 :], first_lineno=end + 2)

    if "title" not in meta:
        raise ScenarioError("front matter needs a 'title: ...' line")
    raw_title, title_lineno = meta["title"]
    title = sanitize_line(raw_title, MAX_TITLE_CHARS)
    if not title:
        raise ScenarioError(f"line {title_lineno}: title must not be empty")
    market = _market(meta)
    return _scenario(
        title=title,
        seed_text=sanitize_text("\n".join(seed_lines)),
        events=events,
        ref=ref,
        market=market,
        sources=_sources(meta),
    )


def from_text(
    title: str,
    seed_text: str,
    events: Iterable[InjectedEvent | Mapping[str, Any]] = (),
    *,
    ref: str = "api",
    market: MarketOverrides | None = None,
) -> Scenario:
    """Build a scenario from API job fields. ``events`` items are ``InjectedEvent`` or
    ``{"round": int, "text": str}`` mappings; all text is sanitized."""
    if not isinstance(title, str) or not isinstance(seed_text, str):
        raise ScenarioError("title and seed text must be strings")
    clean_title = sanitize_line(title, MAX_TITLE_CHARS)
    if not clean_title:
        raise ScenarioError("title must not be empty")
    parsed = []
    for index, event in enumerate(events):
        if isinstance(event, InjectedEvent):
            round_n, text = event.round, event.text
        elif isinstance(event, Mapping):
            round_n, text = event.get("round"), event.get("text")
        else:
            raise ScenarioError(f"event {index}: expected an object with 'round' and 'text'")
        if isinstance(round_n, bool) or not isinstance(round_n, int) or round_n < 1:
            raise ScenarioError(f"event {index}: round must be a whole number >= 1")
        if not isinstance(text, str):
            raise ScenarioError(f"event {index}: text must be a string")
        clean = sanitize_line(text, MAX_EVENT_CHARS)
        if not clean:
            raise ScenarioError(f"event {index}: text must not be empty")
        parsed.append(InjectedEvent(round_n, clean))
    return _scenario(
        title=clean_title, seed_text=sanitize_text(seed_text), events=parsed, ref=ref, market=market
    )


def _scenario(
    *,
    title: str,
    seed_text: str,
    events: list[InjectedEvent],
    ref: str,
    market: MarketOverrides | None,
    sources: tuple[SeedSource, ...] = (),
) -> Scenario:
    return Scenario(
        title=title,
        seed_text=seed_text,
        seed_sources=sources or (SeedSource("user", ref),),
        injected_events=tuple(sorted(events, key=lambda e: e.round)),
        market=market,
    )


def _front_matter(lines: list[str], first_lineno: int) -> dict[str, tuple[str, int]]:
    meta: dict[str, tuple[str, int]] = {}
    for lineno, raw in enumerate(lines, start=first_lineno):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if raw[:1] in (" ", "\t"):
            raise ScenarioError(
                f"line {lineno}: nested front matter is not supported; use flat 'key: value' lines"
            )
        match = _KEY_RE.match(line)
        if not match:
            raise ScenarioError(f"line {lineno}: expected 'key: value'")
        key = match.group(1)
        if key not in FRONT_MATTER_KEYS:
            raise ScenarioError(
                f"line {lineno}: unknown front matter key {key!r}; "
                f"allowed: {', '.join(FRONT_MATTER_KEYS)}"
            )
        if key in meta:
            raise ScenarioError(f"line {lineno}: duplicate front matter key {key!r}")
        meta[key] = (_unquote(match.group(2).strip()), lineno)
    return meta


def _body(lines: list[str], first_lineno: int) -> tuple[list[str], list[InjectedEvent]]:
    seed: list[str] = []
    events: list[InjectedEvent] = []
    in_events = False
    for lineno, raw in enumerate(lines, start=first_lineno):
        heading = _HEADING_RE.match(raw)
        if heading and len(heading.group(1)) <= 2:
            is_events = len(heading.group(1)) == 2 and heading.group(2).strip().lower() == "events"
            if in_events and is_events:
                raise ScenarioError(f"line {lineno}: only one '## Events' section is allowed")
            if in_events:
                raise ScenarioError(
                    f"line {lineno}: the '## Events' section must be the last section"
                )
            if is_events:
                in_events = True
                continue
        if not in_events:
            seed.append(raw)
            continue
        line = raw.strip()
        if not line:
            continue
        match = _EVENT_RE.match(line)
        if not match:
            raise ScenarioError(f"line {lineno}: event lines look like '- round 4: what happens'")
        round_n = int(match.group(1))
        if round_n < 1:
            raise ScenarioError(f"line {lineno}: event round must be 1 or more")
        text = sanitize_line(match.group(2), MAX_EVENT_CHARS)
        if not text:
            raise ScenarioError(f"line {lineno}: event text must not be empty")
        events.append(InjectedEvent(round_n, text))
    return seed, events


def _sources(meta: Mapping[str, tuple[str, int]]) -> tuple[SeedSource, ...]:
    if "sources" not in meta:
        return ()
    raw, lineno = meta["sources"]
    found = []
    for part in raw.split(" | "):
        kind, _, ref = part.strip().partition(" ")
        if kind not in ("url", "onchain"):
            raise ScenarioError(f"line {lineno}: a source looks like 'url https://…' or 'onchain robinhood:0x…'")
        if kind == "url" and not ref.startswith(("https://", "http://")):
            raise ScenarioError(f"line {lineno}: a url source must start with http")
        try:
            found.append(SeedSource(kind, ref.strip()))
        except ScenarioError as error:
            raise ScenarioError(f"line {lineno}: {error}") from None
    return tuple(found)


def _market(meta: Mapping[str, tuple[str, int]]) -> MarketOverrides | None:
    values: dict[str, Any] = {}
    for key in MARKET_KEYS:
        if key not in meta:
            continue
        raw, lineno = meta[key]
        try:
            values[key] = _market_value(key, raw)
            check_market_field(key, values[key])
        except ScenarioError as error:
            raise ScenarioError(f"line {lineno}: {error}") from None
    return MarketOverrides(**values) if values else None


def _market_value(key: str, raw: str) -> Any:
    if not raw:
        raise ScenarioError(f"{key} must not be empty")
    if key == "token_symbol":
        return raw.removeprefix("$").upper()
    if key == "token_name":
        return sanitize_line(raw, MAX_TOKEN_NAME_CHARS)
    if key == "fee_bps":
        if not _INT_RE.match(raw):
            raise ScenarioError(f"fee_bps must be a whole number, got {raw!r}")
        return int(raw)
    if not _DECIMAL_RE.match(raw):
        raise ScenarioError(f"{key} must be a plain decimal number such as 5 or 0.25, got {raw!r}")
    return Decimal(raw)


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value
