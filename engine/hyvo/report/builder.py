"""Report builder: deterministic stats, one structured LLM call (one retry), copy guard.

Pipeline (docs: MiroFish notes section 6): numbers, sentiment, turning-point candidates and price
drivers come from ``stats``; the model only writes prose over that data, and its JSON is
validated. Invalid output gets one retry, then the deterministic template. A refused call
(``BudgetExceeded``) gives the stats-only report. The disclaimer and ``sentimentByRound`` are always
set by code, and the copy guard runs on every report, fallbacks included.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from hyvo.llm.json_utils import parse_json_object
from hyvo.personas import ARCHETYPES
from hyvo.llm.types import (
    BudgetExceeded,
    ChatMessage,
    LLMClient,
    LLMRequestError,
    LLMResponseError,
)
from hyvo.report.guard import guard_report
from hyvo.report.prompt import (
    MAX_EVIDENCE_IDS,
    MAX_ITEM_CHARS,
    MAX_OBJECTIONS,
    MAX_PRICE_DRIVERS,
    MAX_SUMMARY_CHARS,
    MAX_WHY_CHARS,
    POST_MENTION,
    ROUND_MENTION,
    ReportPrompt,
    build_report_prompt,
    clip,
)
from hyvo.report.stats import compute_stats
from hyvo.report.template import deterministic_content
from hyvo.report.types import ReportInput
from hyvo.runfile.models import DISCLAIMER

REPORT_TEMPERATURE = 0.3
REPORT_MAX_TOKENS = 2000
_MISSING = object()


@dataclass(frozen=True)
class ReportResult:
    """``report`` is the run.json ``report`` object; ``llm_used`` says whether its prose came from
    the model; ``notes`` describe retries and fallbacks for the run's event log."""

    report: dict[str, Any]
    llm_used: bool
    notes: list[str]


def build_report(inp: ReportInput, client: LLMClient) -> ReportResult:
    """Write the report of a run. Calls ``client`` at most three times (purpose ``report``): the
    report, one retry, one copy-guard rewrite."""
    stats = compute_stats(inp)
    prompt = build_report_prompt(inp, stats)
    notes: list[str] = []
    if inp.rounds:
        content, llm_used = _model_content(prompt, client, notes)
    else:
        content, llm_used = deterministic_content(prompt.data, include_posts=False), False
        notes.append("no rounds were recorded: report written without the model")
    report = assemble_report(content, stats.sentiment_by_round)
    return ReportResult(report=guard_report(report, client), llm_used=llm_used, notes=notes)


def validate_output(text: str, prompt: ReportPrompt) -> tuple[dict[str, Any] | None, list[str]]:
    """Check model output against the report/v1 contract and the prompt's data.

    Returns ``(content, [])`` with normalized content, or ``(None, errors)``.
    """
    try:
        raw = parse_json_object(text)
    except LLMResponseError as error:
        return None, [str(error)]
    errors: list[str] = []
    content = {
        "summary": _text(raw.get("summary"), "summary", MAX_SUMMARY_CHARS, errors),
        "turningPoint": _turning_point(raw.get("turningPoint", _MISSING), prompt, errors),
        "objections": _objections(raw.get("objections"), prompt, errors),
        "priceDrivers": _price_drivers(raw.get("priceDrivers"), errors),
    }
    if not errors:
        errors += _mention_errors(content, prompt)
    return (None, errors) if errors else (content, [])


def assemble_report(content: Mapping[str, Any], sentiment_by_round: Sequence[float]) -> dict[str, Any]:
    """Turn report/v1 content into the run.json ``report`` object (evidence ids become citations)."""
    turning = content["turningPoint"]
    return {
        "summary": _plain_words(content["summary"]),
        "turningPoint": None
        if turning is None
        else {"round": turning["round"], "why": _plain_words(_cite(turning["why"], turning["evidencePostIds"]))},
        "sentimentByRound": list(sentiment_by_round),
        "objections": [_plain_words(_cite(o["text"], o["evidencePostIds"])) for o in content["objections"]],
        "priceDrivers": [_plain_words(driver) for driver in content["priceDrivers"]],
        "disclaimer": DISCLAIMER,
        "flags": [],
    }


def _model_content(prompt: ReportPrompt, client: LLMClient, notes: list[str]) -> tuple[dict[str, Any], bool]:
    messages = list(prompt.messages)
    for attempt in (1, 2):
        try:
            result = client.complete(
                messages,
                temperature=REPORT_TEMPERATURE,
                max_tokens=REPORT_MAX_TOKENS,
                json_mode=True,
                purpose="report",
            )
        except BudgetExceeded as refused:
            notes.append(f"budget exhausted ({refused.reason}): stats-only report")
            return deterministic_content(prompt.data, include_posts=False), False
        except LLMRequestError as error:
            notes.append(f"attempt {attempt} failed: LLMRequestError: {error}")
            messages = list(prompt.messages)  # nothing was answered: send the same request again
            continue
        except LLMResponseError as error:
            notes.append(f"attempt {attempt} rejected: {error}")
            messages = _retry_messages(prompt, None, [str(error)])
            continue
        content, errors = validate_output(result.text, prompt)
        if content is not None:
            return content, True
        notes.append(f"attempt {attempt} rejected: {'; '.join(errors)}")
        messages = _retry_messages(prompt, result.text, errors)
    notes.append("model output unusable after one retry: template report")
    return deterministic_content(prompt.data, include_posts=True), False


