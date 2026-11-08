"""A last read of what the crowd wrote, before a run is hashed (protocol ``post_review/v1``).

The copy guard (``hyvo.report.guard``) is a table of patterns, and real models keep finding new words for
the same thing: "the next leg up", "we'll see the returns", "GLINT is a winner". A published run's hash goes
on-chain for good, and the daily run has nobody to read it first. So the report model reads every post once.
A post it flags stays in the run as ``REMOVED_TEXT``, which keeps replies attached to their parents, and
``report.flags`` records how many went. If the review could not finish, the flags say that too, and
``hyvo daily`` will not publish such a run.
"""

from __future__ import annotations

import copy
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from hyvo.llm.json_utils import parse_json_object
from hyvo.llm.protocol import protocol_id, protocol_tag
from hyvo.llm.types import BudgetExceeded, ChatMessage, LLMClient, LLMRequestError, LLMResponseError
from hyvo.report.guard import REMOVED_TEXT, find_violations
from hyvo.scenarios.sanitize import DATA_RULE, quote_as_data

REVIEW_PROTOCOL = protocol_id("post_review", 1)
MAX_POSTS_PER_CALL = 120
MAX_TOKENS_PER_CALL = 600
FLAG_INCOMPLETE = "post_review_incomplete"

SYSTEM_PROMPT = f"""{protocol_tag("post_review", 1)}
You check lines for a simulation in which synthetic trader agents post on a simulated social feed about a token, \
which can carry the name of a real one. The lines are published as a synthetic crowd reaction, not as advice.
Agents may have opinions, fears, doubts and plans of their own: "I'm out", "the tax is a red flag", "I'm adding \
0.05 ETH", "this looks like a pump and dump to me", "I'm hoping it recovers". Those are fine.
Flag a post only if it does one of these:
- states or implies as fact what the price or the token will do, or promises gains or returns ("the next leg up", \
"we'll see the returns", "has a bright future", "the dip is just temporary");
- gives the token a verdict: a winner, a good or bad token, the real deal, a great opportunity, strong fundamentals, and the like;
- tells readers to buy, sell, get in, get out, cash out or take profit, including as "time to cash out";
- states as fact that a named project or person committed a crime or a fraud;
- uses vulgar or hateful words;
- names a real person.
{DATA_RULE}
Reply with this JSON only, using ids from the list; an empty list is a good answer:
{{"flagged":["<post id>"]}}"""


@dataclass(frozen=True)
class PostReview:
    flagged: frozenset[str]
    complete: bool

    def flags(self) -> list[str]:
        """What goes in ``report.flags``."""
        return [
            *([f"posts_removed:{len(self.flagged)}"] if self.flagged else []),
            *([] if self.complete else [FLAG_INCOMPLETE]),
        ]


def scrub_run(run: Mapping[str, Any], remove: Iterable[str] = ()) -> tuple[dict[str, Any], list[str]]:
    """A copy of a run that has not been published, without the posts that break the copy rules and without ``remove``: what a person
    reading it took out. Their text becomes ``REMOVED_TEXT``, so replies keep their parents, and ``report.flags`` counts them. The
    hash is left to the caller, because the content has changed. Returns the run and the ids taken out."""
    asked = set(remove)
    scrubbed = copy.deepcopy(dict(run))
    known: set[str] = set()
    removed: list[str] = []
    for round_ in scrubbed["rounds"]:
        for post in round_["posts"]:
            known.add(post["id"])
            if post["text"] != REMOVED_TEXT and (post["id"] in asked or find_violations(post["text"])):
                post["text"] = REMOVED_TEXT
                removed.append(post["id"])
    unknown = asked - known
    if unknown:
        raise ValueError(f"this run has no post {sorted(unknown)[0]}")
    if removed:
        report = scrubbed["report"]
        flags = list(report["flags"])
        before = next((flag for flag in flags if flag.startswith("posts_removed:")), None)
        count = int(before.partition(":")[2]) if before else 0
        report["flags"] = [flag for flag in flags if flag != before] + [f"posts_removed:{count + len(removed)}"]
    return scrubbed, removed


def review_posts(posts: Sequence[tuple[str, str]], client: LLMClient) -> PostReview:
    """Read ``(id, text)`` pairs in batches. A batch that fails only makes the review incomplete."""
    flagged: set[str] = set()
    complete = True
    for start in range(0, len(posts), MAX_POSTS_PER_CALL):
        batch = posts[start : start + MAX_POSTS_PER_CALL]
        lines = "\n".join(f"{post_id} | {text}" for post_id, text in batch if text != REMOVED_TEXT)
        if not lines:
            continue
        try:
            result = client.complete(
                [
                    ChatMessage(role="system", content=SYSTEM_PROMPT),
                    ChatMessage(role="user", content=quote_as_data("posts", lines)),
                ],
                temperature=0.0,
                max_tokens=MAX_TOKENS_PER_CALL,
                json_mode=True,
                purpose="report",
            )
            reply = parse_json_object(result.text).get("flagged")
        except (BudgetExceeded, LLMRequestError, LLMResponseError):
            complete = False
            continue
        if not isinstance(reply, list):
            complete = False
            continue
        known = {post_id for post_id, _ in batch}
        flagged.update(item for item in reply if isinstance(item, str) and item in known)
    return PostReview(frozenset(flagged), complete)
