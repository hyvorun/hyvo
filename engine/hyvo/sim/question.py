"""A scenario question (SPEC §11.2): at the end of a run, each agent says what it expects, and the crowd's lean is hashed with the
run, before the outcome is known. After the date, the outcome goes on-chain and the calibration page counts hits and misses.

An agent's answer is a synthetic reaction like its posts, not a forecast by Hyvo. A batch that cannot be answered leaves its agents
``unsure`` and flags the report, so the lean never looks firmer than it was.
"""

from __future__ import annotations

import json
import random
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from hyvo.llm.json_utils import parse_json_object
from hyvo.llm.offline import register_responder
from hyvo.llm.protocol import protocol_id, protocol_tag
from hyvo.llm.types import (
    BudgetExceeded,
    ChatMessage,
    LLMClient,
    LLMRequestError,
    LLMResponseError,
)
from hyvo.scenarios.sanitize import DATA_RULE, quote_as_data, sanitize_line

QUESTION_PROTOCOL = protocol_id("crowd_question", 1)
AGENTS_PER_CALL = 25
MAX_TOKENS_PER_CALL = 500
MAX_QUESTION_CHARS = 300
MAX_SAID_CHARS = 120
FLAG_INCOMPLETE = "question_incomplete"
ANSWERS = ("yes", "no", "unsure")
_RESOLVES_AT = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")

SYSTEM_PROMPT = f"""{protocol_tag("crowd_question", 1)}
You play synthetic trader agents at the end of a simulation. Each line is one agent: its character, what it holds now and the last \
thing it said. For each agent, answer the question the way that agent would, from what it saw in the simulation: yes, no or unsure.
Agents disagree. Give them the same answer only if their lines really point the same way.
{DATA_RULE}
Reply with this JSON only, one entry per agent id: {{"answers":{{"<agent id>":"yes"}}}}"""


class QuestionError(ValueError):
    """A question cannot be asked as written."""


@dataclass(frozen=True)
class CrowdQuestionSpec:
    """What to ask. ``resolves_at`` is a UTC timestamp, as in run.json."""

    text: str
    resolves_at: str

    def __post_init__(self) -> None:
        clean = sanitize_line(self.text, MAX_QUESTION_CHARS)
        if not clean:
            raise QuestionError("a question must have text")
        object.__setattr__(self, "text", clean)
        if not _RESOLVES_AT.match(self.resolves_at):
            raise QuestionError("a question's date looks like 2026-12-01T00:00:00Z")


@dataclass(frozen=True)
class QuestionCard:
    agent_id: str
    persona: str
    eth: str
    tokens: str
    said: str = ""

    def line(self) -> str:
        said = f' | said: "{self.said[:MAX_SAID_CHARS]}"' if self.said else ""
        return f"{self.agent_id} | {self.persona} | holds {self.eth} ETH, {self.tokens} tokens{said}"


@dataclass(frozen=True)
class CrowdAnswers:
    section: dict[str, object]  # run.json ``question``
    complete: bool


def ask_crowd(question: CrowdQuestionSpec, cards: Sequence[QuestionCard], story: str, client: LLMClient, *, temperature: float) -> CrowdAnswers:
    """Every agent's answer, in batches. Whatever could not be answered stays ``unsure``."""
    answers = dict.fromkeys((card.agent_id for card in cards), "unsure")
    complete = True
    for start in range(0, len(cards), AGENTS_PER_CALL):
        batch = cards[start : start + AGENTS_PER_CALL]
        user = "\n".join(
            (
                quote_as_data("run", story),
                quote_as_data("question", question.text),
                quote_as_data("agents", "\n".join(card.line() for card in batch)),
            )
        )
        try:
            result = client.complete(
                [ChatMessage(role="system", content=SYSTEM_PROMPT), ChatMessage(role="user", content=user)],
                temperature=temperature,
                max_tokens=MAX_TOKENS_PER_CALL,
                json_mode=True,
                purpose="agents",
            )
            reply = parse_json_object(result.text).get("answers")
        except (BudgetExceeded, LLMRequestError, LLMResponseError):
            complete = False
            continue
        if not isinstance(reply, Mapping):
            complete = False
            continue
        known = {card.agent_id for card in batch}
        for agent_id, answer in reply.items():
            if agent_id in known and isinstance(answer, str) and answer.strip().lower() in ANSWERS:
                answers[agent_id] = answer.strip().lower()
        if any(card.agent_id not in reply for card in batch):
            complete = False
    return CrowdAnswers(_section(question, answers), complete)


def _section(question: CrowdQuestionSpec, answers: Mapping[str, str]) -> dict[str, object]:
    counts = {answer: sum(1 for given in answers.values() if given == answer) for answer in ANSWERS}
    lean = "yes" if counts["yes"] > counts["no"] else "no" if counts["no"] > counts["yes"] else "split"
    return {
        "text": question.text,
        "resolvesAt": question.resolves_at,
        "answers": counts,
        "byAgent": dict(answers),
        "expectation": lean,
    }


_PERSONA_LEAN = {
    "sniper": 0.6,
    "holder": 0.75,
    "panic_seller": 0.25,
    "skeptic": 0.2,
    "swing_trader": 0.5,
    "whale": 0.55,
    "kol_follower": 0.7,
    "market_maker_bot": 0.5,
    "stock_token_holder": 0.3,
    "newcomer": 0.6,
}


def question_responder(messages: Sequence[ChatMessage], rng: random.Random) -> str:
    """The offline rules model: an agent's character decides most of it."""
    block = messages[1].content.partition('<data label="agents"')[2]
    answers: dict[str, str] = {}
    for line in block.splitlines():
        parts = [part.strip() for part in line.split(" | ")]
        if len(parts) >= 3 and re.fullmatch(r"a[0-9]{2,4}", parts[0]):
            roll = rng.random()
            lean = _PERSONA_LEAN.get(parts[1], 0.5)
            answers[parts[0]] = "unsure" if roll > 0.9 else "yes" if roll < lean * 0.9 else "no"
    return json.dumps({"answers": answers})


register_responder(QUESTION_PROTOCOL, question_responder)
