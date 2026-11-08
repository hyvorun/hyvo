"""Public news feeds, RSS 2.0 or Atom. A headline and a short summary are kept, with a link to the source."""

from __future__ import annotations

import html
import re
import xml.etree.ElementTree as ET
import xml.parsers.expat
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

import httpx

from hyvo.scenarios.sanitize import strip_control_chars

from .signals import Signal, SourceError, fetch_bytes

# All answered with a feed on 2026-11-06.
DEFAULT_FEEDS = (
    "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "https://cointelegraph.com/rss",
    "https://decrypt.co/feed",
    "https://blockworks.co/feed",
    "https://www.theblock.co/rss.xml",
)

MAX_ITEMS_PER_FEED = 30
MAX_SUMMARY_CHARS = 400
_ATOM = "{http://www.w3.org/2005/Atom}"
_TAG = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"\s+")

# What a headline can be about. Only these and tickers become graph entities: names of people never do.
TOPICS: dict[str, re.Pattern[str]] = {
    name: re.compile(pattern, re.IGNORECASE)
    for name, pattern in {
        "Robinhood": r"\brobinhood\b",
        "Pons": r"\bpons\b",
        "Bitcoin": r"\b(?:bitcoin|btc)\b",
        "Ether": r"\b(?:ethereum|ether|eth)\b",
        "Solana": r"\bsolana\b",
        "Stablecoins": r"\bstablecoins?\b",
        "Tokenized stocks": r"\b(?:tokeni[sz]ed\s+(?:stocks?|equit\w+|shares?)|stock\s+tokens?)\b",
        "Memecoins": r"\bmeme\s?(?:coins?|tokens?)\b",
        "ETFs": r"\bETFs?\b",
        "Regulation": r"\b(?:SEC|CFTC|regulat\w+|lawmakers?|senate|congress)\b",
        "Security": r"\b(?:hacks?|hacked|hackers?|exploits?|drained?)\b",
        "AI": r"\b(?:AI|artificial\s+intelligence)\b",
        "DeFi": r"\bdefi\b",
        "Layer 2s": r"\b(?:layer[-\s]?2|L2s?|rollups?|arbitrum)\b",
    }.items()
}
_TICKER = re.compile(r"\$([A-Z][A-Z0-9]{1,10})\b")


def topics_in(text: str) -> tuple[str, ...]:
    found = [name for name, pattern in TOPICS.items() if pattern.search(text)]
    found += [match for match in _TICKER.findall(text) if match not in found]
    return tuple(dict.fromkeys(found))


def clean_text(raw: str) -> str:
    """Plain text from what a feed calls text: markup gone, entities decoded, invisible characters out."""
    text = html.unescape(_TAG.sub(" ", raw))
    return _SPACE.sub(" ", strip_control_chars(text)).strip()


def _refuse_document_types(data: bytes, source: str) -> None:
    """A first pass that stops at any document type: a feed has no use for one, and it is the way into an XML parser
    (entity expansion, external entities). The parse that follows only ever sees a document without one."""

    def refuse(*_: object) -> None:
        raise SourceError(f"{source}: the feed declares a document type")

    parser = xml.parsers.expat.ParserCreate()
    parser.StartDoctypeDeclHandler = refuse
    parser.EntityDeclHandler = refuse
    try:
        parser.Parse(data, True)
    except xml.parsers.expat.ExpatError as error:
        raise SourceError(f"{source}: not XML: {error}") from None


def parse_feed(data: bytes, source: str) -> list[Signal]:
    _refuse_document_types(data, source)
    root = ET.fromstring(data)  # noqa: S314  (checked above: no document type, so no entities)
    entries = root.findall("./channel/item") or root.findall(f"./{_ATOM}entry") or root.findall("./entry")
    return [signal for entry in entries[:MAX_ITEMS_PER_FEED] if (signal := _entry(entry, source))]


def _entry(entry: ET.Element, source: str) -> Signal | None:
    title = clean_text(_text(entry, "title"))
    link = _link(entry)
    stamp = _when(_text(entry, "pubDate") or _text(entry, "published") or _text(entry, "updated"))
    if not title or not link or stamp is None:
        return None
    summary = clean_text(_text(entry, "description") or _text(entry, "summary"))[:MAX_SUMMARY_CHARS]
    return Signal(
        kind="news",
        source=source,
        key=f"news:{link}",
        title=title,
        at=stamp,
        text=summary,
        url=link,
        entities=topics_in(f"{title} {summary}"),
    )


def _text(entry: ET.Element, name: str) -> str:
    for candidate in (name, f"{_ATOM}{name}"):
        found = entry.find(candidate)
        if found is not None and found.text:
            return found.text
    return ""


def _link(entry: ET.Element) -> str:
    link = _text(entry, "link").strip()
    if not link:
        for candidate in entry.findall(f"{_ATOM}link") + entry.findall("link"):
            if candidate.get("rel", "alternate") == "alternate" and candidate.get("href"):
                link = candidate.get("href", "").strip()
                break
    parts = urlsplit(link)
    # The link goes into a published run: no tracking query, and only the web.
    return f"{parts.scheme}://{parts.netloc}{parts.path}" if parts.scheme in ("http", "https") and parts.netloc else ""


def _when(raw: str) -> datetime | None:
    raw = raw.strip()
    if not raw:
        return None
    try:
        stamp = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        try:
            stamp = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
    return (stamp if stamp.tzinfo else stamp.replace(tzinfo=UTC)).astimezone(UTC)


def fetch_feed(http: httpx.Client, url: str) -> list[Signal]:
    return parse_feed(fetch_bytes(http, url), urlsplit(url).netloc.removeprefix("www."))
