"""The Stage 1 test market of a world: TestWETH, TestToken, one HyvoV2Pair and the HyvoV2Router.

``Market.deploy`` deploys the four contracts from ``chain/artifacts`` from a fixed, impersonated
deployer address (so the contract addresses depend only on its nonce) and seeds the pool through
``addLiquidityETH``. Every transaction is sent with ``gasPrice: 0`` and a fixed gas limit: anvil
runs with a zero base fee, so ETH balances move only through trades, and a swap that will revert is
still mined (``eth_estimateGas`` would raise before sending), so it has a ``txHash``. Revert
reasons are decoded from ``debug_traceTransaction`` with the custom errors of the four ABIs.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Literal

from eth_abi import decode as abi_decode
from eth_abi.exceptions import DecodingError
from eth_utils import keccak, to_checksum_address
from eth_utils.abi import (
    abi_to_signature,
    event_abi_to_log_topic,
    get_abi_input_names,
    get_abi_input_types,
)
from web3 import Web3
from web3.contract import Contract
from web3.exceptions import Web3RPCError
from web3.types import RPCEndpoint, TxReceipt

from hyvo.world.amm import MAX_FEE_BPS, Reserves
from hyvo.world.artifacts import Artifact, load_artifact
from hyvo.world.state import AgentBalances, MarketState, SwapKind, SwapRecord
from hyvo.world.units import ETH_DECIMALS, to_base_units

if TYPE_CHECKING:
    from hyvo.world.anvil import AnvilInstance

DEPLOYER = to_checksum_address(keccak(b"hyvo/world/deployer")[-20:])
TOKEN_DECIMALS = 18  # TestToken
TX_GAS_LIMIT = 1_000_000  # a swap uses about 110k gas
DEPLOY_GAS_LIMIT = 6_000_000  # HyvoV2Pair, the largest deployment, uses about 1.35M
DEADLINE = 2**64 - 1  # far beyond any block timestamp
MAX_UINT256 = 2**256 - 1
POOL_KIND = "v2-test"
RECENT_SWAPS = 10
RECEIPT_TIMEOUT = 60.0
CONTRACTS = ("TestWETH", "TestToken", "HyvoV2Pair", "HyvoV2Router")

_ERROR_STRING = bytes.fromhex("08c379a0")  # Error(string)
_PANIC = bytes.fromhex("4e487b71")  # Panic(uint256)


class MarketError(RuntimeError):
    """A setup transaction reverted, or the node rejected a transaction."""


@dataclass(frozen=True)
class MarketConfig:
    """The test market of one run. Liquidity is in whole units (ETH and tokens)."""

    token_name: str = "Hyvo Test Token"
    token_symbol: str = "HYVX"
    liquidity_eth: Decimal | str = Decimal(100)
    liquidity_tokens: Decimal | str = Decimal(1000000)
    fee_bps: int = 30

    def __post_init__(self) -> None:
        if not self.token_name.strip() or not self.token_symbol.strip():
            raise ValueError("the token name and symbol must not be empty")
        if isinstance(self.fee_bps, bool) or not isinstance(self.fee_bps, int):
            raise TypeError("fee_bps must be an int")
        if not 0 <= self.fee_bps <= MAX_FEE_BPS:
            raise ValueError(f"fee_bps must be in 0..{MAX_FEE_BPS}, got {self.fee_bps}")
        if self.liquidity_wei <= 0 or self.liquidity_token_units <= 0:
            raise ValueError("the initial liquidity must be > 0 on both sides")

    @property
    def liquidity_wei(self) -> int:
        return to_base_units(self.liquidity_eth, ETH_DECIMALS)

    @property
    def liquidity_token_units(self) -> int:
        return to_base_units(self.liquidity_tokens, TOKEN_DECIMALS)


@dataclass(frozen=True)
class MarketAddresses:
    weth: str
    token: str
    pair: str
    router: str
    deployer: str


@dataclass(frozen=True)
class TxResult:
    """The outcome of one swap transaction. Amounts are in base units."""

    tx_hash: str
    status: Literal["ok", "reverted"]
    amount_in: int
    amount_out: int | None  # None when reverted
    revert_reason: str | None  # None when ok
    block_number: int


class Market:
    """A deployed test market. Create it with :meth:`deploy`."""

    def __init__(
        self,
        w3: Web3,
        config: MarketConfig,
        contracts: dict[str, Contract],
        *,
        chain_id: int,
        fork_block: int | None,
    ) -> None:
        self.w3 = w3
        self.config = config
        self.chain_id = chain_id
        self.fork_block = fork_block
        self.weth = contracts["TestWETH"]
        self.token = contracts["TestToken"]
        self.pair = contracts["HyvoV2Pair"]
        self.router = contracts["HyvoV2Router"]
        self.addresses = MarketAddresses(
            weth=self.weth.address,
            token=self.token.address,
            pair=self.pair.address,
            router=self.router.address,
            deployer=DEPLOYER,
        )
        self.token0: str = self.pair.functions.token0().call()
        self.token1: str = self.pair.functions.token1().call()
        self.token_is_token0 = self.token0 == self.token.address
        self.fee_bps: int = self.pair.functions.feeBps().call()
        self.token_name: str = self.token.functions.name().call()
        self.token_symbol: str = self.token.functions.symbol().call()
        self.token_decimals: int = self.token.functions.decimals().call()
        self.quote_symbol: str = self.weth.functions.symbol().call()
        self.quote_decimals: int = self.weth.functions.decimals().call()
        self._tx = _Transactor(w3, chain_id, (contract.abi for contract in contracts.values()))
        swap_abi: Any = next(item for item in self.pair.abi if item.get("name") == "Swap")
        self._swap_topic = event_abi_to_log_topic(swap_abi)
        self._agents: dict[str, str] = {}  # address -> agentId, in registration order
        self._swaps: list[SwapRecord] = []

    @classmethod
    def deploy(cls, anvil: AnvilInstance, config: MarketConfig | None = None) -> Market:
        """Deploy TestWETH, TestToken (owned by the deployer), HyvoV2Pair(token, weth, fee) and
        HyvoV2Router(weth), then seed the pool with the configured liquidity."""
        config = MarketConfig() if config is None else config
        w3 = anvil.w3
        chain_id = w3.eth.chain_id
        artifacts = {name: load_artifact(name) for name in CONTRACTS}
        tx = _Transactor(w3, chain_id, (artifact.abi for artifact in artifacts.values()))
        tx.set_balance(DEPLOYER, config.liquidity_wei)
        weth = tx.deploy(artifacts["TestWETH"])
        token = tx.deploy(artifacts["TestToken"], config.token_name, config.token_symbol, DEPLOYER)
        pair = tx.deploy(artifacts["HyvoV2Pair"], token.address, weth.address, config.fee_bps)
        router = tx.deploy(artifacts["HyvoV2Router"], weth.address)
        contracts = {
            "TestWETH": weth,
            "TestToken": token,
            "HyvoV2Pair": pair,
            "HyvoV2Router": router,
        }
        market = cls(w3, config, contracts, chain_id=chain_id, fork_block=anvil.fork_block)

        tokens = config.liquidity_token_units
        market.mint(DEPLOYER, tokens)
        tx.send_ok(token.functions.approve(router.address, tokens), DEPLOYER, "approve (liquidity)")
        tx.send_ok(
            router.functions.addLiquidityETH(pair.address, tokens, DEPLOYER),
            DEPLOYER,
            "addLiquidityETH",
            value=config.liquidity_wei,
        )
        return market

    # -- run.json world objects --------------------------------------------------------------

    def run_pools(self) -> list[dict[str, Any]]:
        return [
            {
                "address": self.pair.address,
                "token0": self.token0,
                "token1": self.token1,
                "kind": POOL_KIND,
                "feeBps": self.fee_bps,
            }
        ]

    def run_token(self) -> dict[str, Any]:
        return {
            "address": self.token.address,
            "symbol": self.token_symbol,
            "name": self.token_name,
            "decimals": self.token_decimals,
        }

    def run_quote(self) -> dict[str, Any]:
        return {
            "address": self.weth.address,
            "symbol": self.quote_symbol,
            "decimals": self.quote_decimals,
        }

    def run_world(self, initial_market: Mapping[str, Any]) -> dict[str, Any]:
        """Exactly the ``world`` object of run.json. ``initial_market`` is the pool before round 1
        (after deploy, liquidity and agent token seeding): ``state().to_run_market()`` taken then."""
        return {
            "chainId": self.chain_id,
            "forkBlock": self.fork_block,
            "pools": self.run_pools(),
            "token": self.run_token(),
            "quote": self.run_quote(),
            "initialMarket": dict(initial_market),
        }

    # -- agents ------------------------------------------------------------------------------

    def register_agent(self, agent_id: str, address: str) -> None:
        """Track an agent's address: it counts for ``holders`` and is named in the swap log."""
        address = to_checksum_address(address)
        if address in self._agents or agent_id in self._agents.values():
            raise ValueError(f"agent {agent_id} ({address}) is already registered")
        self._agents[address] = agent_id

    @property
    def agent_addresses(self) -> tuple[str, ...]:
        return tuple(self._agents)

    @property
    def swaps(self) -> tuple[SwapRecord, ...]:
        """Every executed swap, oldest first."""
        return tuple(self._swaps)

    # -- reads -------------------------------------------------------------------------------

    def reserves(self) -> Reserves:
        reserve0, reserve1, _ = self.pair.functions.getReserves().call()
        return self._by_asset(reserve0, reserve1)

    def state(self, recent: int = RECENT_SWAPS) -> MarketState:
        """The market at the latest block: reserves, price, holders among the registered agents
        (token balance > 0) and the last ``recent`` executed swaps.

        The reserves and all balances are read at one block number, in one JSON-RPC batch.
        """
        block = self.w3.eth.block_number
        agents = list(self._agents)
        reserves_raw, *balances_raw = self._batch(
            [
                _eth_call(self.pair, "getReserves", [], block),
                *(_eth_call(self.token, "balanceOf", [address], block) for address in agents),
            ]
        )
        reserve0, reserve1, _ = abi_decode(["uint112", "uint112", "uint32"], _bytes(reserves_raw))
        holders = [
            address for address, raw in zip(agents, balances_raw, strict=True) if int(raw, 16)
        ]
        return MarketState.from_reserves(
            block_number=block,
            reserve0=reserve0,
            reserve1=reserve1,
            token_is_token0=self.token_is_token0,
            holders=holders,
            recent_swaps=self._swaps[-recent:] if recent > 0 else (),
            token_decimals=self.token_decimals,
            quote_decimals=self.quote_decimals,
        )

    def quote_buy(self, eth_in: int) -> int:
        """Tokens a buy of ``eth_in`` wei would receive now (``HyvoV2Router.quoteBuy``)."""
        _check_positive(eth_in, "eth_in")
        return self.router.functions.quoteBuy(self.pair.address, eth_in).call()

    def quote_sell(self, tokens_in: int) -> int:
        """Wei a sell of ``tokens_in`` base units would receive now (``HyvoV2Router.quoteSell``)."""
        _check_positive(tokens_in, "tokens_in")
        return self.router.functions.quoteSell(self.pair.address, tokens_in).call()

    def eth_balance(self, address: str) -> int:
        return self.w3.eth.get_balance(to_checksum_address(address))

    def token_balance(self, address: str) -> int:
        return self.token.functions.balanceOf(to_checksum_address(address)).call()

    def balances(self, address: str) -> AgentBalances:
        """ETH and token balances at the latest block, read in one JSON-RPC batch."""
        address = to_checksum_address(address)
        block = self.w3.eth.block_number
        eth_raw, token_raw = self._batch(
            [
                (RPCEndpoint("eth_getBalance"), [address, hex(block)]),
                _eth_call(self.token, "balanceOf", [address], block),
            ]
        )
        return AgentBalances(eth=int(eth_raw, 16), token=int(token_raw, 16))

    # -- writes ------------------------------------------------------------------------------

    def set_eth_balance(self, address: str, wei: int) -> None:
        """Set an address's ETH balance (``anvil_setBalance``)."""
        self._tx.set_balance(to_checksum_address(address), wei)

    def mint(self, to: str, amount: int) -> None:
        """Mint test tokens to ``to``; the deployer owns TestToken."""
        _check_positive(amount, "amount")
        self._tx.send_ok(
            self.token.functions.mint(to_checksum_address(to), amount), DEPLOYER, "mint"
        )

    def approve_router(self, owner: str) -> None:
        """Approve the router to move all of ``owner``'s tokens (one max approval per agent)."""
        call = self.token.functions.approve(self.router.address, MAX_UINT256)
        self._tx.send_ok(call, to_checksum_address(owner), "approve (router)")

    def buy(self, agent: str, eth_in: int, min_out: int) -> TxResult:
        """Swap exactly ``eth_in`` wei for at least ``min_out`` tokens, sent to ``agent``."""
        _check_positive(eth_in, "eth_in")
        _check_non_negative(min_out, "min_out")
        agent = to_checksum_address(agent)
        call = self.router.functions.swapExactETHForTokens(
            self.pair.address, min_out, agent, DEADLINE
        )
        return self._swap("swap_buy", agent, call, eth_in, value=eth_in)

    def sell(self, agent: str, tokens_in: int, min_out: int) -> TxResult:
        """Swap exactly ``tokens_in`` of ``agent``'s tokens for at least ``min_out`` wei."""
        _check_positive(tokens_in, "tokens_in")
        _check_non_negative(min_out, "min_out")
        agent = to_checksum_address(agent)
        call = self.router.functions.swapExactTokensForETH(
            self.pair.address, tokens_in, min_out, agent, DEADLINE
        )
        return self._swap("swap_sell", agent, call, tokens_in, value=0)

    # -- internals ---------------------------------------------------------------------------

    def _by_asset(self, reserve0: int, reserve1: int) -> Reserves:
        if self.token_is_token0:
            return Reserves(token=reserve0, quote=reserve1)
        return Reserves(token=reserve1, quote=reserve0)

    def _batch(self, calls: list[tuple[RPCEndpoint, list[Any]]]) -> list[Any]:
        """Send raw JSON-RPC calls in one batch and return their results in order."""
        replies = self.w3.provider.make_batch_request(calls)
        if not isinstance(replies, list):
            raise MarketError(f"batch request failed: {replies.get('error')}")
        results = []
        for (method, _), reply in zip(calls, replies, strict=True):
            if "error" in reply:
                raise MarketError(f"{method} failed: {reply['error']}")
            results.append(reply["result"])
        return results

    def _swap(self, kind: SwapKind, agent: str, call: Any, amount_in: int, value: int) -> TxResult:
        receipt = self._tx.send(call, agent, value=value)
        tx_hash = _hex(receipt["transactionHash"])
        block = receipt["blockNumber"]
        if receipt["status"] != 1:
            reason = self._tx.revert_reason(tx_hash)
            return TxResult(tx_hash, "reverted", amount_in, None, reason, block)

        amounts_in, amounts_out = self._swap_event(receipt, tx_hash)
        paid = amounts_in.quote if kind == "swap_buy" else amounts_in.token
        received = amounts_out.token if kind == "swap_buy" else amounts_out.quote
        if paid != amount_in:
            raise MarketError(f"{tx_hash}: the pair received {paid}, expected {amount_in}")
        self._swaps.append(
            SwapRecord(
                agent_id=self._agents.get(agent),
                trader=agent,
                kind=kind,
                amount_in=amount_in,
                amount_out=received,
                tx_hash=tx_hash,
                block_number=block,
            )
        )
        return TxResult(tx_hash, "ok", amount_in, received, None, block)

    def _swap_event(self, receipt: TxReceipt, tx_hash: str) -> tuple[Reserves, Reserves]:
        """The pair's ``Swap`` event of a receipt, as (amounts in, amounts out) by asset."""
        for log in receipt["logs"]:
            if log["address"] == self.pair.address and bytes(log["topics"][0]) == self._swap_topic:
                args = self.pair.events.Swap().process_log(log)["args"]
                return (
                    self._by_asset(args["amount0In"], args["amount1In"]),
                    self._by_asset(args["amount0Out"], args["amount1Out"]),
                )
        raise MarketError(f"{tx_hash}: no Swap event from the pair")


