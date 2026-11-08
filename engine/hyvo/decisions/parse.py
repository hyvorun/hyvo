"""Turn one batch answer into exactly one ``Decision`` per expected agent.

``parse_decisions`` never raises on bad items: each problem is fixed or dropped and recorded in
the agent's ``notes`` (or in the batch's ``notes`` when no agent can be named). Only an answer
with no usable top level (not JSON, not an object, no decision list) raises
``LLMResponseError``, so the caller can retry once.

Agent notes: ``missing_decision``, ``duplicate_decision``, ``post_invalid``, ``post_empty``, ``post_placeholder``,
``post_urls_stripped``, ``post_clipped``, ``post_redacted:<rule>``, ``post_dropped``,
``reply_to_unknown``, ``likes_invalid``, ``like_unknown``, ``like_own``, ``like_repeat``, ``likes_capped``,
``market_invalid``, ``sentiment_missing``, ``sentiment_invalid``, ``sentiment_clamped``,
``reason_invalid``, ``reason_clipped``. Batch notes: ``item_invalid``, ``unknown_agent``.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Callable, Collection, Mapping, Sequence
from typing import Any

from hyvo.llm.json_utils import parse_json_object
from hyvo.llm.types import LLMResponseError
from hyvo.report.guard import find_violations, redact
from hyvo.report.prompt import clip
from hyvo.scenarios.sanitize import (
    normalize_whitespace,
    strip_control_chars,
    strip_urls,
)

from .prompt import MAX_LIKES, MAX_POST_CHARS, MAX_REASON_CHARS
from .types import Decision, PostIntent

_AGENT_NUMBER_RE = re.compile(r"^a?0*([0-9]{1,9})$")
# A decision needs about five brackets; the cap bounds JSON nesting depth before decoding.
MAX_OPEN_BRACKETS = 1_000


class DecisionBatch(dict[str, Decision]):
    """``agent id -> Decision`` in the order of the expected ids, plus batch-level ``notes``."""

    def __init__(self, decisions: Mapping[str, Decision] | None = None, notes: Sequence[str] = ()) -> None:
        super().__init__(decisions or {})
        self.notes: list[str] = list(notes)


def hold_decisions(agent_ids: Sequence[str], note: str) -> DecisionBatch:
    """A batch in which every agent holds and makes no post, each with ``note``."""
    return DecisionBatch({agent_id: _hold(agent_id, note) for agent_id in agent_ids})


def parse_decisions(
    text: str | None,
    expected_agent_ids: Sequence[str],
    known_post_ids: Collection[str],
    post_authors: Mapping[str, str] | None = None,
    liked: Mapping[str, Collection[str]] | None = None,
) -> DecisionBatch:
    """Parse a batch answer.

    ``known_post_ids`` are the ids the prompt showed (``visible_posts``); replies and likes may
    only target them. ``post_authors`` maps post id -> author agent id so agents cannot like
    their own posts; ``liked`` maps agent id -> ids it already liked, which it cannot like again.
    """
    items = _decision_items(_parse_answer(text))
    resolve = _agent_resolver(expected_agent_ids)
    known = frozenset(known_post_ids)
    authors = post_authors or {}
    first: dict[str, dict[str, Any]] = {}
    duplicated: set[str] = set()
    batch_notes: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            batch_notes.append("item_invalid")
            continue
        agent_id = resolve(item.get("agentId"))
        if agent_id is None:
            batch_notes.append("unknown_agent")
        elif agent_id in first:
            duplicated.add(agent_id)
        else:
            first[agent_id] = item
    decisions = {}
    for agent_id in expected_agent_ids:
        if agent_id not in first:
            decisions[agent_id] = _hold(agent_id, "missing_decision")
            continue
        notes = ["duplicate_decision"] if agent_id in duplicated else []
        decisions[agent_id] = _parse_item(
            agent_id, first[agent_id], known, authors, notes, (liked or {}).get(agent_id, ())
        )
    return DecisionBatch(decisions, list(dict.fromkeys(batch_notes)))


def clean_text(text: str) -> str:
    """One line of model text: NFC, no control or invisible characters, URLs reduced to plain
    ``host/path``, whitespace collapsed."""
    text = strip_urls(strip_control_chars(unicodedata.normalize("NFC", text)))
    return normalize_whitespace(text, single_line=True)


def _parse_answer(text: str | None) -> dict[str, Any]:
    """``parse_json_object``, guarded so that junk can only raise ``LLMResponseError``.

    An answer with more than ``MAX_OPEN_BRACKETS`` opening brackets is refused before decoding:
    ``web3`` imports ``py_ecc``, which raises the recursion limit to 100,000, and then a deeply
    nested answer overflows the C stack of the JSON decoder and kills the process instead of
    raising. Other decode failures (integers over 4,300 digits, ``RecursionError``) are mapped
    to ``LLMResponseError`` as well, so the caller's retry covers them.
    """
    if text and text.count("[") + text.count("{") > MAX_OPEN_BRACKETS:
        raise LLMResponseError("LLM answer has too many brackets to be a decision list")
    try:
        return parse_json_object(text)
    except LLMResponseError:
        raise
    except (ValueError, RecursionError):
        raise LLMResponseError("LLM returned JSON that cannot be decoded safely") from None


def _decision_items(answer: dict[str, Any]) -> list[Any]:
    """The decision list: ``decisions`` as a list, a map keyed by agent id, or one decision
    object; else the only list of objects in the answer; else a lone decision at top level."""
    value = answer.get("decisions")
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        if "agentId" in value:
            return [value]
        if all(isinstance(item, dict) for item in value.values()):
            return [{**item, "agentId": key} for key, item in value.items()]
    lists = [v for v in answer.values() if isinstance(v, list) and v and all(isinstance(i, dict) for i in v)]
    if value is None and len(lists) == 1:
        return lists[0]
    if value is None and "agentId" in answer:
        return [answer]
    raise LLMResponseError("the answer has no usable 'decisions' list")


def _agent_resolver(expected: Sequence[str]) -> Callable[[Any], str | None]:
    """Match a model's agentId to an expected id: exact, case-insensitive, or by number
    (``a7``, ``7`` and ``"07"`` all name ``a07``)."""
    exact = {agent_id.lower(): agent_id for agent_id in expected}
    by_number = {}
    for agent_id in expected:
        match = _AGENT_NUMBER_RE.match(agent_id.lower())
        if match:
            by_number[int(match.group(1))] = agent_id

    def resolve(value: Any) -> str | None:
        if isinstance(value, bool) or not isinstance(value, (str, int)):
            return None
        key = str(value).strip().lower()
        if key in exact:
            return exact[key]
        match = _AGENT_NUMBER_RE.match(key)
        return by_number.get(int(match.group(1))) if match else None

    return resolve


def _parse_item(
    agent_id: str,
    item: Mapping[str, Any],
    known: frozenset[str],
    authors: Mapping[str, str],
    notes: list[str],
    liked: Collection[str] = (),
) -> Decision:
    post = _parse_post(item.get("post"), known, notes)
    likes = _parse_likes(item.get("likes"), agent_id, known, authors, notes, liked)
    market = _parse_market(item.get("market"), notes)
    sentiment = _parse_sentiment(item.get("sentiment"), notes)
    reason = _parse_reason(item.get("reason"), notes)
    return Decision(agent_id, post, likes, market, sentiment, reason, list(dict.fromkeys(notes)))


# What a cheap model writes for "no post": a JSON null as a word, or the example it was shown.
NOT_A_POST = frozenset({"", "null", "none", "nil", "n/a", "na", "text", "post", "no post", "listed post id"})


def _parse_post(value: Any, known: frozenset[str], notes: list[str]) -> PostIntent | None:
    if value is None or value is False or value == "":
        return None
    if isinstance(value, str):
        text, reply_to = value, None
    elif isinstance(value, dict):
        text, reply_to = value.get("text"), value.get("replyTo", value.get("reply_to"))
    else:
        notes.append("post_invalid")
        return None
    if text is None or text == "":
        return None
    if not isinstance(text, str):
        notes.append("post_invalid")
        return None
    cleaned = clean_text(text)
    if not cleaned:
        notes.append("post_empty")
        return None
    if cleaned.strip("\"'`<>.… ").lower() in NOT_A_POST:
        notes.append("post_placeholder")
        return None
    if strip_urls(text) != text:
        notes.append("post_urls_stripped")
    clipped = clip(cleaned, MAX_POST_CHARS)
    if clipped != cleaned:
        notes.append("post_clipped")
    rules = find_violations(clipped)
    if rules:
        notes.extend(f"post_redacted:{rule}" for rule in rules)
        clipped = redact(clipped)
        if not clipped:
            notes.append("post_dropped")
            return None
    return PostIntent(clipped, _parse_reply_to(reply_to, known, notes))


def _parse_reply_to(value: Any, known: frozenset[str], notes: list[str]) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, str) and value.strip() in known:
        return value.strip()
    notes.append("reply_to_unknown")
    return None


def _parse_likes(
    value: Any,
    agent_id: str,
    known: frozenset[str],
    authors: Mapping[str, str],
    notes: list[str],
    liked: Collection[str] = (),
) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        notes.append("likes_invalid")
        return []
    likes: list[str] = []
    for item in value:
        post_id = item.strip() if isinstance(item, str) else None
        if post_id is None or post_id not in known:
            notes.append("like_unknown")
        elif authors.get(post_id) == agent_id:
            notes.append("like_own")
        elif post_id in liked:
            notes.append("like_repeat")
        elif post_id not in likes:
            likes.append(post_id)
    if len(likes) > MAX_LIKES:
        notes.append("likes_capped")
    return likes[:MAX_LIKES]


def _parse_market(value: Any, notes: list[str]) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, dict) and isinstance(value.get("action"), str):
        return dict(value)
    notes.append("market_invalid")
    return None


def _parse_sentiment(value: Any, notes: list[str]) -> float:
    if value is None:
        notes.append("sentiment_missing")
        return 0.0
    if isinstance(value, str):
        try:
            value = float(value)
        except ValueError:
            pass
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        notes.append("sentiment_invalid")
        return 0.0
    clamped = max(-1.0, min(1.0, float(value)))
    if clamped != value:
        notes.append("sentiment_clamped")
    return clamped


def _parse_reason(value: Any, notes: list[str]) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        notes.append("reason_invalid")
        return ""
    cleaned = clean_text(value)
    clipped = clip(cleaned, MAX_REASON_CHARS)
    if clipped != cleaned:
        notes.append("reason_clipped")
    return clipped


def _hold(agent_id: str, note: str) -> Decision:
    return Decision(agent_id, None, [], {"action": "hold"}, 0.0, "", [note])
