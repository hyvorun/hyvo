"""Signals and answers shaped like the real sources' (read on 2026-11-06), with made-up tokens and headlines."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

from hyvo.llm.types import ChatMessage, LLMResult, Prices
from hyvo.narrative.signals import Signal

NOW = datetime(2026, 11, 6, 1, 0, tzinfo=UTC)


def pool_row(
    name: str = "FIZZ / WETH 1%",
    address: str = "0xAA00000000000000000000000000000000000001",
    dex: str = "pons-v2",
    created: str = "2026-11-05T20:00:00Z",
    **attributes: Any,
) -> dict[str, Any]:
    return {
        "id": f"robinhood_{address}",
        "type": "pool",
        "attributes": {
            "name": name,
            "address": address,
            "pool_created_at": created,
            "base_token_price_usd": "0.000012",
            "quote_token_price_usd": "3000.5",
            "fdv_usd": "1200000",
            "market_cap_usd": None,
            "reserve_in_usd": "60000.5",
            "price_change_percentage": {"m5": "1", "h1": "2.5", "h6": "10", "h24": "40.25"},
            "volume_usd": {"m5": "1", "h1": "2", "h6": "3", "h24": "25000"},
            "transactions": {"h24": {"buys": 120, "sells": 80}},
            **attributes,
        },
        "relationships": {
            "base_token": {"data": {"id": "robinhood_0xbbb0000000000000000000000000000000000001", "type": "token"}},
            "quote_token": {"data": {"id": "robinhood_0xccc", "type": "token"}},
            "dex": {"data": {"id": dex, "type": "dex"}},
        },
    }


def pool_signal(
    symbol: str = "FIZZ",
    *,
    kind: str = "move",
    dex: str = "pons-v2",
    at: datetime = NOW,
    age_hours: float = 5,
    reserve: float = 60_000,
    volume: float = 25_000,
    change: float = 40.0,
    fdv: float = 1_200_000,
    quote: str = "WETH",
    pool: str | None = None,
    **numbers: float,
) -> Signal:
    address = pool or f"0x{symbol.lower():0>40}"[:42]
    return Signal(
        kind=kind,  # type: ignore[arg-type]
        source="geckoterminal",
        key=f"{kind}:{address}:{at:%Y-%m-%dT%H}",
        title=f"{symbol} / {quote} on {dex}",
        at=at,
        entities=(symbol,),
        numbers={
            "reserveUsd": reserve,
            "volumeH24": volume,
            "changeH24": change,
            "fdvUsd": fdv,
            "priceUsd": 0.000012,
            "quoteUsd": 3000.0,
            "buysH24": 120.0,
            "sellsH24": 80.0,
            "createdAt": (NOW - timedelta(hours=age_hours)).timestamp(),
            **numbers,
        },
        refs={"pool": address, "quote": quote, "dex": dex, "token": "0xbbb", "symbol": symbol},
    )


def news_signal(title: str, *entities: str, at: datetime = NOW - timedelta(hours=2), url: str | None = None) -> Signal:
    link = url or f"https://news.example/{abs(hash(title)) % 10_000}"
    return Signal(kind="news", source="news.example", key=f"news:{link}", title=title, at=at, url=link, entities=entities)


class ReadingClient:
    """The report model reading lines: it flags those holding any of ``flag``."""

    model_label = "test/reader"
    prices = Prices(0.0, 0.0)

    def __init__(self, *flag: str, fail: bool = False) -> None:
        self.flag = flag
        self.fail = fail
        self.calls = 0

    def complete(self, messages: Sequence[ChatMessage], *, temperature: float, max_tokens: int, json_mode: bool, purpose: str) -> LLMResult:
        from hyvo.llm.types import LLMRequestError

        self.calls += 1
        if self.fail:
            raise LLMRequestError("the provider is down")
        body = messages[1].content
        flagged = [
            line.partition(" | ")[0]
            for line in body.splitlines()
            if " | " in line and any(word in line for word in self.flag)
        ]
        import json

        return LLMResult(
            text=json.dumps({"flagged": flagged}),
            input_tokens=1,
            output_tokens=1,
            model="test/reader",
            finish_reason="stop",
            latency_ms=1,
            cost_usd=0.0,
            estimated_tokens=False,
        )