def _retry_messages(prompt: ReportPrompt, previous: str | None, errors: list[str]) -> list[ChatMessage]:
    reply = [] if previous is None else [ChatMessage(role="assistant", content=clip(previous, 6000))]
    request = (
        f"Your previous answer was not accepted: {clip('; '.join(errors), 800)} "
        "Reply again with one JSON object that follows the output contract, using only the listed "
        "candidate rounds and post ids."
    )
    return [*prompt.messages, *reply, ChatMessage(role="user", content=request)]


def _text(value: Any, name: str, limit: int, errors: list[str]) -> str:
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{name} must be a non-empty string")
        return ""
    if len(value.strip()) > limit:
        errors.append(f"{name} is longer than {limit} characters")
    return value.strip()


def _evidence(value: Any, name: str, prompt: ReportPrompt, errors: list[str]) -> list[str]:
    if value is _MISSING or value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        errors.append(f"{name} must be a list of post ids")
        return []
    ids = list(dict.fromkeys(item.strip() for item in value))
    if len(ids) > MAX_EVIDENCE_IDS:
        errors.append(f"{name} has more than {MAX_EVIDENCE_IDS} ids")
    unknown = [post_id for post_id in ids if post_id not in prompt.post_ids]
    if unknown:
        errors.append(f"{name} cites posts that were not listed: {', '.join(unknown[:5])}")
    return ids


def _turning_point(value: Any, prompt: ReportPrompt, errors: list[str]) -> dict[str, Any] | None:
    if value is _MISSING:
        errors.append("turningPoint is required (an object, or null)")
        return None
    if value is None:
        return None
    if not isinstance(value, dict):
        errors.append("turningPoint must be an object or null")
        return None
    round_n = value.get("round")
    if isinstance(round_n, bool) or not isinstance(round_n, int) or round_n not in prompt.candidate_rounds:
        allowed = ", ".join(str(n) for n in sorted(prompt.candidate_rounds)) or "none (use null)"
        errors.append(f"turningPoint.round must be a candidate round ({allowed})")
    return {
        "round": round_n,
        "why": _text(value.get("why"), "turningPoint.why", MAX_WHY_CHARS, errors),
        "evidencePostIds": _evidence(
            value.get("evidencePostIds", _MISSING), "turningPoint.evidencePostIds", prompt, errors
        ),
    }


def _objections(value: Any, prompt: ReportPrompt, errors: list[str]) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        errors.append("objections must be a list")
        return []
    if len(value) > MAX_OBJECTIONS:
        errors.append(f"objections has more than {MAX_OBJECTIONS} items")
    objections = []
    for index, item in enumerate(value):
        name = f"objections[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{name} must be an object with text and evidencePostIds")
            continue
        objections.append(
            {
                "text": _text(item.get("text"), f"{name}.text", MAX_ITEM_CHARS, errors),
                "evidencePostIds": _evidence(
                    item.get("evidencePostIds", _MISSING), f"{name}.evidencePostIds", prompt, errors
                ),
            }
        )
    return objections


def _price_drivers(value: Any, errors: list[str]) -> list[str]:
    if not isinstance(value, list):
        errors.append("priceDrivers must be a list")
        return []
    if len(value) > MAX_PRICE_DRIVERS:
        errors.append(f"priceDrivers has more than {MAX_PRICE_DRIVERS} items")
    return [_text(item, f"priceDrivers[{i}]", MAX_ITEM_CHARS, errors) for i, item in enumerate(value)]


def _mention_errors(content: Mapping[str, Any], prompt: ReportPrompt) -> list[str]:
    """Round numbers and post ids written in the prose must exist in the data: as a round of the
    run or a listed post, or inside a quoted data text (a post may itself say "round 20")."""
    texts = [content["summary"], *content["priceDrivers"], *(o["text"] for o in content["objections"])]
    if content["turningPoint"] is not None:
        texts.append(content["turningPoint"]["why"])
    prose, quoted = "\n".join(texts), "\n".join(prompt.quoted_texts)
    known_rounds = set(range(1, prompt.round_count + 1)) | {int(n) for n in ROUND_MENTION.findall(quoted)}
    known_posts = prompt.post_ids | set(POST_MENTION.findall(quoted))
    rounds = sorted({int(n) for n in ROUND_MENTION.findall(prose)} - known_rounds)
    posts = sorted(set(POST_MENTION.findall(prose)) - known_posts)
    errors = []
    if rounds:
        errors.append(f"the text mentions rounds that do not exist: {', '.join(map(str, rounds[:5]))}")
    if posts:
        errors.append(f"the text mentions posts that were not listed: {', '.join(posts[:5])}")
    return errors


def _plain_words(text: str) -> str:
    """A model copies persona ids from its data: readers get words ("panic seller agents")."""
    for persona in ARCHETYPES:
        text = text.replace(persona, persona.replace("_", " "))
    return text


def _cite(text: str, post_ids: Sequence[str]) -> str:
    """Add ``(p1, c2)`` for evidence ids the text does not mention yet, before a final period."""
    missing = [post_id for post_id in post_ids if not re.search(rf"\b{re.escape(post_id)}\b", text)]
    if not missing:
        return text
    citation = f"({', '.join(missing)})"
    if text.endswith(".") and not text.endswith(".."):
        return f"{text[:-1]} {citation}."
    return f"{text} {citation}"
