"""The sandbox and the rounds. A job's contract lives in its own anvil and dies with it, on a fork for a deployed contract and on a
plain chain for bytecode. The agents have no keys: anvil impersonates them, and gas is free there, so a user's ETH only moves when the
contract moves it.
"""

from __future__ import annotations

import json
import random
import secrets
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import httpx
from eth_utils import keccak, to_checksum_address, to_hex
from web3 import Web3
from web3.exceptions import ContractCustomError, ContractLogicError, Web3Exception
from web3.types import RPCEndpoint

from hyvo.config import Settings
from hyvo.llm.budget import BudgetMeter
from hyvo.llm.factory import make_clients
from hyvo.llm.json_utils import parse_json_object
from hyvo.llm.log import LLMLog
from hyvo.llm.metered import MeteredClient
from hyvo.llm.types import BudgetExceeded, LLMClient, LLMRequestError, LLMResponseError
from hyvo.report.guard import REMOVED_TEXT, find_violations
from hyvo.runfile.canonical import new_run_id, utc_timestamp
from hyvo.world.anvil import AnvilInstance
from hyvo.world.wallets import agent_address

from .abi import ActionSpace, Function, action_space, coerce_args, wire
from .crowd import ADVERSARIAL, TestUser, make_crowd
from .document import dry_run_document, write_dry_run
from .findings import analyze
from .prompt import MAX_TOKENS_PER_AGENT, decision_messages
from .spec import DryRunError, DryRunSpec

AGENTS_PER_CALL = 8
LAST_CALLS_SHOWN = 4
MAX_STATE_READS = 12
TX_GAS = 15_000_000
DEPLOY_GAS = 30_000_000
DEPLOYER = to_checksum_address("0x000000000000000000000000000000000000de1f")
DEPLOYER_ETH = 10**21
SOURCIFY_URL = "https://sourcify.dev/server/v2/contract/{chain}/{address}?fields=abi"
MAX_REASON_CHARS = 200
_PANICS = {
    0x01: "assert failed",
    0x11: "arithmetic overflow or underflow",
    0x12: "division by zero",
    0x21: "bad enum value",
    0x31: "pop from an empty array",
    0x32: "array index out of bounds",
    0x41: "out of memory",
    0x51: "called an empty internal function",
}
DEFAULT_CALLS_PER_ROUND_HEADROOM = 2


class DryRunFailed(RuntimeError):
    """The sandbox could not be set up, or the run could not finish."""


@dataclass(frozen=True)
class DryRunOutcome:
    run_id: str
    path: Path
    status: str
    stop_reason: str | None
    hash: str
    findings: int
    usage: Mapping[str, Any]


Progress = Callable[[str], None]


def fetch_verified_abi(address: str, chain_id: int = 4663, client: httpx.Client | None = None) -> list[dict[str, Any]]:
    """The ABI of a verified contract, from Sourcify."""
    http = client or httpx.Client(timeout=20.0, trust_env=False, follow_redirects=True, headers={"User-Agent": "hyvo-dryrun/0.1"})
    try:
        response = http.get(SOURCIFY_URL.format(chain=chain_id, address=address))
    except httpx.HTTPError as error:
        raise DryRunError(f"could not ask Sourcify for this contract's ABI: {type(error).__name__}. Give the ABI yourself") from None
    finally:
        if client is None:
            http.close()
    if response.status_code != 200:
        raise DryRunError("this contract is not verified on Sourcify. Give its ABI yourself")
    abi = response.json().get("abi")
    if not isinstance(abi, list):
        raise DryRunError("Sourcify holds no ABI for this contract. Give it yourself")
    return abi


