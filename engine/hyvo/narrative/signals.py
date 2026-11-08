"""One thing a source saw, and collecting them. A source that fails is logged and the others go on."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

import httpx

Kind = Literal["news", "launch", "move", "cast"]

USER_AGENT = "hyvo-narrative/0.1"
TIMEOUT_S = 20.0
MAX_BYTES = 3 * 1024 * 1024


class SourceError(RuntimeError):
    """A source could not be read."""


@dataclass(frozen=True)
class Signal:
    kind: Kind
    source: str
    key: str  # stable: seeing the same thing again changes nothing
    title: str
    at: datetime
    text: str = ""
    url: str = ""
    entities: tuple[str, ...] = ()
    numbers: Mapping[str, float] = field(default_factory=dict)
    refs: Mapping[str, str] = field(default_factory=dict)


Fetcher = Callable[[httpx.Client], Iterable[Signal]]


@dataclass(frozen=True)
class Collected:
    signals: tuple[Signal, ...]
    failed: tuple[str, ...]


def collect(
    fetchers: Mapping[str, Fetcher],
    *,
    log: Callable[[str], None] = print,
    client: httpx.Client | None = None,
) -> Collected:
    """Read every source. One that fails is named in ``failed``."""
    http = client or httpx.Client(
        timeout=TIMEOUT_S, trust_env=False, follow_redirects=True, headers={"User-Agent": USER_AGENT}
    )
    signals: list[Signal] = []
    failed: list[str] = []
    try:
        for name, fetch in fetchers.items():
            try:
                found = list(fetch(http))
            except (httpx.HTTPError, SourceError, ValueError, KeyError, TypeError) as error:
                failed.append(name)
                log(f"narrative: source {name} failed: {type(error).__name__}: {str(error)[:200]}")
                continue
            log(f"narrative: {name}: {len(found)} signals")
            signals.extend(found)
    finally:
        if client is None:
            http.close()
    return Collected(tuple(signals), tuple(failed))


def fetch_bytes(http: httpx.Client, url: str, *, headers: Mapping[str, str] | None = None, params: Mapping[str, str] | None = None) -> bytes:
    """A size-limited GET: a source is someone else's server, and answers can be anything."""
    with http.stream("GET", url, headers=headers, params=params) as response:
        if response.status_code != 200:
            raise SourceError(f"{url} answered {response.status_code}")
        chunks: list[bytes] = []
        total = 0
        for chunk in response.iter_bytes():
            total += len(chunk)
            if total > MAX_BYTES:
                raise SourceError(f"{url} sent more than {MAX_BYTES} bytes")
            chunks.append(chunk)
    return b"".join(chunks)


def by_kind(signals: Sequence[Signal], *kinds: Kind) -> list[Signal]:
    return [signal for signal in signals if signal.kind in kinds]
