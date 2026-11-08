"""hyvo publish: local verification first, exact bytes sent, API answers mapped (no network)."""

from __future__ import annotations

import copy
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar

import httpx
import pytest
from typer.testing import CliRunner

from hyvo.cli import app
from hyvo.publish import PublishError, copy_problems, publish_run
from hyvo.report.guard import REMOVED_TEXT
from hyvo.runfile import hash_run, scenario_hash, summarize_run

GOLDEN = Path(__file__).resolve().parents[2] / "fixtures" / "golden-run.json"
TOKEN = "test-runner-token"


def _api(status: int, body: dict, seen: list[httpx.Request]) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, json=body)

    return httpx.Client(transport=httpx.MockTransport(handler))


def _published(golden: dict) -> dict:
    return {"runId": golden["runId"], "hash": golden["hash"], "publishedAt": "2026-11-03T12:00:00Z"}


@pytest.fixture(scope="module")
def golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding="utf-8"))


def test_a_new_run_is_published_with_its_exact_bytes(golden: dict) -> None:
    seen: list[httpx.Request] = []
    result = publish_run(GOLDEN, "http://api.test/", TOKEN, featured=True, client=_api(201, _published(golden), seen))
    assert result.created and result.run_id == golden["runId"] and result.hash == golden["hash"]
    [request] = seen
    assert str(request.url) == "http://api.test/internal/runs/publish"
    assert request.headers["Authorization"] == f"Bearer {TOKEN}"
    line, _, body = request.content.partition(b"\n")
    assert body == GOLDEN.read_bytes()
    meta = json.loads(line)
    assert meta == {
        "hash": golden["hash"],
        "sha256": hashlib.sha256(body).hexdigest(),
        "summary": summarize_run(golden),
        "scenarioHash": scenario_hash(golden["scenario"]),
        "featured": True,
    }


def test_a_run_that_breaks_the_copy_rules_is_refused_before_anything_is_sent(golden: dict, tmp_path: Path) -> None:
    run = copy.deepcopy(golden)
    run["rounds"][0]["posts"][0]["text"] = "GLINT is a winner! We'll see the returns."
    del run["hash"]
    run["hash"] = hash_run(run)
    path = tmp_path / "run.json"
    path.write_text(json.dumps(run), encoding="utf-8")
    seen: list[httpx.Request] = []
    with pytest.raises(PublishError, match="copy rules"):
        publish_run(path, "http://api.test", TOKEN, client=_api(201, _published(run), seen))
    assert seen == []


def test_a_post_the_review_removed_does_not_count_against_a_run(golden: dict) -> None:
    run = copy.deepcopy(golden)
    run["rounds"][0]["posts"][0]["text"] = REMOVED_TEXT
    assert copy_problems(run) == []
    assert copy_problems(golden) == []


def test_an_already_published_run_is_reported_as_such(golden: dict) -> None:
    result = publish_run(GOLDEN, "http://api.test", TOKEN, client=_api(200, _published(golden), []))
    assert not result.created


@pytest.mark.parametrize(
    ("status", "code"), [(401, "unauthorized"), (409, "conflict"), (400, "invalid_run"), (413, "too_large")]
)
def test_refusals_become_publish_errors(golden: dict, status: int, code: str) -> None:
    body = {"error": {"code": code, "message": "nope"}}
    with pytest.raises(PublishError, match=f"{status}.*{code}"):
        publish_run(GOLDEN, "http://api.test", TOKEN, client=_api(status, body, []))


def test_a_run_that_does_not_verify_is_never_sent(tmp_path: Path, golden: dict) -> None:
    tampered = dict(golden, createdAt="2026-01-01T00:00:00Z")  # content changed, hash not
    path = tmp_path / "run.json"
    path.write_text(json.dumps(tampered), encoding="utf-8")
    seen: list[httpx.Request] = []
    with pytest.raises(PublishError, match="does not verify locally"):
        publish_run(path, "http://api.test", TOKEN, client=_api(201, {}, seen))
    assert seen == []


class _Api(BaseHTTPRequestHandler):
    """A minimal stand-in for the Worker's publish endpoint."""

    received: ClassVar[list[tuple[str, str, bytes]]] = []

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers["Content-Length"]))
        self.received.append((self.path, self.headers.get("Authorization", ""), body))
        run = json.loads(body[body.index(10) + 1 :])  # after the metadata line
        payload = json.dumps({"runId": run["runId"], "hash": run["hash"], "publishedAt": "2026-11-03T12:00:00Z"})
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(payload.encode())

    def log_message(self, *args: object) -> None:
        pass


def test_the_cli_publishes_with_one_command(monkeypatch: pytest.MonkeyPatch, golden: dict) -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Api)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        monkeypatch.setenv("RUNNER_TOKEN", TOKEN)
        api = f"http://127.0.0.1:{server.server_port}"
        result = CliRunner().invoke(app, ["publish", str(GOLDEN), "--api", api, "--featured"])
        assert result.exit_code == 0, result.output
        assert golden["runId"] in result.output and "published as featured" in result.output
        path, auth, body = _Api.received[-1]
        assert path == "/internal/runs/publish" and auth == f"Bearer {TOKEN}"
        assert body[body.index(10) + 1 :] == GOLDEN.read_bytes()
        assert TOKEN not in result.output
    finally:
        server.shutdown()


def test_the_cli_needs_a_token_and_an_api_url(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("RUNNER_TOKEN", raising=False)
    monkeypatch.delenv("HYVO_API_URL", raising=False)
    no_url = CliRunner().invoke(app, ["publish", str(GOLDEN)])
    assert no_url.exit_code == 2 and "HYVO_API_URL" in no_url.output
    no_token = CliRunner().invoke(app, ["publish", str(GOLDEN), "--api", "http://127.0.0.1:9"])
    assert no_token.exit_code == 2 and "RUNNER_TOKEN" in no_token.output
