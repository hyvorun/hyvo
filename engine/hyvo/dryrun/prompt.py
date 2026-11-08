"""What the agents read each round (protocol ``dry_run/v1``), and the offline rules model, which plays like a small fuzzer: it needs
no network, and tries what each persona would, so a bug is found without spending anything."""

from __future__ import annotations

import json
import random
import re
from collections.abc import Sequence
from typing import Any

from hyvo.llm.offline import register_responder
from hyvo.llm.protocol import protocol_id, protocol_tag
from hyvo.llm.types import ChatMessage
from hyvo.scenarios.sanitize import DATA_RULE, quote_as_data

DRY_RUN_PROTOCOL = protocol_id("dry_run", 1)
MAX_TOKENS_PER_AGENT = 90

SYSTEM_PROMPT = f"""{protocol_tag("dry_run", 1)}
You play synthetic users trying a smart contract in a private sandbox, before it goes live. No real money is involved. Each agent has a \
character and acts like it. Each agent makes exactly one call this round, using only the functions listed.
Look at what each agent's earlier calls did, and react to it: an agent whose call failed may try something else, or may just be confused.
Give amounts in wei as strings. "valueEth" is what the call sends, and only payable functions can send anything.
"feedback" is one short sentence in that user's words about what it just experienced: what was clear, what was confusing, what looked wrong. It is about using the dApp, \
and is never advice about tokens.
{DATA_RULE}
Reply with this JSON only, one entry per agent:
{{"actions":[{{"agentId":"u01","function":"name(type)","args":["..."],"valueEth":"0","feedback":"..."}}]}}"""


def decision_messages(description: str, functions: list[dict[str, Any]], state: dict[str, str], agents: list[dict[str, Any]]) -> list[ChatMessage]:
    data = {"functions": functions, "state": state, "agents": agents}
    user = "\n".join((quote_as_data("dapp", description), quote_as_data("round", json.dumps(data, ensure_ascii=False))))
    return [ChatMessage(role="system", content=SYSTEM_PROMPT), ChatMessage(role="user", content=user)]


_DATA_BLOCK = re.compile(r'<data label="round"[^>]*>\n(.*)\n</data>', re.DOTALL)
_HUGE = 2**256 - 1
_ZERO_ADDRESS = "0x" + "0" * 40


def _amount(persona: str, wealth: int, rng: random.Random) -> int:
    if persona == "newcomer":
        return max(1, wealth // rng.choice((100, 50, 20)))
    if persona == "whale":
        return max(1, wealth // rng.choice((2, 4, 10)))
    if persona == "adversarial":
        return rng.choice((0, 1, wealth, wealth * 2, _HUGE))
    return max(1, wealth // rng.choice((10, 20, 5)))


def _argument(kind: str, agent: dict[str, Any], others: list[str], persona: str, wealth: int, rng: random.Random) -> Any:
    if kind.endswith("]"):
        inner = kind[: kind.rindex("[")]
        return [_argument(inner, agent, others, persona, wealth, rng) for _ in range(rng.randint(0, 2))]
    if kind.startswith(("uint", "int")):
        return str(_amount(persona, wealth, rng))
    if kind == "address":
        options = [agent["address"], *others[:3]]
        if persona == "adversarial":
            options.append(_ZERO_ADDRESS)
        return rng.choice(options)
    if kind == "bool":
        return rng.random() < 0.5
    if kind == "string":
        return rng.choice(("hello", "", "x" * 300 if persona == "adversarial" else "test"))
    if kind == "bytes":
        return "0x" if rng.random() < 0.5 else "0x00ff"
    if kind.startswith("bytes"):
        return "0x" + "00" * int(kind[5:])
    return "0"


def _action(agent: dict[str, Any], functions: list[dict[str, Any]], others: list[str], rng: random.Random) -> dict[str, Any]:
    persona = agent["persona"]
    wealth = int(agent["ethWei"])
    held = int(agent.get("heldWei", "0"))
    # Most users pay in first, and whoever paid something in comes back for it.
    payable = [f for f in functions if f["payable"]]
    others_fns = [f for f in functions if not f["payable"]]
    if payable and (held == 0 or rng.random() < 0.35):
        function = rng.choice(payable)
    elif others_fns:
        function = rng.choice(others_fns)
    else:
        function = rng.choice(functions)
    args = []
    for item in function["inputs"]:
        kind = item["type"]
        if held and kind.startswith("uint") and persona != "adversarial":
            args.append(str(max(1, held // rng.choice((1, 2, 4)))))
        else:
            args.append(_argument(kind, agent, others, persona, wealth, rng))
    value = "0"
    if function["payable"]:
        value = f"{_amount(persona if persona != 'adversarial' else 'power_user', wealth, rng) / 10**18:.18f}".rstrip("0").rstrip(".") or "0"
    last = (agent.get("lastCalls") or [{}])[-1]
    feedback = "It worked as I expected."
    if last.get("status") == "reverted":
        feedback = f"My last call failed and said: {str(last.get('reason'))[:80]}. I am not sure why."
    elif persona == "newcomer":
        feedback = "I am not sure what this function does until I try it."
    return {"agentId": agent["agentId"], "function": function["function"], "args": args, "valueEth": value, "feedback": feedback}


def dry_run_responder(messages: Sequence[ChatMessage], rng: random.Random) -> str:
    match = _DATA_BLOCK.search(messages[1].content)
    if not match:
        return json.dumps({"actions": []})
    data = json.loads(match.group(1))
    addresses = [agent["address"] for agent in data["agents"]]
    actions = [_action(agent, data["functions"], [a for a in addresses if a != agent["address"]], rng) for agent in data["agents"]]
    return json.dumps({"actions": actions})


register_responder(DRY_RUN_PROTOCOL, dry_run_responder)