class _Sandbox:
    """One contract in one anvil, and everything that happens to it."""

    def __init__(self, w3: Web3, space: ActionSpace, abi: Sequence[Mapping[str, Any]], address: str) -> None:
        self.w3 = w3
        self.space = space
        self.abi = abi
        self.address = to_checksum_address(address)
        self.topics = {to_hex(keccak(text=signature)): name for name, signature in space.events.items()}
        self.errors = {
            to_hex(keccak(text=_error_signature(fragment)))[:10]: str(fragment.get("name"))
            for fragment in space.errors
        }

    def contract_for(self, function: Function) -> Any:
        return self.w3.eth.contract(address=self.address, abi=[dict(function.fragment)])

    def read_state(self) -> dict[str, str]:
        state: dict[str, str] = {}
        for function in self.space.reads[:MAX_STATE_READS]:
            try:
                value = self.contract_for(function).functions[function.name]().call()
            except (Web3Exception, ValueError):
                continue
            state[function.name] = _short(value)
        return state

    def read_bool(self, name: str) -> bool:
        function = next((read for read in self.space.reads if read.name == name), None)
        if function is None:
            raise DryRunError(f"{name}() is not a view function without arguments in this ABI")
        value = self.contract_for(function).functions[name]().call()
        if not isinstance(value, bool):
            raise DryRunError(f"{name}() does not return true or false")
        return value

    def balance(self, address: str) -> int:
        return self.w3.eth.get_balance(to_checksum_address(address))

    def set_balance(self, address: str, wei: int) -> None:
        reply = self.w3.provider.make_request(RPCEndpoint("anvil_setBalance"), [to_checksum_address(address), hex(wei)])
        if "error" in reply:
            raise DryRunFailed(f"anvil_setBalance failed: {reply['error']}")

    def call(self, sender: str, function: Function, args: list[Any], value: int) -> dict[str, Any]:
        """Send one call and record what it did. A call that reverts is mined like any other."""
        data = self.contract_for(function).encode_abi(function.name, args)
        tx: dict[str, Any] = {"from": sender, "to": self.address, "data": data, "value": value, "gas": TX_GAS, "gasPrice": 0}
        reason = self._revert_reason(tx)
        before_user, before_contract = self.balance(sender), self.balance(self.address)
        state_before = self.read_state()
        tx_hash = self.w3.eth.send_transaction(tx)
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=30, poll_latency=0.01)
        ok = receipt["status"] == 1
        state_after = self.read_state()
        changes = {name: [state_before.get(name), state_after[name]] for name in state_after if state_before.get(name) != state_after[name]}
        return {
            "status": "ok" if ok else "reverted",
            "reason": None if ok else (reason or "no reason given"),
            "gasUsed": receipt["gasUsed"],
            "txHash": to_hex(tx_hash),
            "ethDeltaWei": str(self.balance(sender) - before_user),
            "contractDeltaWei": str(self.balance(self.address) - before_contract),
            "events": [self.topics[to_hex(log["topics"][0])] for log in receipt["logs"] if log["topics"] and to_hex(log["topics"][0]) in self.topics],
            "changes": changes,
        }

    def _revert_reason(self, tx: Mapping[str, Any]) -> str | None:
        try:
            self.w3.eth.call(dict(tx))  # type: ignore[arg-type]
            return None
        except ContractCustomError as error:
            data = str(error.data or error.message or "")
            return self.errors.get(data[:10], f"custom error {data[:10]}")[:MAX_REASON_CHARS]
        except ContractLogicError as error:
            return _reason_text(str(error.message or error))[:MAX_REASON_CHARS]
        except (Web3Exception, ValueError) as error:
            return _reason_text(str(error))[:MAX_REASON_CHARS]


def _error_signature(fragment: Mapping[str, Any]) -> str:
    inputs = ",".join(str(item.get("type")) for item in fragment.get("inputs") or [])
    return f"{fragment.get('name')}({inputs})"


def _reason_text(raw: str) -> str:
    text = raw.removeprefix("execution reverted: ").removeprefix("execution reverted").strip(" :")
    if "Panic" in text and "0x" in text:
        for code, meaning in _PANICS.items():
            if f"{code:#04x}" in text or f"0x{code:x}" in text:
                return f"Panic: {meaning}"
    return text or "no reason given"


def _short(value: Any) -> str:
    text = wire(value) if not isinstance(value, str) else value
    text = text if isinstance(text, str) else json.dumps(text)
    return text[:120]


def _value_wei(raw: Any) -> int:
    try:
        amount = Decimal(str(raw if raw not in (None, "") else "0"))
    except InvalidOperation:
        raise DryRunError(f"{raw!r} is not an amount of ETH") from None
    if not amount.is_finite() or amount < 0:
        raise DryRunError(f"{raw!r} is not an amount of ETH")
    wei = int(amount * 10**18)
    if wei >= 2**256:
        raise DryRunError(f"{raw!r} is more ETH than exists")
    return wei


def _clean_feedback(raw: Any) -> str:
    text = " ".join(str(raw or "").split())[:280]
    return REMOVED_TEXT if find_violations(text) else text


