"""Agent wallets: deterministic EOAs, funding, token seeding, the router approval, balances and PnL.

Agents have no keys: anvil runs with ``--auto-impersonate``, so any address can send. An agent's
address is derived from the run seed and its agentId, so the same seed always gives the same
addresses. Gas is free in the world, so an agent's ETH balance changes only through its swaps.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from decimal import Decimal
from typing import TYPE_CHECKING

from eth_utils import keccak, to_checksum_address

from hyvo.world.amm import Reserves, spot_value
from hyvo.world.state import AgentBalances
from hyvo.world.units import ETH_DECIMALS, format_amount, to_base_units

if TYPE_CHECKING:
    from hyvo.world.market import Market

_ADDRESS_DOMAIN = b"hyvo/agent/v1"


def agent_address(run_seed: str | int, agent_id: str) -> str:
    """The agent's EIP-55 address: the last 20 bytes of
    ``keccak256("hyvo/agent/v1" 0x00 run_seed 0x00 agent_id)``, with both values UTF-8 encoded."""
    if isinstance(run_seed, bool) or not isinstance(run_seed, (str, int)):
        raise TypeError(f"run_seed must be a str or int, got {type(run_seed).__name__}")
    if not agent_id:
        raise ValueError("agent_id must not be empty")
    preimage = b"\x00".join((_ADDRESS_DOMAIN, str(run_seed).encode(), agent_id.encode()))
    return to_checksum_address(keccak(preimage)[-20:])


@dataclass(frozen=True)
class AgentWallet:
    agent_id: str
    address: str


@dataclass(frozen=True)
class AgentPnL:
    """An agent's trading result in wei, marked to market at the pool's spot price."""

    eth_spent: int  # paid in executed buys
    eth_received: int  # received from executed sells
    token_balance: int  # token base units held now
    token_value: int  # token_balance at the spot price, rounded down
    seed_value: int  # the tokens seeded at funding, at the spot price of that moment

    @property
    def pnl(self) -> int:
        return self.eth_received - self.eth_spent + self.token_value - self.seed_value

    def to_dict(self) -> dict[str, str]:
        """Whole-unit ETH strings for an agent's context; ``pnl`` may be negative."""
        pnl = self.pnl
        return {
            "eth_spent": format_amount(self.eth_spent, ETH_DECIMALS),
            "eth_received": format_amount(self.eth_received, ETH_DECIMALS),
            "token_value_eth": format_amount(self.token_value, ETH_DECIMALS),
            "pnl_eth": ("-" if pnl < 0 else "") + format_amount(abs(pnl), ETH_DECIMALS),
        }


class Wallets:
    """The agents of one market, keyed by agentId, in the order they were added."""

    def __init__(self, market: Market, run_seed: str | int) -> None:
        self.market = market
        self.run_seed = run_seed
        self._wallets: dict[str, AgentWallet] = {}
        self._seed_values: dict[str, int] = {}

    def add(self, agent_id: str, eth: str | Decimal, tokens: str | Decimal = "0") -> AgentWallet:
        """Create an agent's wallet: set its ETH balance to ``eth`` (``anvil_setBalance``), mint it
        ``tokens`` and approve the router once for all its tokens. Amounts are in whole units."""
        if agent_id in self._wallets:
            raise ValueError(f"agent {agent_id} already has a wallet")
        wallet = AgentWallet(agent_id=agent_id, address=agent_address(self.run_seed, agent_id))
        wei = to_base_units(eth, ETH_DECIMALS)
        token_units = to_base_units(tokens, self.market.token_decimals)

        self.market.register_agent(agent_id, wallet.address)
        self.market.set_eth_balance(wallet.address, wei)
        if token_units:
            self.market.mint(wallet.address, token_units)
        self.market.approve_router(wallet.address)
        self._seed_values[agent_id] = (
            spot_value(token_units, self.market.reserves()) if token_units else 0
        )
        self._wallets[agent_id] = wallet
        return wallet

    def __getitem__(self, agent_id: str) -> AgentWallet:
        return self._wallets[agent_id]

    def __contains__(self, agent_id: object) -> bool:
        return agent_id in self._wallets

    def __iter__(self) -> Iterator[AgentWallet]:
        return iter(self._wallets.values())

    def __len__(self) -> int:
        return len(self._wallets)

    def balances(self, agent_id: str) -> AgentBalances:
        return self.market.balances(self[agent_id].address)

    def pnl(self, agent_id: str, reserves: Reserves | None = None) -> AgentPnL:
        """The agent's PnL from the market's swap log, marked at ``reserves`` (default: now)."""
        address = self[agent_id].address
        reserves = self.market.reserves() if reserves is None else reserves
        swaps = [swap for swap in self.market.swaps if swap.trader == address]
        tokens = self.market.token_balance(address)
        return AgentPnL(
            eth_spent=sum(swap.eth for swap in swaps if swap.kind == "swap_buy"),
            eth_received=sum(swap.eth for swap in swaps if swap.kind == "swap_sell"),
            token_balance=tokens,
            token_value=spot_value(tokens, reserves),
            seed_value=self._seed_values[agent_id],
        )
