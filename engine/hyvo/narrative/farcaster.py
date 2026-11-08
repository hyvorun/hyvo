"""Farcaster casts through Neynar, only with ``NEYNAR_API_KEY`` set (docs/OPEN_ITEMS.md item 8).

What people cast only feeds the topic counts of the graph. No cast's words and no author ever reach a scenario: personas are
archetypes, and a seed pack names no real person.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import httpx

from .rss import topics_in
from .signals import Signal, SourceError, fetch_bytes

SEARCH_URL = "https://api.neynar.com/v2/farcaster/cast/search/"
DEFAULT_QUERY = "robinhood chain"
LIMIT = 50


def search_casts(http: httpx.Client, api_key: str, query: str = DEFAULT_QUERY) -> list[Signal]:
    data = fetch_bytes(http, SEARCH_URL, headers={"x-api-key": api_key}, params={"q": query, "limit": str(LIMIT)})
    casts = ((json.loads(data).get("result") or {}).get("casts"))
    if not isinstance(casts, list):
        raise SourceError("the answer holds no casts")
    signals = []
    for cast in casts:
        digest = str(cast.get("hash", ""))
        text = str(cast.get("text", ""))
        try:
            at = datetime.fromisoformat(str(cast.get("timestamp", "")).replace("Z", "+00:00")).astimezone(UTC)
        except ValueError:
            continue
        if digest:
            # Stored without its words: the topics are all that is kept.
            signals.append(Signal(kind="cast", source="farcaster", key=f"cast:{digest}", title="", at=at, entities=topics_in(text)))
    return signals
