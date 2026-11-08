"""The sources: feeds, pools and casts, and what happens when one of them fails."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime

import httpx
import pytest

from hyvo.narrative import farcaster, pools, rss
from hyvo.narrative.signals import MAX_BYTES, SourceError, collect, fetch_bytes

from .samples import NOW, pool_row

RSS = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>News</title>
<item>
  <title><![CDATA[Stablecoins &amp; memecoins lift Robinhood volume]]></title>
  <link>https://news.example/a?utm_source=rss&amp;id=1</link>
  <pubDate>Thu, 05 Nov 2026 18:48:40 +0000</pubDate>
  <description><![CDATA[<p style="x"><img src="https://x/y.png"/>Volume rose. <b>$FIZZ</b> led.</p>]]></description>
</item>
<item><title>No date, so no signal</title><link>https://news.example/b</link></item>
<item><title></title><link>https://news.example/c</link><pubDate>Thu, 05 Nov 2026 18:00:00 +0000</pubDate></item>
<item><title>Not the web</title><link>javascript:alert(1)</link><pubDate>Thu, 05 Nov 2026 18:00:00 +0000</pubDate></item>
</channel></rss>"""

ATOM = b"""<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>A hack drained a bridge</title><link rel="alternate" href="https://news.example/atom"/>
<updated>2026-11-05T10:00:00Z</updated><summary>Short.</summary></entry>
</feed>"""


