"""Robinhood Chain pools from GeckoTerminal's public API: new launches, what is trending, what moves most.

No key is needed. The limit is per IP and answers 429 when passed (docs/OPEN_ITEMS.md item 23), and this makes a few calls
a day. Scanning the chain directly is not an option on the free RPC: ``eth_getLogs`` covers about 100 blocks, some 10 seconds
of this chain.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import httpx

from .signals import Signal, SourceError, fetch_bytes

BASE_URL = "https://api.geckoterminal.com/api/v2/networks/robinhood"
POOLS_PAGE = "https://www.geckoterminal.com/robinhood/pools"
_HEADERS = {"Accept": "application/json;version=20230203"}
_PAIR = re.compile(r"^\s*(\S+)\s*/\s*(\S+)(?:\s+([0-9.]+)%)?\s*$")
RATE_LIMIT_WAIT_S = 20.0


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def _when(raw: Any) -> datetime | None:
    if not isinstance(raw, str):
        return None
    try:
        stamp = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return stamp.astimezone(UTC)


def _pools(http: httpx.Client, path: str, params: Mapping[str, str] | None = None) -> list[dict[str, Any]]:
    url = f"{BASE_URL}{path}"
    try:
        data = fetch_bytes(http, url, headers=_HEADERS, params=params)
    except SourceError as error:
        if " 429" not in str(error):
            raise
        # The keyless limit is per IP and short: one wait is usually enough.
        time.sleep(RATE_LIMIT_WAIT_S)
        data = fetch_bytes(http, url, headers=_HEADERS, params=params)
    body = json.loads(data)
    rows = body.get("data")
    if not isinstance(rows, list):
        raise SourceError(f"{path}: no data in the answer")
    return rows


def _pool(row: Mapping[str, Any], kind: str, now: datetime) -> Signal | None:
    attributes = row.get("attributes") or {}
    relations = row.get("relationships") or {}
    match = _PAIR.match(str(attributes.get("name", "")))
    address = str(attributes.get("address", "")).lower()
    if not match or not address:
        return None
    symbol, quote, fee = match.group(1), match.group(2), match.group(3)
    created = _when(attributes.get("pool_created_at"))
    change = attributes.get("price_change_percentage") or {}
    volume = attributes.get("volume_usd") or {}
    trades = (attributes.get("transactions") or {}).get("h24") or {}
    dex = str(((relations.get("dex") or {}).get("data") or {}).get("id", ""))
    token_id = str(((relations.get("base_token") or {}).get("data") or {}).get("id", ""))
    numbers = {
        name: value
        for name, value in {
            "reserveUsd": _number(attributes.get("reserve_in_usd")),
            "fdvUsd": _number(attributes.get("fdv_usd")),
            "changeH1": _number(change.get("h1")),
            "changeH24": _number(change.get("h24")),
            "volumeH24": _number(volume.get("h24")),
            "buysH24": _number(trades.get("buys")),
            "sellsH24": _number(trades.get("sells")),
            "priceUsd": _number(attributes.get("base_token_price_usd")),
            "quoteUsd": _number(attributes.get("quote_token_price_usd")),
            "feePct": _number(fee),
            "createdAt": created.timestamp() if created else None,
        }.items()
        if value is not None
    }
    refs = {"pool": address, "quote": quote, "dex": dex, "token": token_id.partition("_")[2], "symbol": symbol}
    if kind == "launch":
        when = created or now
        return Signal(
            kind="launch",
            source="geckoterminal",
            key=f"launch:{address}",
            title=f"{symbol} opened a pool against {quote} on {dex}",
            at=when,
            entities=(symbol,),
            numbers=numbers,
            refs=refs,
        )
    return Signal(
        kind="move",
        source="geckoterminal",
        key=f"move:{address}:{now:%Y-%m-%dT%H}",
        title=f"{symbol} / {quote} on {dex}",
        at=now,
        entities=(symbol,),
        numbers=numbers,
        refs=refs,
    )


def new_pools(http: httpx.Client, *, now: datetime | None = None) -> list[Signal]:
    moment = now or datetime.now(UTC)
    return [signal for row in _pools(http, "/new_pools", {"page": "1"}) if (signal := _pool(row, "launch", moment))]


def trending_pools(http: httpx.Client, *, now: datetime | None = None) -> list[Signal]:
    moment = now or datetime.now(UTC)
    return [signal for row in _pools(http, "/trending_pools", {"page": "1"}) if (signal := _pool(row, "move", moment))]


def top_pools(http: httpx.Client, *, now: datetime | None = None) -> list[Signal]:
    moment = now or datetime.now(UTC)
    rows = _pools(http, "/pools", {"page": "1", "sort": "h24_volume_usd_desc"})
    return [signal for row in rows if (signal := _pool(row, "move", moment))]


def largest_swap_usd(http: httpx.Client, pool: str) -> float | None:
    """The largest recent swap in a pool, in USD. Who made it is never read."""
    rows = _pools(http, f"/pools/{pool}/trades", {"trade_volume_in_usd_greater_than": "100"})
    amounts = [
        amount
        for row in rows
        if not (row.get("attributes") or {}).get("is_anomalous")
        and (amount := _number((row.get("attributes") or {}).get("volume_in_usd"))) is not None
    ]
    return max(amounts) if amounts else None
