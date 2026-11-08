"""Protocol tags: one ``HYVO_PROTOCOL: <name>/v<k>`` line in a system message names the prompt
contract (input layout and expected output shape). Real models ignore the line; the offline
client uses it to pick the deterministic responder for that contract. Bump ``k`` whenever the
contract changes so a stale responder can never answer a new prompt shape.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from .types import ChatMessage, LLMResponseError

_TAG_RE = re.compile(r"^HYVO_PROTOCOL:[ \t]*(\S+)[ \t]*$", re.MULTILINE)
_ID_RE = re.compile(r"^([a-z][a-z0-9_]*)/v([1-9][0-9]*)$")


def protocol_id(name: str, version: int) -> str:
    """``("agent_decisions", 1)`` -> ``"agent_decisions/v1"``."""
    if isinstance(version, bool) or not isinstance(version, int):
        raise TypeError("protocol version must be an integer")
    return check_protocol_id(f"{name}/v{version}")


def protocol_tag(name: str, version: int) -> str:
    """The line to put in the system message, e.g. ``HYVO_PROTOCOL: agent_decisions/v1``."""
    return f"HYVO_PROTOCOL: {protocol_id(name, version)}"


def check_protocol_id(pid: str) -> str:
    """Validate a protocol id (``<name>/v<k>``, name ``[a-z][a-z0-9_]*``) and return it."""
    if not isinstance(pid, str) or not _ID_RE.match(pid):
        raise ValueError(f"invalid protocol id {pid!r}; expected '<name>/v<k>', e.g. 'report/v1'")
    return pid


def find_protocol(messages: Sequence[ChatMessage]) -> str | None:
    """Return the protocol id tagged in the system messages, or None if there is no tag.

    Tags in user or assistant messages are ignored, so quoted user data cannot select a
    responder. Two different tags, or a malformed one, raise ``LLMResponseError``.
    """
    found = {
        match.group(1)
        for message in messages
        if message.role == "system"
        for match in _TAG_RE.finditer(message.content)
    }
    if not found:
        return None
    if len(found) > 1:
        raise LLMResponseError("system messages carry more than one HYVO_PROTOCOL tag")
    (pid,) = found
    if not _ID_RE.match(pid):
        raise LLMResponseError("malformed HYVO_PROTOCOL tag; expected '<name>/v<k>'")
    return pid
