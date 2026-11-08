"""From what was recorded to what a developer should look at (SPEC §11.1): invariants that broke, admin functions anyone can call, money
that moved where it should not, flows that keep failing, and gas that stands out. Every finding says how to reproduce it."""

from __future__ import annotations

import statistics
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2, "info": 3}
MIN_REPEATED_REVERTS = 3
GAS_OUTLIER_FACTOR = 3.0
GAS_OUTLIER_MIN = 100_000
MAX_STEPS = 12


@dataclass(frozen=True)
class Finding:
    severity: str
    kind: str
    title: str
    detail: str
    reproduce: tuple[Mapping[str, Any], ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {"severity": self.severity, "kind": self.kind, "title": self.title, "detail": self.detail, "reproduce": list(self.reproduce)}


def _step(call: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "round": call["round"],
        "agentId": call["agentId"],
        "function": call["function"],
        "args": call["args"],
        "valueWei": call["valueWei"],
    }


def _eth(wei: int) -> str:
    return f"{wei / 10**18:.4f} ETH"


def _who(call: Mapping[str, Any]) -> str:
    return f"{call['agentId']} ({call['persona'].replace('_', ' ')})"


def trail(calls: Sequence[Mapping[str, Any]], last: Mapping[str, Any]) -> tuple[dict[str, Any], ...]:
    """The calls that went through up to and including ``last``: a way to reproduce it. A long trail keeps its end."""
    steps: list[Mapping[str, Any]] = []
    for call in calls:
        if call is last or call["status"] == "ok":
            steps.append(call)
        if call is last:
            break
    return tuple(_step(call) for call in steps[-MAX_STEPS:])


def analyze(calls: Sequence[Mapping[str, Any]], invariants: Sequence[Mapping[str, Any]], probes: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    found = [
        *_broken_invariants(calls, invariants),
        *_open_admin(probes),
        *_money_out_of_nowhere(calls),
        *_repeated_reverts(calls),
        *_gas_outliers(calls),
        *_never_worked(calls),
    ]
    found.sort(key=lambda finding: SEVERITY_ORDER[finding.severity])
    return [finding.to_dict() for finding in found]


def _broken_invariants(calls: Sequence[Mapping[str, Any]], invariants: Sequence[Mapping[str, Any]]) -> list[Finding]:
    found = []
    for invariant in invariants:
        broken = invariant.get("firstBroken")
        name = invariant["name"]
        if invariant.get("error"):
            found.append(Finding("medium", "invariant_unreadable", f"{name}() could not be read", str(invariant["error"])))
        elif invariant.get("falseFromStart"):
            found.append(Finding("high", "invariant_violation", f"{name}() was false before anyone did anything", "The invariant does not hold on the contract as deployed."))
        elif broken is not None:
            call = calls[broken]
            found.append(
                Finding(
                    "high",
                    "invariant_violation",
                    f"{name}() became false",
                    f"It went false after {_who(call)} called {call['function']} in round {call['round']}.",
                    trail(calls, call),
                )
            )
    return found


def _open_admin(probes: Sequence[Mapping[str, Any]]) -> list[Finding]:
    return [
        Finding(
            "high",
            "access_control",
            f"{probe['function']} can be called by anyone",
            f"A wallet that is not the owner called it and it went through. It looks like an admin function by its name. Moved {_eth(int(probe.get('tookWei', '0')))} to that wallet.",
            ({"round": 0, "agentId": probe["agentId"], "function": probe["function"], "args": probe["args"], "valueWei": "0"},),
        )
        for probe in probes
        if probe["status"] == "ok"
    ]


def _money_out_of_nowhere(calls: Sequence[Mapping[str, Any]]) -> list[Finding]:
    """Users who at some point had taken out more than they ever put in, gas included. One finding, because it is one cause however many
    users ran into it. A user may put more in later, so this reports how far ahead each one got, not where it ended. Some dApps pay
    rewards, which is why this asks rather than says."""
    net: dict[str, int] = defaultdict(int)
    furthest: dict[str, int] = {}
    first: dict[str, Mapping[str, Any]] = {}
    for call in calls:
        if call["status"] != "ok":
            continue
        agent = call["agentId"]
        net[agent] += int(call["ethDeltaWei"])
        if net[agent] > 0:
            first.setdefault(agent, call)
            furthest[agent] = max(furthest.get(agent, 0), net[agent])
    if not first:
        return []
    top = max(furthest, key=lambda agent: furthest[agent])
    call = first[top]
    others = sorted(agent for agent in first if agent != top)
    return [
        Finding(
            "high",
            "unusual_balance",
            f"{len(first)} users took out more than they put in" if others else f"{top} took out more than it put in",
            f"{_who(call)} got {_eth(furthest[top])} ahead, starting with {call['function']} in round {call['round']}."
            + (f" Also: {', '.join(others)}." if others else "")
            + " If this dApp does not pay rewards, this is someone else's money.",
            trail(calls, call),
        )
    ]


def _repeated_reverts(calls: Sequence[Mapping[str, Any]]) -> list[Finding]:
    groups: dict[tuple[str, str], list[Mapping[str, Any]]] = defaultdict(list)
    for call in calls:
        if call["status"] == "reverted":
            groups[(call["function"], str(call.get("reason") or "no reason given"))].append(call)
    found = []
    for (function, reason), failed in groups.items():
        agents = {call["agentId"] for call in failed}
        if len(failed) >= MIN_REPEATED_REVERTS and len(agents) >= 2:
            found.append(
                Finding(
                    "medium" if len(agents) >= 3 else "low",
                    "confusing_flow",
                    f"{function} keeps failing: {reason}",
                    f"{len(failed)} calls from {len(agents)} users failed this way. If users meet this often, the reason may not tell them what to do.",
                    (_step(failed[0]),),
                )
            )
    return found


def _gas_outliers(calls: Sequence[Mapping[str, Any]]) -> list[Finding]:
    """A call far above what the function usually costs. A user's first call does not count: writing new storage always costs more."""
    by_function: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    seen: set[tuple[str, str]] = set()
    for call in calls:
        if call["status"] == "ok" and call.get("gasUsed"):
            caller = (call["agentId"], call["function"])
            if caller in seen:
                by_function[call["function"]].append(call)
            seen.add(caller)
    found = []
    for function, made in by_function.items():
        gas = [int(call["gasUsed"]) for call in made]
        typical = statistics.median(gas)
        top = max(gas)
        if top >= GAS_OUTLIER_MIN and top >= typical * GAS_OUTLIER_FACTOR:
            call = made[gas.index(top)]
            found.append(
                Finding(
                    "low",
                    "gas_outlier",
                    f"{function} used {top:,} gas where {typical:,.0f} is typical",
                    f"In round {call['round']}, by a user who had called it before, so this is not the cost of new storage. A loop over something users can make longer looks like this, and can make a function too expensive to call.",
                    (_step(call),),
                )
            )
    return found


def _never_worked(calls: Sequence[Mapping[str, Any]]) -> list[Finding]:
    tried: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for call in calls:
        if call["status"] in ("ok", "reverted"):
            tried[call["function"]].append(call)
    return [
        Finding("info", "never_worked", f"{function} never went through", f"The crowd tried it {len(made)} times and every call failed.", (_step(made[0]),))
        for function, made in tried.items()
        if len(made) >= MIN_REPEATED_REVERTS and all(call["status"] == "reverted" for call in made)
    ]