def _agents_view(crowd: Sequence[TestUser], sandbox: _Sandbox, seed: int, calls: Sequence[Mapping[str, Any]], held: Mapping[str, int]) -> list[dict[str, Any]]:
    view = []
    for user in crowd:
        address = agent_address(seed, user.agent_id)
        mine = [call for call in calls if call["agentId"] == user.agent_id][-LAST_CALLS_SHOWN:]
        view.append(
            {
                "agentId": user.agent_id,
                "persona": user.persona.id,
                "character": user.persona.habit,
                "address": address,
                "ethWei": str(sandbox.balance(address)),
                "heldWei": str(max(0, held.get(user.agent_id, 0))),
                "lastCalls": [{"function": call["function"], "status": call["status"], "reason": call.get("reason")} for call in mine],
            }
        )
    return view


def _decide(
    client: LLMClient,
    description: str,
    functions: list[dict[str, Any]],
    state: dict[str, str],
    agents: list[dict[str, Any]],
    temperature: float,
) -> tuple[dict[str, dict[str, Any]], str | None]:
    """One round's decisions in batches; a batch that fails leaves its agents without a call. The second value is why the budget stopped it."""
    decisions: dict[str, dict[str, Any]] = {}
    for start in range(0, len(agents), AGENTS_PER_CALL):
        batch = agents[start : start + AGENTS_PER_CALL]
        try:
            result = client.complete(
                decision_messages(description, functions, state, batch),
                temperature=temperature,
                max_tokens=MAX_TOKENS_PER_AGENT * len(batch),
                json_mode=True,
                purpose="agents",
            )
            reply = parse_json_object(result.text).get("actions")
        except BudgetExceeded as error:
            return decisions, str(error) or "budget"
        except (LLMRequestError, LLMResponseError):
            continue
        if not isinstance(reply, list):
            continue
        known = {agent["agentId"] for agent in batch}
        for action in reply:
            if isinstance(action, Mapping) and action.get("agentId") in known:
                decisions[action["agentId"]] = dict(action)
    return decisions, None


def _deploy(w3: Web3, spec: DryRunSpec, abi: Sequence[Mapping[str, Any]]) -> str:
    factory = w3.eth.contract(abi=list(abi), bytecode=spec.bytecode)
    try:
        tx_hash = factory.constructor(*spec.constructor_args).transact({"from": DEPLOYER, "gas": DEPLOY_GAS, "gasPrice": 0})
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=30, poll_latency=0.01)
    except (Web3Exception, ValueError, TypeError) as error:
        raise DryRunError(f"the contract could not be deployed: {str(error)[:300]}") from None
    if receipt["status"] != 1 or not receipt.get("contractAddress"):
        raise DryRunError("the contract's constructor reverted")
    return receipt["contractAddress"]


def _probe_admin(sandbox: _Sandbox, prober: str, admin: Sequence[Function], rng: random.Random) -> list[dict[str, Any]]:
    """Whether a stranger can call what looks admin-only. Each try is undone, so that one does not hide the next."""
    probes = []
    for function in admin:
        args = [_probe_argument(str(item.get("type")), prober) for item in function.inputs]
        snapshot = sandbox.w3.provider.make_request(RPCEndpoint("evm_snapshot"), [])["result"]
        try:
            coerced = coerce_args(function, args)
            done = sandbox.call(prober, function, coerced, 0)
            probes.append(
                {
                    "agentId": "adversarial",
                    "function": function.signature,
                    "args": [wire(value) for value in coerced],
                    "status": done["status"],
                    "reason": done["reason"],
                    "tookWei": str(max(0, int(done["ethDeltaWei"]))),
                }
            )
        except (DryRunError, Web3Exception, ValueError, TypeError) as error:
            probes.append({"agentId": "adversarial", "function": function.signature, "args": [], "status": "not_tried", "reason": str(error)[:200], "tookWei": "0"})
        finally:
            sandbox.w3.provider.make_request(RPCEndpoint("evm_revert"), [snapshot])
    return probes


def _probe_argument(kind: str, prober: str) -> Any:
    if kind.endswith("]"):
        return []
    if kind == "address":
        return prober
    if kind.startswith(("uint", "int")):
        return "1"
    if kind == "bool":
        return True
    if kind == "string":
        return "probe"
    if kind == "bytes":
        return "0x"
    if kind.startswith("bytes"):
        return "0x" + "00" * int(kind[5:])
    return "0"


