"""Publish a run.json to the Hyvo API (``POST /internal/runs/publish``, docs/API.md).

The file is verified locally first (hash, JSON Schema, model rules, price replay), so a broken run
never leaves the machine: on the Workers Free plan the API cannot re-check it (docs/OPEN_ITEMS.md item
21). The body is one line of JSON metadata, a newline, then the file's exact bytes: the API stores
them as published, and anyone can re-hash them. The runner token authenticates the call and never
appears in output.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from hyvo.report.guard import REMOVED_TEXT, find_violations, prose_fields
from hyvo.runfile import load_run, verify_run
from hyvo.runfile.io import RUN_FILENAME
from hyvo.runfile.summary import run_meta
from hyvo.world.verify import check_run_market

PUBLISH_PATH = "/internal/runs/publish"
TIMEOUT_S = 30.0


class PublishError(RuntimeError):
    """The run could not be published (invalid locally, or refused by the API)."""


@dataclass(frozen=True)
class PublishResult:
    run_id: str
    hash: str
    published_at: str
    created: bool  # False when this exact run was already published


def run_file(path: Path) -> Path:
    """``path`` itself, or the run.json inside a run directory."""
    return path / RUN_FILENAME if path.is_dir() else path


def publish_run(
    path: Path,
    api_url: str,
    token: str,
    *,
    featured: bool = False,
    client: httpx.Client | None = None,
) -> PublishResult:
    """Verify ``path`` locally and publish it; raise ``PublishError`` on any problem."""
    target = run_file(path)
    problems = local_problems(target)
    if problems:
        raise PublishError("the run does not verify locally: " + "; ".join(problems[:3]))
    problems = copy_problems(load_run(target))
    if problems:
        raise PublishError("the run breaks the copy rules, and publishing commits it on-chain for good: " + "; ".join(problems[:3]))
    url = api_url.rstrip("/") + PUBLISH_PATH
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/octet-stream"}
    data = target.read_bytes()
    meta = run_meta(load_run(target), data)
    line = {"hash": meta["hash"], "sha256": meta["sha256"], "summary": meta["summary"], "scenarioHash": meta["scenarioHash"]}
    if featured:
        line["featured"] = True
    body = json.dumps(line, ensure_ascii=False, allow_nan=False).encode("utf-8") + b"\n" + data
    http = client or httpx.Client(timeout=TIMEOUT_S, trust_env=False)
    try:
        response = http.post(url, content=body, headers=headers)
    except httpx.HTTPError as error:
        raise PublishError(f"cannot reach the API: {type(error).__name__}") from None
    finally:
        if client is None:
            http.close()
    if response.status_code not in (200, 201):
        raise PublishError(f"the API refused the run ({response.status_code}): {_error_text(response)}")
    body = response.json()
    return PublishResult(
        run_id=body["runId"],
        hash=body["hash"],
        published_at=body["publishedAt"],
        created=response.status_code == 201,
    )


def local_problems(target: Path) -> list[str]:
    """What is wrong with a run.json file; empty when it verifies."""
    try:
        doc = load_run(target)
    except (OSError, ValueError) as error:
        return [f"cannot read {target.name}: {error}"]
    result = verify_run(doc)
    problems = [*result.schema_errors, *result.model_errors]
    if result.expected != result.actual:
        problems.append(f"hash {result.actual} does not match its content ({result.expected})")
    return problems + check_run_market(doc)


def copy_problems(doc: Mapping[str, Any]) -> list[str]:
    """Posts and report text that break the copy rules as they stand today. A run played before a rule
    was added can break it: this is the last place to catch that."""
    problems = [
        f"post {post['id']}: {', '.join(rules)}"
        for round_ in doc["rounds"]
        for post in round_["posts"]
        if post["text"] != REMOVED_TEXT and (rules := find_violations(post["text"]))
    ]
    problems += [
        f"report {field}: {', '.join(rules)}"
        for field, text in prose_fields(doc["report"]).items()
        if (rules := find_violations(text))
    ]
    return problems


def _error_text(response: httpx.Response) -> str:
    try:
        error = response.json()["error"]
        return f"{error['code']}: {error['message']}"
    except (ValueError, KeyError, TypeError):
        return response.text[:200] or "no details"