class _Transactor:
    """Sends transactions from impersonated addresses and explains reverts."""

    def __init__(self, w3: Web3, chain_id: int, abis: Iterable[list[dict[str, Any]]]) -> None:
        self.w3 = w3
        self.chain_id = chain_id
        self.errors = _error_table(abis)

    def send(self, call: Any, sender: str, *, value: int = 0, gas: int = TX_GAS_LIMIT) -> TxReceipt:
        """Send and wait for the receipt; a reverting transaction is mined like any other."""
        params = {
            "from": sender,
            "value": value,
            "gas": gas,
            "gasPrice": 0,
            "chainId": self.chain_id,
        }
        try:
            tx_hash = call.transact(params)
        except Web3RPCError as error:
            raise MarketError(f"the node rejected a transaction from {sender}: {error}") from error
        return self.w3.eth.wait_for_transaction_receipt(
            tx_hash, timeout=RECEIPT_TIMEOUT, poll_latency=0.01
        )

    def send_ok(
        self, call: Any, sender: str, what: str, *, value: int = 0, gas: int = TX_GAS_LIMIT
    ) -> TxReceipt:
        receipt = self.send(call, sender, value=value, gas=gas)
        if receipt["status"] != 1:
            reason = self.revert_reason(_hex(receipt["transactionHash"]))
            raise MarketError(f"{what} reverted: {reason}")
        return receipt

    def deploy(self, artifact: Artifact, *args: Any) -> Contract:
        factory = self.w3.eth.contract(abi=artifact.abi, bytecode=artifact.bytecode)
        receipt = self.send_ok(
            factory.constructor(*args), DEPLOYER, f"deploying {artifact.name}", gas=DEPLOY_GAS_LIMIT
        )
        return self.w3.eth.contract(address=receipt["contractAddress"], abi=artifact.abi)

    def set_balance(self, address: str, wei: int) -> None:
        _check_non_negative(wei, "wei")
        reply = self.w3.provider.make_request(RPCEndpoint("anvil_setBalance"), [address, hex(wei)])
        if "error" in reply:
            raise MarketError(f"anvil_setBalance failed: {reply['error']}")

    def revert_reason(self, tx_hash: str) -> str:
        """Why a mined transaction reverted, from its call trace."""
        reply = self.w3.provider.make_request(
            RPCEndpoint("debug_traceTransaction"), [tx_hash, {"tracer": "callTracer"}]
        )
        trace = reply.get("result") or {}
        output = trace.get("output") or "0x"
        if len(output) > 2:
            return _decode_revert(bytes.fromhex(output[2:]), self.errors)
        return str(trace.get("error") or reply.get("error") or "reverted without a reason")