def play_dry_run(
    spec: DryRunSpec,
    settings: Settings,
    *,
    runs_dir: Path,
    run_id: str | None = None,
    offline: bool = False,
    clients: tuple[LLMClient, LLMClient] | None = None,
    timeout_s: float = 1800.0,
    progress: Progress | None = None,
) -> DryRunOutcome:
    """Play a submission and write ``dryrun.json``. A contract that cannot be set up raises ``DryRunError``."""
    seed = spec.seed if spec.seed is not None else secrets.randbelow(2**31)
    abi = list(spec.abi) if spec.abi is not None else fetch_verified_abi(spec.address or "")
    space = action_space(abi)
    crowd = make_crowd(spec.agents, seed)
    agents_raw, _report_raw = clients or make_clients(settings, offline, seed=seed)
    identifier = run_id or new_run_id()
    folder = runs_dir / identifier
    folder.mkdir(parents=True, exist_ok=True)
    max_calls = spec.max_llm_calls if spec.max_llm_calls is not None else DEFAULT_CALLS_PER_ROUND_HEADROOM * spec.rounds * (1 + spec.agents // AGENTS_PER_CALL)
    budget = BudgetMeter(settings.max_cost_usd_default if spec.max_cost_usd is None else spec.max_cost_usd, max_calls, report_reserve_calls=0)
    client = MeteredClient(agents_raw, budget, LLMLog(folder / "llm-log.jsonl"))
    deadline = time.monotonic() + timeout_s
    created_at = utc_timestamp()

    forked = spec.address is not None
    if forked and not settings.rh_rpc_url:
        raise DryRunError("a deployed contract needs a fork: set RH_RPC_URL, or give its bytecode instead")
    anvil = AnvilInstance.from_settings(settings, fork_block_number=spec.fork_block) if forked else AnvilInstance()
    with anvil:
        w3 = anvil.w3
        reply = w3.provider.make_request(RPCEndpoint("anvil_setBalance"), [DEPLOYER, hex(DEPLOYER_ETH)])
        if "error" in reply:
            raise DryRunFailed(f"anvil_setBalance failed: {reply['error']}")
        address = spec.address or _deploy(w3, spec, abi)
        if not w3.eth.get_code(to_checksum_address(address)):
            raise DryRunError("there is no contract at this address on the chain")
        sandbox = _Sandbox(w3, space, abi, address)
        wallets = {user.agent_id: agent_address(seed, user.agent_id) for user in crowd}
        for user in crowd:
            sandbox.set_balance(wallets[user.agent_id], user.start_wei)

        invariants = _start_invariants(sandbox, spec.invariants)
        functions = [function.card() for function in space.actions]
        calls: list[dict[str, Any]] = []
        rounds: list[dict[str, Any]] = []
        held: dict[str, int] = {}
        stop_reason: str | None = None
        rng = random.Random(seed)

        for n in range(1, spec.rounds + 1):
            state = sandbox.read_state()
            agents = _agents_view(crowd, sandbox, seed, calls, held)
            decisions, stopped = _decide(client, spec.description, functions, state, agents, 0.8)
            if stopped and not decisions:
                stop_reason = "budget"
                break
            first_call = len(calls)
            order = [user for user in crowd if user.agent_id in decisions]
            rng.shuffle(order)
            for user in order:
                record = _execute(sandbox, space, user, wallets[user.agent_id], decisions[user.agent_id], n)
                calls.append(record)
                if record["status"] == "ok":
                    held[user.agent_id] = held.get(user.agent_id, 0) - int(record["ethDeltaWei"])
                    _check_invariants(sandbox, invariants, len(calls) - 1)
            rounds.append({"n": n, "state": state, "firstCall": first_call, "calls": len(calls) - first_call})
            if progress:
                progress(f"round {n}/{spec.rounds}: {len(calls) - first_call} calls, {sum(1 for call in calls[first_call:] if call['status'] == 'reverted')} reverted")
            if stopped:
                stop_reason = "budget"
                break
            if time.monotonic() >= deadline and n < spec.rounds:
                stop_reason = "timeout"
                break

        prober = next((wallets[user.agent_id] for user in crowd if user.persona.id == ADVERSARIAL.id), wallets[crowd[0].agent_id])
        probes = _probe_admin(sandbox, prober, space.admin, rng)
        final_balances = {user.agent_id: str(sandbox.balance(wallets[user.agent_id])) for user in crowd}
        target_eth = str(sandbox.balance(address))
        state = sandbox.read_state()

    findings = analyze(calls, invariants, probes)
    feedback = _feedback(calls)
    document = dry_run_document(
        run_id=identifier,
        created_at=created_at,
        status="complete" if stop_reason is None else "partial",
        stop_reason=stop_reason,
        spec=spec,
        target={"kind": "address" if forked else "bytecode", "address": to_checksum_address(address), "forked": forked},
        crowd={"size": spec.agents, "personas": _mix(crowd), "agents": [{"agentId": user.agent_id, "persona": user.persona.id, "address": wallets[user.agent_id], "startWei": str(user.start_wei), "endWei": final_balances[user.agent_id]} for user in crowd], "model": client.model_label},
        space=space,
        calls=calls,
        rounds=rounds,
        invariants=invariants,
        probes=probes,
        findings=findings,
        feedback=feedback,
        final_state={"contractWei": target_eth, "reads": state},
        usage=budget.usage(),
    )
    path = write_dry_run(folder, document)
    written = json.loads(path.read_text(encoding="utf-8"))
    return DryRunOutcome(identifier, path, written["status"], written["stopReason"], written["hash"], len(findings), written["usage"])


def _mix(crowd: Sequence[TestUser]) -> dict[str, int]:
    mix: dict[str, int] = {}
    for user in crowd:
        mix[user.persona.id] = mix.get(user.persona.id, 0) + 1
    return mix


def _start_invariants(sandbox: _Sandbox, names: Sequence[str]) -> list[dict[str, Any]]:
    invariants: list[dict[str, Any]] = []
    for name in names:
        entry: dict[str, Any] = {"name": name, "held": True, "firstBroken": None, "falseFromStart": False, "error": None}
        try:
            if not sandbox.read_bool(name):
                entry.update(held=False, falseFromStart=True)
        except (DryRunError, Web3Exception, ValueError) as error:
            entry.update(held=False, error=str(error)[:200])
        invariants.append(entry)
    return invariants


def _check_invariants(sandbox: _Sandbox, invariants: list[dict[str, Any]], call_index: int) -> None:
    for entry in invariants:
        if not entry["held"]:
            continue
        try:
            still = sandbox.read_bool(entry["name"])
        except (DryRunError, Web3Exception, ValueError) as error:
            entry.update(held=False, error=str(error)[:200])
            continue
        if not still:
            entry.update(held=False, firstBroken=call_index)


def _execute(sandbox: _Sandbox, space: ActionSpace, user: TestUser, address: str, decision: Mapping[str, Any], n: int) -> dict[str, Any]:
    base: dict[str, Any] = {
        "round": n,
        "agentId": user.agent_id,
        "persona": user.persona.id,
        "function": str(decision.get("function", ""))[:200],
        "args": [],
        "valueWei": "0",
        "feedback": _clean_feedback(decision.get("feedback")),
        "gasUsed": None,
        "txHash": None,
        "ethDeltaWei": "0",
        "contractDeltaWei": "0",
        "events": [],
        "changes": {},
        "reason": None,
    }
    function = space.find(base["function"])
    if function is None:
        return {**base, "status": "invalid", "reason": "not a function this crowd can call"}
    try:
        args = coerce_args(function, decision.get("args"))
        value = _value_wei(decision.get("valueEth"))
        if value and not function.payable:
            raise DryRunError(f"{function.signature} cannot take ETH")
    except DryRunError as error:
        return {**base, "function": function.signature, "status": "invalid", "reason": str(error)[:MAX_REASON_CHARS]}
    base.update(function=function.signature, args=[wire(value_) for value_ in args], valueWei=str(value))
    if value > sandbox.balance(address):
        return {**base, "status": "invalid", "reason": "the user does not have that much ETH"}
    try:
        return {**base, **sandbox.call(address, function, args, value)}
    except (Web3Exception, ValueError, TypeError) as error:
        return {**base, "status": "invalid", "reason": str(error)[:MAX_REASON_CHARS]}


def _feedback(calls: Sequence[Mapping[str, Any]]) -> list[dict[str, str]]:
    """What the users said, without repeats, and a few from each kind of user."""
    seen: set[str] = set()
    per_persona: dict[str, int] = {}
    lines = []
    for call in calls:
        text = call.get("feedback") or ""
        if not text or text == REMOVED_TEXT or text in seen:
            continue
        seen.add(text)
        count = per_persona.get(call["persona"], 0)
        if count >= 5:
            continue
        per_persona[call["persona"]] = count + 1
        lines.append({"agentId": call["agentId"], "persona": call["persona"], "round": call["round"], "text": text})
    return lines

