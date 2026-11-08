"""``dryrun.json``: the record of a Dry Run, hashed the way a run is (RFC 8785, keccak-256), so a report can be checked and cited.

It holds the contract's ABI and address, every call with its revert reason, gas and state changes, and the findings. Its own schema is in
``packages/schema/src/dryrun.ts``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from hyvo.runfile.canonical import canonical_json, keccak256_hex
from hyvo.runfile.models import DISCLAIMER

from .abi import ActionSpace
from .spec import DryRunSpec

FILENAME = "dryrun.json"
NOT_AN_AUDIT = "A Dry Run is not an audit: it finds what its synthetic users happened to run into."


def hash_dry_run(document: Mapping[str, Any]) -> str:
    body = {key: value for key, value in document.items() if key != "hash"}
    return keccak256_hex(canonical_json(body).encode("utf-8"))


def dry_run_document(
    *,
    run_id: str,
    created_at: str,
    status: str,
    stop_reason: str | None,
    spec: DryRunSpec,
    target: Mapping[str, Any],
    crowd: Mapping[str, Any],
    space: ActionSpace,
    calls: Sequence[Mapping[str, Any]],
    rounds: Sequence[Mapping[str, Any]],
    invariants: Sequence[Mapping[str, Any]],
    probes: Sequence[Mapping[str, Any]],
    findings: Sequence[Mapping[str, Any]],
    feedback: Sequence[Mapping[str, Any]],
    final_state: Mapping[str, Any],
    usage: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "runId": run_id,
        "kind": "dryrun",
        "version": 1,
        "createdAt": created_at,
        "status": status,
        "stopReason": stop_reason,
        "description": spec.description,
        "target": dict(target),
        "crowd": dict(crowd),
        "actionSpace": {
            "functions": [function.signature for function in space.actions],
            "keptForTheOwner": [function.signature for function in space.admin],
            "reads": [function.name for function in space.reads],
        },
        "rounds": [dict(item) for item in rounds],
        "calls": [dict(call) for call in calls],
        "invariants": [dict(item) for item in invariants],
        "probes": [dict(item) for item in probes],
        "findings": [dict(item) for item in findings],
        "feedback": [dict(item) for item in feedback],
        "finalState": dict(final_state),
        "usage": dict(usage),
        "disclaimer": f"{DISCLAIMER} {NOT_AN_AUDIT}",
    }


def write_dry_run(folder: Path, document: dict[str, Any]) -> Path:
    document = {**document, "hash": hash_dry_run(document)}
    path = folder / FILENAME
    path.write_text(canonical_json(document), encoding="utf-8", newline="\n")
    return path


def dry_run_problems(document: Mapping[str, Any]) -> list[str]:
    """What is wrong with a written report; empty when it holds together."""
    problems = []
    if document.get("kind") != "dryrun" or document.get("version") != 1:
        problems.append("this is not a dryrun.json of version 1")
        return problems
    if hash_dry_run(document) != document.get("hash"):
        problems.append("its hash does not match its content")
    if DISCLAIMER not in str(document.get("disclaimer", "")):
        problems.append("the disclaimer is missing")
    return problems


def dry_run_meta(document: Mapping[str, Any], data: bytes) -> dict[str, Any]:
    """What the runner reports about a delivered report."""
    import hashlib

    findings = document["findings"]
    counts = {level: sum(1 for finding in findings if finding["severity"] == level) for level in ("high", "medium", "low", "info")}
    return {
        "hash": document["hash"],
        "sha256": hashlib.sha256(data).hexdigest(),
        "summary": {
            "status": document["status"],
            "findings": counts,
            "calls": len(document["calls"]),
            "reverted": sum(1 for call in document["calls"] if call["status"] == "reverted"),
        },
        "usage": {"costUsd": document["usage"]["costUsd"], "llmCalls": document["usage"]["llmCalls"]},
    }
