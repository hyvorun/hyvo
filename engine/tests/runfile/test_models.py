"""RunV1 pydantic models: field formats and the cross-field rules of docs/RUN_FORMAT.md."""

from __future__ import annotations

import copy
from collections.abc import Callable
from typing import Any

import pytest

from hyvo.runfile import DISCLAIMER, RunV1, model_errors
from hyvo.runfile.models import Report

Doc = dict[str, Any]


def _errors_after(doc: Doc, change: Callable[[Doc], None]) -> list[str]:
    mutated = copy.deepcopy(doc)
    change(mutated)
    return model_errors(mutated)


def _action(doc: Doc, rnd: int, index: int) -> Doc:
    return doc["rounds"][rnd]["actions"][index]


def test_valid_run_round_trips_through_the_model(run_doc: Doc) -> None:
    assert model_errors(run_doc) == []
    dumped = RunV1.model_validate(run_doc).model_dump(by_alias=True, mode="json")
    assert dumped == run_doc


def test_disclaimer_literal_matches_the_constant() -> None:
    assert Report.model_fields["disclaimer"].annotation.__args__ == (DISCLAIMER,)


def _set(path: str, value: Any) -> Callable[[Doc], None]:
    """Build a change that sets a dotted path (list indices as integers)."""

    def change(doc: Doc) -> None:
        *parents, last = [int(p) if p.isdigit() else p for p in path.split(".")]
        target: Any = doc
        for part in parents:
            target = target[part]
        target[last] = value

    return change


def _delete(path: str) -> Callable[[Doc], None]:
    def change(doc: Doc) -> None:
        *parents, last = [int(p) if p.isdigit() else p for p in path.split(".")]
        target: Any = doc
        for part in parents:
            target = target[part]
        del target[last]

    return change


CROSS_FIELD_CASES: list[tuple[str, Callable[[Doc], None], str]] = [
    ("persona mix sum", _set("crowd.personaMix.sniper", 2), "personaMix sums to 5"),
    ("agents length", lambda d: d["crowd"]["agents"].pop(), "crowd.agents has 3 entries"),
    ("duplicate agent id", _set("crowd.agents.1.agentId", "a01"), "'a01' is duplicated"),
    ("agent id width", _set("crowd.agents.3.agentId", "a004"), "zero-padded to 2 digits"),
    ("persona count", _set("crowd.agents.0.persona", "holder"), "holder is 1, but 2 agents have it"),
    ("persona count zero", _set("crowd.agents.0.persona", "holder"), "sniper is 1, but 0 agents have it"),
    ("rounds not consecutive", _set("rounds.1.n", 3), "rounds[1].n is 3, expected 2"),
    ("sentiment per round", _set("report.sentimentByRound", [0.1]), "expected one per round (2)"),
    ("unknown post author", _set("rounds.0.posts.0.agentId", "a09"), "'a09' is not in crowd.agents"),
    ("unknown action agent", _set("rounds.0.actions.0.agentId", "a09"), "'a09' is not in crowd.agents"),
    ("duplicate post id", _set("rounds.1.posts.0.id", "p1"), "'p1' is duplicated"),
    ("reply to a later post", _set("rounds.0.posts.1.replyTo", "p3"), "does not point to an earlier post"),
    ("reply to itself", _set("rounds.1.posts.1.replyTo", "c4"), "does not point to an earlier post"),
    ("two actions for one agent", _set("rounds.1.actions.3.agentId", "a01"), "already acted in round 2"),
    ("missing action", lambda d: d["rounds"][1]["actions"].pop(), "has no action for a04"),
    ("holders above crowd size", _set("rounds.0.market.holders", 5), "exceeds crowd.size (4)"),
    ("complete with a stop reason", _set("stopReason", "timeout"), "requires stopReason null"),
    ("partial without a stop reason", _set("status", "partial"), "requires a stopReason"),
    ("turning point outside the run", _set("report.turningPoint.round", 3), "not a round of this run"),
    ("initial holders vs seeded agents", _set("crowd.agents.0.startTokens", "5"), "but 2 agents have startTokens > 0"),
]


@pytest.mark.parametrize(
    ("change", "expected"), [c[1:] for c in CROSS_FIELD_CASES], ids=[c[0] for c in CROSS_FIELD_CASES]
)
def test_cross_field_rules(run_doc: Doc, change: Callable[[Doc], None], expected: str) -> None:
    errors = _errors_after(run_doc, change)
    assert any(expected in e for e in errors), errors


def test_partial_run_with_stop_reason_is_valid(run_doc: Doc) -> None:
    run_doc.update(status="partial", stopReason="max_cost_usd")
    assert model_errors(run_doc) == []


