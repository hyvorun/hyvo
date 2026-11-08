"""Deterministic offline responders for the report prompts (no network, zero cost).

``report/v1`` answers with the template report written from the prompt's DATA block, so an offline
run gets a complete, valid report. ``report_rewrite/v1`` answers by dropping every sentence that
breaks a copy rule; a field with nothing clean left comes back empty, which the guard treats as
"not rewritten" and redacts itself. Neither uses the rng, so the answer depends on the messages.
"""

from __future__ import annotations

import json
import random
from collections.abc import Sequence

from hyvo.llm.offline import register_responder
from hyvo.llm.types import ChatMessage, LLMResponseError
from hyvo.report.guard import REWRITE_PROTOCOL, redact
from hyvo.report.prompt import REPORT_PROTOCOL, extract_data
from hyvo.report.review import REVIEW_PROTOCOL
from hyvo.report.template import deterministic_content


def report_responder(messages: Sequence[ChatMessage], rng: random.Random) -> str:
    data = extract_data(messages)
    return json.dumps(deterministic_content(data, include_posts=True), ensure_ascii=False)


def rewrite_responder(messages: Sequence[ChatMessage], rng: random.Random) -> str:
    fields = extract_data(messages).get("fields")
    if not isinstance(fields, dict):
        raise LLMResponseError("the rewrite DATA block has no fields object")
    rewritten = {key: redact(str(text)) for key, text in fields.items()}
    return json.dumps({"fields": rewritten}, ensure_ascii=False)


def review_responder(messages: Sequence[ChatMessage], rng: random.Random) -> str:
    return json.dumps({"flagged": []})


register_responder(REVIEW_PROTOCOL, review_responder)
register_responder(REPORT_PROTOCOL, report_responder)
register_responder(REWRITE_PROTOCOL, rewrite_responder)