def client(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_an_rss_feed_becomes_clean_signals() -> None:
    [signal] = rss.parse_feed(RSS, "news.example")
    assert signal.kind == "news" and signal.source == "news.example"
    assert signal.title == "Stablecoins & memecoins lift Robinhood volume"
    assert signal.text == "Volume rose. $FIZZ led."
    assert signal.at == datetime(2026, 11, 5, 18, 48, 40, tzinfo=UTC)


def test_a_link_loses_its_tracking_and_only_the_web_counts() -> None:
    [signal] = rss.parse_feed(RSS, "news.example")
    assert signal.url == "https://news.example/a"
    assert signal.key == "news:https://news.example/a"


def test_an_atom_feed_works_too() -> None:
    [signal] = rss.parse_feed(ATOM, "x")
    assert signal.url == "https://news.example/atom" and signal.at.year == 2026 and "Security" in signal.entities


def test_topics_and_tickers_are_what_a_headline_is_about_and_never_a_name() -> None:
    [signal] = rss.parse_feed(RSS, "x")
    assert {"Stablecoins", "Memecoins", "Robinhood", "FIZZ"} == set(signal.entities)
    assert rss.topics_in("Jane Doe, the founder, spoke about nothing in particular") == ()


@pytest.mark.parametrize(
    "document",
    [
        b'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><rss><channel><title>&lol2;</title></channel></rss>',
        b'<!-- ' + b"x" * 10_000 + b' --><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss><channel><title>&xxe;</title></channel></rss>',
        b"<!DOCTYPE rss><rss/>",
    ],
)
def test_a_document_type_is_refused_wherever_it_is(document: bytes) -> None:
    with pytest.raises(SourceError, match="document type"):
        rss.parse_feed(document, "x")


def test_what_is_not_xml_is_a_clear_failure() -> None:
    with pytest.raises(SourceError, match="not XML"):
        rss.parse_feed(b"<html><body>Blocked", "x")


def test_new_pools_become_launches() -> None:
    body = {"data": [pool_row(), pool_row(name="not a pair")]}
    http = client(lambda request: httpx.Response(200, json=body))
    [signal] = pools.new_pools(http, now=NOW)
    assert signal.kind == "launch" and signal.key == "launch:0xaa00000000000000000000000000000000000001"
    assert signal.refs == {"pool": "0xaa00000000000000000000000000000000000001", "quote": "WETH", "dex": "pons-v2", "token": "0xbbb0000000000000000000000000000000000001", "symbol": "FIZZ"}
    assert signal.numbers["reserveUsd"] == 60000.5 and signal.numbers["changeH24"] == 40.25 and signal.numbers["feePct"] == 1.0
    assert signal.numbers["buysH24"] == 120 and signal.at == datetime(2026, 11, 5, 20, 0, tzinfo=UTC)
    assert signal.entities == ("FIZZ",)


def test_a_pool_seen_again_within_the_hour_is_the_same_signal_and_later_a_new_one() -> None:
    http = client(lambda request: httpx.Response(200, json={"data": [pool_row()]}))
    [one] = pools.trending_pools(http, now=NOW)
    [two] = pools.trending_pools(http, now=NOW.replace(minute=50))
    [three] = pools.trending_pools(http, now=NOW.replace(hour=2))
    assert one.key == two.key != three.key and one.kind == "move"


def test_missing_numbers_stay_missing() -> None:
    row = pool_row(reserve_in_usd=None, fdv_usd=None, price_change_percentage={}, volume_usd={}, transactions={})
    http = client(lambda request: httpx.Response(200, json={"data": [row]}))
    [signal] = pools.top_pools(http, now=NOW)
    assert "reserveUsd" not in signal.numbers and "changeH24" not in signal.numbers


def test_the_rate_limit_gets_one_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    waits: list[float] = []
    monkeypatch.setattr(pools.time, "sleep", waits.append)
    answers = [httpx.Response(429), httpx.Response(200, json={"data": [pool_row()]})]
    http = client(lambda request: answers.pop(0))
    assert len(pools.new_pools(http, now=NOW)) == 1
    assert waits == [pools.RATE_LIMIT_WAIT_S]
    refused = client(lambda request: httpx.Response(429))
    with pytest.raises(SourceError, match="429"):
        pools.new_pools(refused, now=NOW)
    down = client(lambda request: httpx.Response(500))
    waits.clear()
    with pytest.raises(SourceError, match="500"):
        pools.new_pools(down, now=NOW)
    assert waits == [], "only the rate limit is worth waiting for"


def test_the_right_pages_are_asked_for() -> None:
    urls: list[str] = []

    def answer(request: httpx.Request) -> httpx.Response:
        urls.append(str(request.url))
        return httpx.Response(200, json={"data": []})

    http = client(answer)
    pools.new_pools(http)
    pools.trending_pools(http)
    pools.top_pools(http)
    assert urls[0].endswith("/networks/robinhood/new_pools?page=1")
    assert urls[1].endswith("/networks/robinhood/trending_pools?page=1")
    assert urls[2].endswith("/networks/robinhood/pools?page=1&sort=h24_volume_usd_desc")


def test_the_largest_swap_skips_what_the_indexer_calls_anomalous_and_reads_no_wallet() -> None:
    trades = [
        {"attributes": {"volume_in_usd": "500.5", "tx_from_address": "0xwho", "is_anomalous": False}},
        {"attributes": {"volume_in_usd": "900000", "tx_from_address": "0xwho", "is_anomalous": True}},
        {"attributes": {"volume_in_usd": "1200", "tx_from_address": "0xwho"}},
    ]
    http = client(lambda request: httpx.Response(200, json={"data": trades}))
    assert pools.largest_swap_usd(http, "0xpool") == 1200.0
    empty = client(lambda request: httpx.Response(200, json={"data": []}))
    assert pools.largest_swap_usd(empty, "0xpool") is None


def test_casts_keep_their_topics_and_lose_their_words_and_authors() -> None:
    casts = {
        "result": {
            "casts": [
                {"hash": "0xabc", "text": "Jane says Robinhood stablecoins are wild", "timestamp": "2026-11-05T10:00:00.000Z", "author": {"username": "jane"}},
                {"hash": "", "text": "no hash", "timestamp": "2026-11-05T10:00:00.000Z"},
                {"hash": "0xdef", "text": "bad time", "timestamp": "yesterday"},
            ]
        }
    }
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=casts)

    [signal] = farcaster.search_casts(client(answer), "secret-key")
    assert signal.kind == "cast" and set(signal.entities) == {"Robinhood", "Stablecoins"}
    assert signal.title == "" and signal.text == "" and "jane" not in json.dumps(signal.refs)
    assert seen[0].headers["x-api-key"] == "secret-key"
    assert seen[0].url.params["q"] == "robinhood chain"


def test_a_failing_source_stops_nothing_and_is_named() -> None:
    lines: list[str] = []

    def bad(http: httpx.Client) -> list:
        raise httpx.ConnectError("blocked")

    def also_bad(http: httpx.Client) -> list:
        raise SourceError("no")

    def good(http: httpx.Client) -> list:
        return rss.parse_feed(RSS, "x")

    result = collect({"a": bad, "b": good, "c": also_bad}, log=lines.append, client=client(lambda r: httpx.Response(200)))
    assert len(result.signals) == 1 and result.failed == ("a", "c")
    assert any("source a failed" in line for line in lines)


def test_an_answer_is_size_limited_and_an_error_is_an_error() -> None:
    http = client(lambda request: httpx.Response(200, content=b"x" * (MAX_BYTES + 1)))
    with pytest.raises(SourceError, match="more than"):
        fetch_bytes(http, "https://x.test/")
    refused = client(lambda request: httpx.Response(429))
    with pytest.raises(SourceError, match="429"):
        fetch_bytes(refused, "https://x.test/")
