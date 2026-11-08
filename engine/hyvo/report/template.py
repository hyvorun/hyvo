"""Deterministic report writer: report/v1 output written from the prompt data alone, no LLM.

Used for the template fallback (``include_posts=True``), the stats-only report when the LLM budget
is exhausted (``include_posts=False``: numbers only, no quoted posts) and by the offline responder.
Sentences never start with "Buy"/"Sell" and never use advice or prediction language, so the copy
guard only fires on quoted agent text. Numbers are written for people: ETH rounded to four
significant digits, token counts compacted (3.8M), prices quoted per 1K or 1M tokens when a single
token is worth a tiny fraction of an ETH. The exact values stay in run.json.
"""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from hyvo.report.prompt import (
    MAX_ITEM_CHARS,
    MAX_OBJECTIONS,
    MAX_PRICE_DRIVERS,
    MAX_WHY_CHARS,
    clip,
    format_pct,
)

NO_ROUNDS_SUMMARY = (
    "The run stopped before any round was recorded, so there is no crowd reaction to describe."
)
OBJECTION_SENTIMENT = -0.2  # a post counts as an objection when its author's sentiment is at most this
_QUOTE_CHARS = 160
_TEMPLATE_DRIVERS = 3
_TEMPLATE_OBJECTIONS = 3
_PERSONAS = {
    "sniper": ("sniper", "snipers"),
    "holder": ("holder", "holders"),
    "panic_seller": ("panic seller", "panic sellers"),
    "skeptic": ("skeptic", "skeptics"),
    "swing_trader": ("swing trader", "swing traders"),
    "whale": ("whale", "whales"),
    "kol_follower": ("KOL follower", "KOL followers"),
    "market_maker_bot": ("market maker bot", "market maker bots"),
    "stock_token_holder": ("stock token holder", "stock token holders"),
    "newcomer": ("newcomer", "newcomers"),
    "clone": ("clone", "clones"),
}
_PRICE_UNITS = ((1, ""), (1_000, "1K"), (1_000_000, "1M"), (1_000_000_000, "1B"))


def deterministic_content(data: Mapping[str, Any], *, include_posts: bool) -> dict[str, Any]:
    """Return ``{summary, turningPoint, objections, priceDrivers}`` in the report/v1 contract."""
    if not data["rounds"]:
        return {"summary": NO_ROUNDS_SUMMARY, "turningPoint": None, "objections": [], "priceDrivers": []}
    return {
        "summary": _summary(data, include_posts),
        "turningPoint": _turning_point(data, include_posts),
        "objections": _objections(data) if include_posts else [],
        "priceDrivers": _price_drivers(data),
    }


def _summary(data: Mapping[str, Any], include_posts: bool) -> str:
    rounds, totals, crowd = data["rounds"], data["totals"], data["crowd"]
    first, last = rounds[0], rounds[-1]
    sentences = [
        f"A synthetic crowd of {_count(crowd['size'], 'agent')} reacted over {_count(len(rounds), 'round')}."
    ]
    if data["stopReason"]:
        sentences.append(f"The run stopped early ({data['stopReason']}).")
    (start, end), unit = _prices(data["initialMarket"]["price"], last["price"])
    sentences.append(
        f"The price went from {start} to {end} ETH {unit} ({format_pct(totals['priceChangePct'])})."
    )
    sentences.append(
        f"Agents made {_count(totals['buys'], 'buy')} and {_count(totals['sells'], 'sell')}; "
        f"{_flow(totals['netFlowEth'])}."
    )
    flows = [f for f in data["personaFlows"] if Decimal(f["netFlowEth"]) != 0]
    if flows:
        top = max(flows, key=lambda f: (abs(Decimal(f["netFlowEth"])), f["persona"]))
        direction = "inflow" if Decimal(top["netFlowEth"]) > 0 else "outflow"
        sentences.append(
            f"The largest net {direction} came from {_persona(top['persona'], plural=True)} "
            f"({_signed(top['netFlowEth'])} ETH)."
        )
    if len(rounds) == 1:
        sentences.append(f"Mean sentiment was {first['sentiment']:+.2f} in round {first['round']}.")
    else:
        sentences.append(
            f"Mean sentiment moved from {first['sentiment']:+.2f} in round {first['round']} "
            f"to {last['sentiment']:+.2f} in round {last['round']}."
        )
    sentences.append(
        f"Agents wrote {_count(totals['posts'], 'post')} that drew {_count(totals['likes'], 'like')}."
    )
    problems = []
    if totals["invalid"]:
        problems.append(f"{_count(totals['invalid'], 'action')} failed validation")
    if totals["reverted"]:
        problems.append(f"{_count(totals['reverted'], 'swap')} reverted")
    if problems:
        sentences.append(" and ".join(problems).capitalize() + ".")
    if not include_posts:
        sentences.append("This report was generated from run statistics only.")
    return " ".join(sentences)


def _count(n: int, noun: str) -> str:
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"


