"""A small keyword lexicon that scores the tone of event and post text in [-1, 1].

Used only by the offline policy, so injected events and feed posts move the rules model the way
they would move a crowd: rumors, dumps and exploits push down; listings, partnerships, burns and
passed audits push up. A negator up to two words before a keyword ("no rug", "denied the rumor")
flips it at half weight.
"""

from __future__ import annotations

import re

PHRASES: dict[str, float] = {
    "audit passed": 0.8, "passed audit": 0.8, "passed an audit": 0.8, "passed the audit": 0.8,
    "audit failed": -0.8, "failed audit": -0.8, "failed the audit": -0.8,
    "rug pull": -1.0, "red flag": -0.6, "red flags": -0.6, "liquidity locked": 0.5,
    "liquidity pulled": -0.9, "liquidity removed": -0.9, "sell-off": -0.5, "stopped out": -0.3,
    "took profit": 0.1, "all-time high": 0.4,
}  # fmt: skip

WORDS: dict[str, float] = {
    # negative: events
    "rumor": -0.4, "rumors": -0.4, "rumour": -0.4, "sold": -0.3, "dump": -0.6, "dumped": -0.6,
    "dumping": -0.6, "exploit": -0.9, "exploited": -0.9, "rug": -1.0, "rugged": -1.0, "hack": -0.9,
    "hacked": -0.9, "drained": -0.9, "scam": -0.8, "lawsuit": -0.6, "delay": -0.3, "delayed": -0.3,
    "unlock": -0.4, "abandoned": -0.8, "crash": -0.6, "crashed": -0.6, "selloff": -0.5,
    "investigation": -0.5, "exit": -0.3, "tax": -0.1,
    # negative: crowd chatter
    "panic": -0.4, "panicked": -0.4, "fear": -0.4, "bleed": -0.4, "bleeding": -0.4, "scared": -0.4,
    "cooked": -0.5, "red": -0.2, "doubt": -0.2, "doubts": -0.2, "unverified": -0.3,
    "concentrated": -0.3, "concentration": -0.3, "nervous": -0.2, "shaking": -0.3,
    # positive: events
    "listing": 0.6, "listed": 0.6, "partnership": 0.6, "partner": 0.4, "burn": 0.5, "burned": 0.5,
    "buyback": 0.6, "audited": 0.5, "launch": 0.2, "launched": 0.2, "integration": 0.4,
    "staking": 0.3, "milestone": 0.4, "upgrade": 0.3, "funding": 0.3,
    # positive: crowd chatter
    "bullish": 0.5, "momentum": 0.3, "early": 0.2, "strong": 0.3, "stronger": 0.3, "holding": 0.2,
    "conviction": 0.3, "green": 0.3, "climbing": 0.3, "progress": 0.3, "accumulating": 0.3,
    "added": 0.2, "growing": 0.3, "shipping": 0.3, "riding": 0.2,
}  # fmt: skip

NEGATORS = frozenset({"no", "not", "never", "without", "isn't", "wasn't", "denied", "denies", "fake"})

_WORD_RE = re.compile(r"[a-z]+(?:'[a-z]+)?")


def tone(text: str) -> float:
    """Tone of ``text`` in [-1, 1]; 0 when no keyword occurs."""
    lowered = text.lower()
    score = 0.0
    for phrase, weight in PHRASES.items():
        count = lowered.count(phrase)
        if count:
            score += weight * count
            lowered = lowered.replace(phrase, " ")
    words = _WORD_RE.findall(lowered)
    for index, word in enumerate(words):
        weight = WORDS.get(word)
        if weight is None:
            continue
        if any(previous in NEGATORS for previous in words[max(0, index - 2) : index]):
            weight = -0.5 * weight
        score += weight
    return max(-1.0, min(1.0, score))
