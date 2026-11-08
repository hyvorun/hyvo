"""What the crowd has already said. Cheap models copy the posts they are shown, and give two agents of a
batch the same words, or the same words around another @handle. A feed of those reads like what it is,
so a line is said once in a run, by anyone."""

from __future__ import annotations

import re
from collections import deque
from collections.abc import Mapping

_MENTION = re.compile(r"@\w+")
_AGENT_ID_MENTION = re.compile(r"@(a\d+)\b")
_WORD = re.compile(r"[^\W_]+(?:['’][^\W_]+)*")

# Below this many different words, two lines can share most of them by chance ("I'm out!").
MIN_WORDS_TO_COMPARE = 5
# The share of their words two lines have in common (Jaccard) from which they count as one line.
NEAR_DUPLICATE = 0.75
# A big crowd posts thousands of lines; a copy is nearly always of something recent.
COMPARE_WITH_LAST = 400


class SaidLines:
    """Remembers the lines of one run. ``exact_only`` is for the offline model, which writes from
    templates on purpose: only the very same line counts as said."""

    def __init__(self, *, exact_only: bool = False) -> None:
        self._exact_only = exact_only
        self._exact: set[str] = set()
        self._recent: deque[frozenset[str]] = deque(maxlen=COMPARE_WITH_LAST)

    def repeats(self, text: str) -> bool:
        """True when this line, or nearly this line, was said before; otherwise remember it. Case,
        punctuation and @handles do not make a line new."""
        if self._exact_only:
            line = " ".join(text.lower().split())
            if line in self._exact:
                return True
            self._exact.add(line)
            return False
        words = _WORD.findall(_MENTION.sub(" ", text).lower())
        key = " ".join(words) or " ".join(text.lower().split())
        if key in self._exact:
            return True
        distinct = frozenset(words)
        if len(distinct) >= MIN_WORDS_TO_COMPARE and any(_overlap(distinct, line) >= NEAR_DUPLICATE for line in self._recent):
            return True
        self._exact.add(key)
        if len(distinct) >= MIN_WORDS_TO_COMPARE:
            self._recent.append(distinct)
        return False


def named_mentions(text: str, handles: Mapping[str, str]) -> str:
    """A model writes "@a13" from the ids it is shown; readers of the feed know agents by their handles."""
    return _AGENT_ID_MENTION.sub(lambda match: handles.get(match[1], match[0]), text)


def _overlap(a: frozenset[str], b: frozenset[str]) -> float:
    return len(a & b) / len(a | b)