def _turning_point(data: Mapping[str, Any], include_posts: bool) -> dict[str, Any] | None:
    if not data["candidates"]:
        return None
    top = data["candidates"][0]
    row = data["rounds"][top["round"] - 1]
    signals = []
    if top["priceChangePct"]:  # None (no previous price) and 0.0 are left out
        signals.append(f"the price moved {format_pct(top['priceChangePct'])}")
    if top["sentimentChange"]:
        signals.append(f"mean sentiment changed by {top['sentimentChange']:+.2f}")
    if top["netFlowFlipped"]:
        signals.append("net flow changed direction")
    if top["injectedEvent"]:
        quotes = "; ".join(f'"{clip(text, _QUOTE_CHARS)}"' for text in row["events"])
        signals.append(f"an event was injected ({quotes})")
    # Leave room for the evidence sentence so the whole text stays within the output contract.
    why = clip(f"Round {top['round']} showed the largest combined change: {', '.join(signals)}.",
               MAX_WHY_CHARS - 80)
    evidence: list[str] = []
    if include_posts:
        in_round = [p for p in data["posts"] if p["round"] == top["round"]]
        evidence = [p["id"] for p in sorted(in_round, key=lambda p: -p["likes"])[:2]]
        if evidence:
            why += f" Most-liked posts that round: {', '.join(evidence)}."
    return {"round": top["round"], "why": why, "evidencePostIds": evidence}


def _objections(data: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Quotes of the most negative listed posts, at most one per author."""
    negative = [
        p for p in data["posts"] if p["sentiment"] is not None and p["sentiment"] <= OBJECTION_SENTIMENT
    ]
    negative.sort(key=lambda p: (p["sentiment"], -p["likes"], p["round"]))
    objections: list[dict[str, Any]] = []
    authors: set[str] = set()
    for post in negative:
        if post["agentId"] in authors or len(objections) == min(_TEMPLATE_OBJECTIONS, MAX_OBJECTIONS):
            continue
        authors.add(post["agentId"])
        quote = clip(post["text"], _QUOTE_CHARS)
        who = _persona(post["persona"]).capitalize()
        text = f'{who} {post["agentId"]} in round {post["round"]}: "{quote}" ({post["id"]})'
        objections.append({"text": clip(text, MAX_ITEM_CHARS), "evidencePostIds": [post["id"]]})
    return objections


def _price_drivers(data: Mapping[str, Any]) -> list[str]:
    lines = []
    for d in data["drivers"][:_TEMPLATE_DRIVERS]:
        if d["kind"] == "swap_buy":
            move = f"spent {_eth(d['amountIn'])} ETH on {_tokens(d['amountOut'])} tokens"
        else:
            move = f"swapped {_tokens(d['amountIn'])} tokens for {_eth(d['amountOut'])} ETH"
        (before, after), unit = _prices(d["priceBefore"], d["priceAfter"])
        lines.append(
            f"Round {d['round']}: {d['agentId']} ({_persona(d['persona'])}) {move}; the price moved "
            f"{format_pct(d['impactPct'])} ({before} to {after} ETH {unit})."
        )
    flows = [f for f in data["personaFlows"] if f["buys"] or f["sells"]]
    if flows:
        lines.append(
            "Net flow by persona: "
            + ", ".join(
                f"{_persona(f['persona'], plural=True)} {_signed(f['netFlowEth'])} ETH" for f in flows
            )
            + "."
        )
    return [clip(line, MAX_ITEM_CHARS) for line in lines[:MAX_PRICE_DRIVERS]]


def _flow(net: str) -> str:
    value = Decimal(net)
    if value > 0:
        return f"{_eth(net)} ETH more went into the pool than came out"
    if value < 0:
        return f"{_eth(net.lstrip('-'))} ETH more came out of the pool than went in"
    return "inflows and outflows balanced"


def _signed(value: str) -> str:
    rounded = _eth(value)
    return rounded if rounded.startswith("-") or rounded == "0" else f"+{rounded}"


def _persona(persona: str, *, plural: bool = False) -> str:
    one, many = _PERSONAS.get(persona, (persona, f"{persona}s"))
    return many if plural else one


def _significant(value: Decimal, digits: int = 4) -> str:
    """``value`` with at most ``digits`` significant digits, plain notation, no trailing zeros."""
    if value == 0:
        return "0"
    rounded = value.quantize(Decimal(1).scaleb(value.adjusted() - digits + 1))
    plain = format(rounded, "f")
    return plain.rstrip("0").rstrip(".") if "." in plain else plain


def _eth(value: str) -> str:
    return _significant(Decimal(value))


def _tokens(value: str) -> str:
    amount = Decimal(value)
    for size, suffix in ((Decimal(10) ** 9, "B"), (Decimal(10) ** 6, "M"), (Decimal(10) ** 3, "K")):
        if abs(amount) >= size:
            return f"{_significant(amount / size, 3)}{suffix}"
    return _significant(amount, 3)


def _prices(*prices: str) -> tuple[list[str], str]:
    """The prices in one unit, the smallest that shows the largest of them as at least 0.01:
    ``per token``, ``per 1K tokens`` or ``per 1M tokens``."""
    values = [Decimal(p) for p in prices]
    top = max(values)
    factor, label = _PRICE_UNITS[-1]
    for factor, label in _PRICE_UNITS:
        if top * factor >= Decimal("0.01"):
            break
    unit = f"per {label} tokens" if label else "per token"
    return [_significant(v * factor) for v in values], unit
