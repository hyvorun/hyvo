"""A pool's past, read straight from the chain: its reserves and the time at any block (docs/OPEN_ITEMS.md item 25).

Nothing here takes a third party's word for what happened: anyone can repeat these calls.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

GET_RESERVES = "0x0902f1ac"
TOKEN0 = "0x0dfe1681"
TOKEN1 = "0xd21220a7"
SYMBOL = "0x95d89b41"
NAME = "0x06fdde03"
DECIMALS = "0x313ce567"
TIMEOUT_S = 30.0
RETRY_WAITS_S = (2.0, 5.0, 10.0)
# A node without the old state answers these. Another moment often reaches one that has it (docs/OPEN_ITEMS.md item 25), and it says nothing about the contract.
NO_STATE = ("unknown state", "missing trie node", "state not available", "header not found")

Post = Callable[[str, bytes], bytes]


class ChainUnreachable(RuntimeError):
    """The RPC did not answer. It may answer later, so a job can be tried again."""


class CallReverted(ValueError):
    """The contract refused the call, or the node has no state for that block."""


def http_post(url: str, body: bytes) -> bytes:
    request = urllib.request.Request(url, body, {"Content-Type": "application/json", "User-Agent": "hyvo-engine"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:  # noqa: S310 - the URL comes from settings
            return response.read()
    except urllib.error.HTTPError as error:
        # dRPC answers some JSON-RPC errors with a 4xx and a JSON body: those belong to the caller.
        if error.code < 500 and error.code != 429:
            return error.read()
        raise


class Chain:
    def __init__(self, url: str, post: Post = http_post, sleep: Callable[[float], None] = time.sleep) -> None:
        self.url = url
        self.post = post
        self.sleep = sleep

    def _rpc(self, method: str, params: list[Any]) -> Any:
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        problem = "no answer"
        for wait in (0.0, *RETRY_WAITS_S):
            if wait:
                self.sleep(wait)
            try:
                answer = json.loads(self.post(self.url, body))
            except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
                problem = type(error).__name__
                continue
            if not isinstance(answer, dict):
                problem = "an answer that is not an object"
                continue
            failure = answer.get("error")
            if failure is None:
                return answer.get("result")
            message = str(failure.get("message") if isinstance(failure, dict) else failure)[:200]
            if not any(words in message.lower() for words in NO_STATE):
                raise CallReverted(message)
            problem = message
        raise ChainUnreachable(f"the RPC did not answer {method}: {problem}")

    def head(self) -> int:
        return int(self._rpc("eth_blockNumber", []), 16)

    def time_of(self, block: int) -> int:
        found = self._rpc("eth_getBlockByNumber", [hex(block), False])
        if not isinstance(found, dict):
            raise CallReverted(f"the RPC has no block {block}")
        return int(found["timestamp"], 16)

    def call(self, to: str, data: str, block: int | None = None) -> str:
        result = self._rpc("eth_call", [{"to": to, "data": data}, hex(block) if block is not None else "latest"])
        return result if isinstance(result, str) else "0x"

    def reserves_at(self, pool: str, block: int) -> tuple[int, int]:
        """A pool's two reserves at a block, as ``getReserves()`` gives them."""
        words = _words(self.call(pool, GET_RESERVES, block))
        if len(words) < 2:
            raise CallReverted("it does not answer getReserves() there, so it may not have existed yet")
        return words[0], words[1]

    def address_or_none(self, contract: str, selector: str, block: int) -> str | None:
        try:
            words = _words(self.call(contract, selector, block))
        except CallReverted:
            return None
        return f"0x{words[0]:040x}" if words and words[0] else None

    def text_or_none(self, contract: str, selector: str, block: int) -> str | None:
        try:
            return _text(self.call(contract, selector, block))
        except CallReverted:
            return None

    def number_or_none(self, contract: str, selector: str, block: int) -> int | None:
        try:
            words = _words(self.call(contract, selector, block))
        except CallReverted:
            return None
        return words[0] if words else None


def _words(data: str) -> list[int]:
    raw = data[2:] if data.startswith("0x") else data
    return [int(raw[start : start + 64], 16) for start in range(0, len(raw) - len(raw) % 64, 64)]


def _text(data: str) -> str | None:
    """An ABI-encoded string, or the bytes32 some old tokens answer with."""
    raw = bytes.fromhex(data[2:] if data.startswith("0x") else data)
    if len(raw) >= 64:
        length = int.from_bytes(raw[32:64], "big")
        if length <= len(raw) - 64:
            return raw[64 : 64 + length].decode("utf-8", "replace").strip() or None
    if len(raw) == 32:
        return raw.rstrip(b"\0").decode("utf-8", "replace").strip() or None
    return None
