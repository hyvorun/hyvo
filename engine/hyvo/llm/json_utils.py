"""Strict JSON-object parsing of model output.

Adapted from MiroFish backend/app/utils/llm_client.py (AGPL-3.0): ``_clean_chat_text``,
``_contains_additional_json_container`` and ``LLMClient._parse_json_response``. Hyvo additions:
whitespace after a BOM is tolerated and non-finite numbers (``NaN``, ``Infinity``) are rejected
because run.json is canonicalized with RFC 8785, which cannot represent them.

Error messages never echo model output.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .types import LLMResponseError

_THINK_RE = re.compile(r"<think>[\s\S]*?</think>")
_FENCE_OPEN_RE = re.compile(r"^```(?:json)?\s*\n?", re.IGNORECASE)
_FENCE_CLOSE_RE = re.compile(r"\n?```\s*$")

# No Hyvo answer needs deep nesting. Bounding the depth before decoding stops a hostile answer from
# exhausting the stack: web3 (via py_ecc) raises the recursion limit to 100,000, so the decoder can
# recurse until the process dies instead of raising RecursionError.
MAX_JSON_DEPTH = 64


class _NonFiniteNumber(ValueError):
    pass


def _reject_constant(name: str) -> Any:
    raise _NonFiniteNumber(name)


_STRICT_DECODER = json.JSONDecoder(parse_constant=_reject_constant)


def clean_chat_text(content: str) -> str:
    """Remove closed ``<think>`` blocks, a BOM and an outer Markdown code fence."""
    cleaned = _THINK_RE.sub("", content).strip()
    cleaned = cleaned.lstrip("\N{BYTE ORDER MARK}").strip()
    cleaned = _FENCE_OPEN_RE.sub("", cleaned)
    cleaned = _FENCE_CLOSE_RE.sub("", cleaned)
    return cleaned.strip()


def parse_json_object(text: str | None) -> dict[str, Any]:
    """Parse model output that must be exactly one JSON object.

    Strict ``json.loads`` first; failing that, the first object decoded from the start is
    accepted when only prose follows it. A second JSON object or array anywhere after it is
    rejected, as is a top-level value that is not an object.
    """
    content = clean_chat_text(text or "")
    if not content:
        raise LLMResponseError("LLM returned empty JSON content")
    if json_depth(content) > MAX_JSON_DEPTH:
        raise LLMResponseError(f"LLM JSON is nested deeper than {MAX_JSON_DEPTH} levels")
    try:
        try:
            value = _STRICT_DECODER.decode(content)
        except json.JSONDecodeError as strict_error:
            try:
                value, end = _STRICT_DECODER.raw_decode(content)
            except json.JSONDecodeError:
                raise LLMResponseError(
                    "LLM returned invalid JSON "
                    f"(line {strict_error.lineno}, column {strict_error.colno})"
                ) from None
            if _contains_additional_json_container(content[end:].strip()):
                raise LLMResponseError("LLM returned multiple JSON values") from None
    except LLMResponseError:
        raise
    except _NonFiniteNumber:
        raise LLMResponseError("LLM JSON contains a non-finite number") from None
    except (ValueError, RecursionError):
        # e.g. an integer longer than Python's int-to-str digit limit
        raise LLMResponseError("LLM returned JSON Hyvo cannot read") from None
    if not isinstance(value, dict):
        raise LLMResponseError("LLM JSON response must be a top-level JSON object")
    return value


def json_depth(text: str) -> int:
    """Deepest bracket nesting in ``text``, ignoring brackets inside JSON strings."""
    depth = deepest = 0
    in_string = escaped = False
    for char in text:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char in "[{":
            depth += 1
            deepest = max(deepest, depth)
        elif char in "]}" and depth:
            depth -= 1
    return deepest


def _contains_additional_json_container(content: str) -> bool:
    """Return True when trailing text embeds another JSON object or array."""
    decoder = json.JSONDecoder()
    for match in re.finditer(r"[\[{]", content):
        try:
            value, _ = decoder.raw_decode(content[match.start() :])
        except json.JSONDecodeError:
            continue
        if isinstance(value, (dict, list)):
            return True
    return False