def test_null_turning_point_and_empty_run_are_valid(run_doc: Doc) -> None:
    run_doc["report"]["turningPoint"] = None
    assert model_errors(run_doc) == []
    run_doc["rounds"] = []
    run_doc["report"]["sentimentByRound"] = []
    assert model_errors(run_doc) == []


ACTION_CASES: list[tuple[str, Callable[[Doc], None], str]] = [
    ("hold with an amount", _set("rounds.1.actions.2.amountIn", "1"), "null amountIn and amountOut"),
    ("check_market with a tx", _set("rounds.0.actions.3.txHash", "0x" + "1" * 64), "txHash must be null"),
    ("executed swap without amountOut", _set("rounds.0.actions.0.amountOut", None), "amountIn and amountOut"),
    ("swap without a txHash", _set("rounds.1.actions.1.txHash", None), "must have a txHash"),
    ("reverted hold", _set("rounds.1.actions.2.status", "reverted"), "cannot be 'reverted'"),
    ("invalid swap", _set("rounds.0.actions.0.status", "invalid"), "kind must be 'hold'"),
    ("invalid check_market", _set("rounds.0.actions.3.status", "invalid"), "kind must be 'hold'"),
    ("invalid without a note", _set("rounds.0.actions.2.note", None), "needs a note"),
    ("post id p with replyTo", _set("rounds.1.posts.1.id", "p4"), "must use a 'c<n>' id"),
    ("post id c without replyTo", _set("rounds.0.posts.0.id", "c1"), "replyTo must be set"),
]


@pytest.mark.parametrize(
    ("change", "expected"), [c[1:] for c in ACTION_CASES], ids=[c[0] for c in ACTION_CASES]
)
def test_action_and_post_rules(run_doc: Doc, change: Callable[[Doc], None], expected: str) -> None:
    errors = _errors_after(run_doc, change)
    assert any(expected in e for e in errors), errors


def test_reverted_swap_may_omit_amounts(run_doc: Doc) -> None:
    reverted = _action(run_doc, 1, 1)
    assert reverted["status"] == "reverted" and reverted["amountOut"] is None
    assert model_errors(run_doc) == []


FORMAT_CASES: list[tuple[str, Callable[[Doc], None]]] = [
    ("extra top-level member", _set("extra", 1)),
    ("extra nested member", _set("rounds.0.market.volume", "1")),
    ("snake_case member name", lambda d: d.__setitem__("run_id", d.pop("runId"))),
    ("missing nullable member", _delete("stopReason")),
    ("missing hash", _delete("hash")),
    ("altered disclaimer", _set("report.disclaimer", "Not financial advice.")),
    ("version 2", _set("version", 2)),
    ("version true", _set("version", True)),
    ("lowercase run id", _set("runId", "run_01jc8z6q3w1y2v9k7t5r4n3m2p")),
    ("run id above 128 bits", _set("runId", "run_81JC8Z6Q3W1Y2V9K7T5R4N3M2P")),
    ("run id with I", _set("runId", "run_01JC8Z6Q3W1Y2V9K7T5R4N3M2I")),
    ("timestamp with millis", _set("createdAt", "2026-11-03T10:00:00.000Z")),
    ("timestamp with offset", _set("createdAt", "2026-11-03T10:00:00+00:00")),
    ("impossible date", _set("createdAt", "2026-02-30T10:00:00Z")),
    ("trailing newline", _set("createdAt", "2026-11-03T10:00:00Z\n")),
    ("unicode digits", _set("createdAt", "٢٠٢٦-11-03T10:00:00Z")),
    ("decimal trailing zero", _set("rounds.0.market.price", "1.50")),
    ("decimal leading dot", _set("rounds.0.market.price", ".5")),
    ("decimal leading zero", _set("rounds.0.market.price", "01")),
    ("decimal exponent", _set("rounds.0.market.price", "1e-5")),
    ("negative decimal", _set("rounds.0.actions.0.amountIn", "-0.05")),
    ("decimal as number", _set("rounds.0.actions.0.amountIn", 0.05)),
    ("uppercase tx hash", _set("rounds.0.actions.0.txHash", "0x" + "AB" * 32)),
    ("short address", _set("world.token.address", "0x1234")),
    ("bad agent id", _set("crowd.agents.0.agentId", "a1")),
    ("bad handle", _set("crowd.agents.0.handle", "@Real_Person")),
    ("unknown persona", _set("crowd.agents.0.persona", "wizard")),
    ("persona mix missing a key", _delete("crowd.personaMix.panic_seller")),
    ("persona mix extra key", _set("crowd.personaMix.wizard", 0)),
    ("persona mix camelCase key", lambda d: d["crowd"]["personaMix"].__setitem__(
        "panicSeller", d["crowd"]["personaMix"].pop("panic_seller"))),
    ("empty note", _set("rounds.0.actions.2.note", "")),
    ("bad post id", _set("rounds.0.posts.0.id", "post1")),
    ("likes as string", _set("rounds.0.posts.0.likes", "2")),
    ("likes as float", _set("rounds.0.posts.0.likes", 2.0)),
    ("negative likes", _set("rounds.0.posts.0.likes", -1)),
    ("likes above 2**53 - 1", _set("rounds.0.posts.0.likes", 2**53)),
    ("chain id above 2**53 - 1", _set("world.chainId", 2**53)),
    ("sentiment above 1", _set("report.sentimentByRound", [1.5, 0.0])),
    ("unknown action kind", _set("rounds.0.actions.0.kind", "swap")),
    ("unknown status", _set("status", "done")),
    ("unknown stop reason", lambda d: d.update(status="partial", stopReason="budget")),
    ("cost not rounded", _set("usage.costUsd", 0.12345678)),
    ("negative tokens", _set("usage.inputTokens", -1)),
    ("empty title", _set("scenario.title", "")),
    ("event round 0", _set("scenario.injectedEvents.0.round", 0)),
    ("no pools", _set("world.pools", [])),
    ("fork block negative", _set("world.forkBlock", -1)),
    ("negative temperature", _set("crowd.model.temperature", -0.1)),
    ("long event text", _set("scenario.injectedEvents.0.text", "x" * 501)),
    ("missing initialMarket", _delete("world.initialMarket")),
    ("missing startEth", _delete("crowd.agents.0.startEth")),
    ("startTokens trailing zero", _set("crowd.agents.1.startTokens", "1000.0")),
    ("sentiment with 5 decimals", _set("report.sentimentByRound", [0.12345, 0.0])),
    ("summary over 1500 chars", _set("report.summary", "x" * 1501)),
    ("turning point why over 800 chars", _set("report.turningPoint.why", "x" * 801)),
    ("objection over 400 chars", _set("report.objections", ["x" * 401])),
    ("six objections", _set("report.objections", ["o"] * 6)),
    ("six price drivers", _set("report.priceDrivers", ["d"] * 6)),
]


