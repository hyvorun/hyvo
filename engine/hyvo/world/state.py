"""Snapshots of the market and of an agent's balances, in their run.json and prompt forms."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Literal

from hyvo.world.amm import Reserves
from hyvo.world.units import ETH_DECIMALS, format_amount, format_price

SwapKind = Literal["swap_buy", "swap_sell"]


@dataclass(frozen=True)
class SwapRecord:
    """A swap that executed (receipt status 1), as the market logged it."""

    agent_id: str | None  # None when the trader is not a registered agent
    trader: str
    kind: SwapKind
    amount_in: int  # wei for swap_buy, token base units for swap_sell
    amount_out: int  # token base units for swap_buy, wei for swap_sell
    tx_hash: str
    block_number: int

    @property
    def eth(self) -> int:
        """Wei paid (swap_buy) or received (swap_sell)."""
        return self.amount_in if self.kind == "swap_buy" else self.amount_out

    @property
    def tokens(self) -> int:
        """Token base units received (swap_buy) or paid (swap_sell)."""
        return self.amount_out if self.kind == "swap_buy" else self.amount_in


@dataclass(frozen=True)
class AgentBalances:
    """An agent's balances in base units."""

    eth: int  # wei
    token: int  # token base units

    def to_dict(self, token_decimals: int = 18) -> dict[str, str]:
        return {
            "eth": format_amount(self.eth, ETH_DECIMALS),
            "token": format_amount(self.token, token_decimals),
        }


@dataclass(frozen=True)
class MarketState:
    """The pool at one block, the agents holding the token, and the latest executed swaps.

    ``reserve0``/``reserve1`` follow the pair's ``token0``/``token1`` (as in run.json); the ``_raw``
    fields hold the same reserves in base units and ``reserve_token``/``reserve_quote`` hold them by
    asset. Build it with :meth:`from_reserves` so the strings always match the integers.
    """

    block_number: int
    price: str
    reserve0: str
    reserve1: str
    reserve0_raw: int
    reserve1_raw: int
    reserve_token: int
    reserve_quote: int
    holders: tuple[str, ...]
    recent_swaps: tuple[SwapRecord, ...]
    token_decimals: int = 18
    quote_decimals: int = 18

    @classmethod
    def from_reserves(
        cls,
        *,
        block_number: int,
        reserve0: int,
        reserve1: int,
        token_is_token0: bool,
        holders: Iterable[str] = (),
        recent_swaps: Iterable[SwapRecord] = (),
        token_decimals: int = 18,
        quote_decimals: int = 18,
    ) -> MarketState:
        if token_decimals != quote_decimals:
            raise ValueError("the run.json price needs a token and quote with the same decimals")
        if token_is_token0:
            reserve_token, reserve_quote = reserve0, reserve1
            decimals0, decimals1 = token_decimals, quote_decimals
        else:
            reserve_token, reserve_quote = reserve1, reserve0
            decimals0, decimals1 = quote_decimals, token_decimals
        return cls(
            block_number=block_number,
            price=format_price(reserve_quote, reserve_token),
            reserve0=format_amount(reserve0, decimals0),
            reserve1=format_amount(reserve1, decimals1),
            reserve0_raw=reserve0,
            reserve1_raw=reserve1,
            reserve_token=reserve_token,
            reserve_quote=reserve_quote,
            holders=tuple(holders),
            recent_swaps=tuple(recent_swaps),
            token_decimals=token_decimals,
            quote_decimals=quote_decimals,
        )

    @property
    def reserves(self) -> Reserves:
        return Reserves(token=self.reserve_token, quote=self.reserve_quote)

    def to_run_market(self) -> dict[str, Any]:
        """Exactly the ``rounds[].market`` object of run.json."""
        return {
            "price": self.price,
            "reserve0": self.reserve0,
            "reserve1": self.reserve1,
            "holders": len(self.holders),
        }

    def to_prompt_dict(self) -> dict[str, Any]:
        """A compact view for an agent's context; amounts in whole units."""
        return {
            "block": self.block_number,
            "price_eth_per_token": self.price,
            "reserve_eth": format_amount(self.reserve_quote, self.quote_decimals),
            "reserve_token": format_amount(self.reserve_token, self.token_decimals),
            "holders": len(self.holders),
            "recent_swaps": [
                {
                    "agent": swap.agent_id or swap.trader,
                    "kind": swap.kind,
                    "eth": format_amount(swap.eth, self.quote_decimals),
                    "token": format_amount(swap.tokens, self.token_decimals),
                }
                for swap in self.recent_swaps
            ],
        }
