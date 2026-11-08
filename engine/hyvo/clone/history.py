"""One wallet's trades, read from Blockscout's keyed API (docs/OPEN_ITEMS.md item 24).

Only a wallet that proved itself is ever read: the API puts the signed-in address in the job, and nothing here takes an address from
anywhere else. Calls stay under the free tier's 5 a second, and the history stops at ``MAX_PAGES`` pages, newest first.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any

DEFAULT_API = "https://api.blockscout.com/4663/api/v2"
MAX_PAGES = 20
MAX_TOKEN_AGES = 30
PAUSE_S = 0.25
RATE_LIMIT_WAIT_S = 20.0
TIMEOUT_S = 30.0
MAX_BYTES = 8 * 1024 * 1024
# What a position is priced in rather than a position itself. Symbols, because this only shapes a wallet's own statistics.
QUOTE_SYMBOLS = frozenset({"WETH", "ETH", "USDG", "USDC", "USDT"})
# Methods that move tokens without trading them.
NOT_A_TRADE = frozenset({"transfer", "transferfrom", "approve", "permit"})
_WEI = Decimal(10) ** 18


class HistoryError(RuntimeError):
    """The wallet's history could not be read."""


@dataclass(frozen=True)
class Trade:
    """One buy or sell of one token by the wallet."""

    tx_hash: str
    at: float
    token: str
    side: str  # "buy" or "sell"
    tokens: Decimal
    eth: Decimal | None  # what it paid, when the transaction shows it in ETH


Fetch = Callable[[str], bytes]


def http_fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "hyvo-engine"})
    with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:  # noqa: S310 - the URL is built from settings
        return response.read(MAX_BYTES + 1)


class BlockscoutSource:
    """The REST API: ``/addresses/<address>/transactions``, ``/token-transfers`` and each token's creation."""

    def __init__(self, api_key: str, api_url: str = DEFAULT_API, fetch: Fetch = http_fetch, sleep: Callable[[float], None] = time.sleep) -> None:
        self.api_key = api_key
        self.api_url = api_url.rstrip("/")
        self.fetch = fetch
        self.sleep = sleep

    def _get(self, path: str, params: Mapping[str, Any] | None = None) -> Any:
        query = urllib.parse.urlencode({**{key: value for key, value in (params or {}).items() if value is not None}, "apikey": self.api_key})
        url = f"{self.api_url}{path}?{query}"
        for attempt in (1, 2):
            try:
                data = self.fetch(url)
                break
            except urllib.error.HTTPError as error:
                if error.code == 429 and attempt == 1:
                    self.sleep(RATE_LIMIT_WAIT_S)
                    continue
                # The key is in the URL, so the error names only the status and the path.
                raise HistoryError(f"the explorer answered {error.code} for {path}") from None
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                raise HistoryError(f"the explorer could not be reached for {path}: {type(error).__name__}") from None
        self.sleep(PAUSE_S)
        if len(data) > MAX_BYTES:
            raise HistoryError(f"the explorer's answer for {path} is too large")
        try:
            return json.loads(data)
        except ValueError:
            raise HistoryError(f"the explorer's answer for {path} is not JSON") from None

    def _pages(self, path: str, params: Mapping[str, Any] | None = None) -> list[Mapping[str, Any]]:
        items: list[Mapping[str, Any]] = []
        extra: Mapping[str, Any] = {}
        for _ in range(MAX_PAGES):
            page = self._get(path, {**(params or {}), **extra})
            if not isinstance(page, Mapping):
                raise HistoryError(f"the explorer's answer for {path} is not an object")
            items.extend(item for item in page.get("items") or [] if isinstance(item, Mapping))
            following = page.get("next_page_params")
            if not isinstance(following, Mapping) or not following:
                break
            extra = following
        return items

    def trades(self, wallet: str) -> list[Trade]:
        """The wallet's trades, oldest first."""
        address = urllib.parse.quote(wallet)
        return trades_from(wallet, self._pages(f"/addresses/{address}/transactions"), self._pages(f"/addresses/{address}/token-transfers", {"type": "ERC-20"}))

    def token_created_at(self, token: str) -> float | None:
        """When a token's contract was created, or None when the explorer does not say."""
        try:
            contract = self._get(f"/addresses/{urllib.parse.quote(token)}")
            creation = contract.get("creation_transaction_hash") if isinstance(contract, Mapping) else None
            if not creation:
                return None
            transaction = self._get(f"/transactions/{urllib.parse.quote(str(creation))}")
        except HistoryError:
            return None
        return _timestamp(transaction.get("timestamp")) if isinstance(transaction, Mapping) else None


def _timestamp(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _hash_of(party: Any) -> str:
    return str(party.get("hash") or "").lower() if isinstance(party, Mapping) else ""


def _amount(total: Any) -> Decimal | None:
    if not isinstance(total, Mapping):
        return None
    try:
        return Decimal(str(total["value"])) / (Decimal(10) ** int(total.get("decimals") or 18))
    except (KeyError, InvalidOperation, ValueError, TypeError):
        return None


def trades_from(wallet: str, transactions: Sequence[Mapping[str, Any]], transfers: Sequence[Mapping[str, Any]]) -> list[Trade]:
    """Trades from what the explorer lists. A trade is a transaction the wallet sent itself, not a plain transfer, that moved a token other than
    a quote token in or out of the wallet. So an airdrop is not a buy, and sending tokens to another wallet is not a sell."""
    me = wallet.lower()
    sent: dict[str, Mapping[str, Any]] = {}
    for transaction in transactions:
        method = str(transaction.get("method") or "").lower()
        succeeded = transaction.get("status") in ("ok", None) and transaction.get("result") in ("success", None)
        if _hash_of(transaction.get("from")) == me and succeeded and method not in NOT_A_TRADE:
            sent[str(transaction.get("hash") or "").lower()] = transaction
    moved: dict[tuple[str, str], Decimal] = {}
    weth_out: dict[str, Decimal] = {}
    for transfer in transfers:
        tx_hash = str(transfer.get("transaction_hash") or "").lower()
        token = transfer.get("token")
        amount = _amount(transfer.get("total"))
        if tx_hash not in sent or not isinstance(token, Mapping) or amount is None:
            continue
        incoming = _hash_of(transfer.get("to")) == me
        outgoing = _hash_of(transfer.get("from")) == me
        if incoming == outgoing:
            continue
        symbol = str(token.get("symbol") or "").upper()
        if symbol in QUOTE_SYMBOLS:
            if symbol in ("WETH", "ETH") and outgoing:
                weth_out[tx_hash] = weth_out.get(tx_hash, Decimal(0)) + amount
            continue
        key = (tx_hash, str(token.get("address_hash") or token.get("address") or "").lower())
        moved[key] = moved.get(key, Decimal(0)) + (amount if incoming else -amount)
    trades = []
    for (tx_hash, token), net in moved.items():
        at = _timestamp(sent[tx_hash].get("timestamp"))
        if not token or net == 0 or at is None:
            continue
        side = "buy" if net > 0 else "sell"
        trades.append(Trade(tx_hash, at, token, side, abs(net), _eth_paid(sent[tx_hash], weth_out.get(tx_hash)) if side == "buy" else None))
    trades.sort(key=lambda trade: (trade.at, trade.tx_hash, trade.token))
    return trades


def _eth_paid(transaction: Mapping[str, Any], weth: Decimal | None) -> Decimal | None:
    try:
        value = Decimal(str(transaction.get("value") or "0")) / _WEI
    except InvalidOperation:
        value = Decimal(0)
    return value if value > 0 else weth