def test_reply_to_an_earlier_reply_is_valid(run_doc: Doc) -> None:
    # c4 answers c2 (a reply in round 1), which RUN_FORMAT allows
    assert run_doc["rounds"][1]["posts"][1]["replyTo"] == "c2"
    assert model_errors(run_doc) == []


def test_report_caps_are_inclusive(run_doc: Doc) -> None:
    def at_caps(d: Doc) -> None:
        d["report"].update(summary="x" * 1500, objections=["o" * 400] * 5, priceDrivers=["d" * 400] * 5)
        d["report"]["turningPoint"]["why"] = "w" * 800
        d["report"]["sentimentByRound"] = [0.1234, -0.5]
    assert _errors_after(run_doc, at_caps) == []


@pytest.mark.parametrize("change", [c[1] for c in FORMAT_CASES], ids=[c[0] for c in FORMAT_CASES])
def test_format_violations_are_rejected(run_doc: Doc, change: Callable[[Doc], None]) -> None:
    assert _errors_after(run_doc, change) != []


def test_safe_integer_limit_is_inclusive(run_doc: Doc) -> None:
    run_doc["rounds"][0]["posts"][0]["likes"] = 2**53 - 1
    assert model_errors(run_doc) == []


@pytest.mark.parametrize("value", ["0", "10", "0.05", "123456789.000000000000000001"])
def test_decimal_strings_accepted(run_doc: Doc, value: str) -> None:
    run_doc["rounds"][0]["market"]["price"] = value
    assert model_errors(run_doc) == []


def test_lengths_count_code_points(run_doc: Doc) -> None:
    run_doc["scenario"]["title"] = "🚀" * 200  # 200 code points (400 UTF-16 units), as in zod
    assert model_errors(run_doc) == []
    run_doc["scenario"]["title"] = "🚀" * 201
    assert any(e.startswith("/scenario/title") for e in model_errors(run_doc))


def test_rules_that_zod_does_not_have_are_not_enforced(run_doc: Doc) -> None:
    run_doc["report"].update(summary="", objections=[""], flags=[""])
    run_doc["report"]["turningPoint"]["why"] = ""
    run_doc["world"]["token"].update(symbol="", name="")
    run_doc["crowd"]["model"]["temperature"] = 3.5
    assert model_errors(run_doc) == []


def test_error_locations_use_json_names(run_doc: Doc) -> None:
    run_doc["rounds"][0]["posts"][0]["replyTo"] = 7
    assert any(e.startswith("/rounds/0/posts/0/replyTo") for e in model_errors(run_doc))