def _error_table(abis: Iterable[list[Any]]) -> dict[bytes, tuple[str, list[str], list[str]]]:
    """Custom errors by 4-byte selector: (name, argument names, argument types)."""
    table = {}
    for abi in abis:
        for item in abi:
            if item.get("type") == "error":
                selector = keccak(text=abi_to_signature(item))[:4]
                table[selector] = (
                    item["name"],
                    get_abi_input_names(item),
                    get_abi_input_types(item),
                )
    return table


def _decode_revert(data: bytes, errors: dict[bytes, tuple[str, list[str], list[str]]]) -> str:
    """Revert data as text, e.g. ``InsufficientOutput(amountOut=98, amountOutMin=99)``."""
    selector, payload = data[:4], data[4:]
    try:
        if selector == _ERROR_STRING:
            return str(abi_decode(["string"], payload)[0])
        if selector == _PANIC:
            return f"Panic({abi_decode(['uint256'], payload)[0]:#x})"
        if selector in errors:
            name, names, types = errors[selector]
            values = abi_decode(types, payload)
            return f"{name}({', '.join(f'{n}={v}' for n, v in zip(names, values, strict=True))})"
    except (DecodingError, OverflowError, TypeError, ValueError):
        pass  # malformed payload: report the raw data below
    return f"unknown revert data 0x{data.hex()}"


def _eth_call(
    contract: Contract, function: str, args: list[Any], block: int
) -> tuple[RPCEndpoint, list[Any]]:
    """A raw ``eth_call`` of a view function at ``block``, for :meth:`Market._batch`."""
    call = {"to": contract.address, "data": contract.encode_abi(function, args)}
    return RPCEndpoint("eth_call"), [call, hex(block)]


def _bytes(hex_text: str) -> bytes:
    return bytes.fromhex(hex_text.removeprefix("0x"))


def _hex(value: bytes) -> str:
    return "0x" + bytes(value).hex()


def _check_positive(value: int, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive int, got {value!r}")


def _check_non_negative(value: int, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a non-negative int, got {value!r}")
