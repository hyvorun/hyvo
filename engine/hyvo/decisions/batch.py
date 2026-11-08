"""One batch call: build the prompt, call the agents model, parse; retry once on a bad answer."""

from __future__ import annotations

from collections.abc import Sequence

from hyvo.llm.types import LLMClient, LLMResponseError

from .parse import DecisionBatch, hold_decisions, parse_decisions
from .prompt import build_messages, max_tokens_for, visible_posts
from .types import AgentCard, RoundContext

ATTEMPTS = 2


def request_decisions(
    client: LLMClient, ctx: RoundContext, cards: Sequence[AgentCard], *, temperature: float
) -> DecisionBatch:
    """Decide the next move of every agent in ``cards`` with one ``agents`` call.

    An unusable answer (``LLMResponseError``: not JSON, truncated, no decision list) is retried
    once; a batch that succeeds on the retry carries the batch note ``retried``. After the
    second failure every agent holds with the note ``batch_failed``. ``BudgetExceeded`` and
    ``LLMRequestError`` propagate: stopping the run or retrying the provider is the caller's call.
    """
    messages = build_messages(ctx, cards)
    posts = visible_posts(ctx, cards)
    authors = {post_id: post.author_agent_id for post_id, post in posts.items()}
    agent_ids = [card.agent_id for card in cards]
    liked = {card.agent_id: frozenset(card.liked) for card in cards}
    for attempt in range(ATTEMPTS):
        try:
            result = client.complete(
                messages,
                temperature=temperature,
                max_tokens=max_tokens_for(len(cards)),
                json_mode=True,
                purpose="agents",
            )
            batch = parse_decisions(result.text, agent_ids, posts.keys(), authors, liked)
        except LLMResponseError:
            continue
        if attempt:
            batch.notes.append("retried")
        return batch
    failed = hold_decisions(agent_ids, "batch_failed")
    failed.notes.append("batch_failed")
    return failed
