"""JobsApi: requests sent, answers mapped to exceptions, no token on the upload (no network)."""

from __future__ import annotations

import json

import httpx
import pytest

from hyvo.runfile.canonical import new_run_id
from hyvo.runner import (
    ApiRejected,
    ApiUnavailable,
    JobsApi,
    LeaseLost,
    Progress,
    RunnerAuthError,
)
from hyvo.runner.api import UploadTarget
from tests.runner.fake_api import small_spec

TOKEN = "test-runner-token"
LEASE = "lease_0000000000000001"


def _client(answer: httpx.Response | Exception, seen: list[httpx.Request]) -> JobsApi:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if isinstance(answer, Exception):
            raise answer
        return answer

    return JobsApi("http://api.test/", TOKEN, client=httpx.Client(transport=httpx.MockTransport(handler)))


def _error(status: int, code: str) -> httpx.Response:
    return httpx.Response(status, json={"error": {"code": code, "message": "nope"}})


def test_an_empty_queue_is_none() -> None:
    seen: list[httpx.Request] = []
    assert _client(httpx.Response(204), seen).next_job() is None
    [request] = seen
    assert request.method == "GET" and str(request.url) == "http://api.test/internal/jobs/next"
    assert request.headers["Authorization"] == f"Bearer {TOKEN}"


def test_a_job_is_parsed() -> None:
    run_id = new_run_id()
    body = {
        "job": {
            "runId": run_id,
            "leaseId": LEASE,
            "attempt": 2,
            "heartbeatIntervalS": 15,
            "timeoutS": 1800,
            "spec": small_spec(),
        }
    }
    job = _client(httpx.Response(200, json=body), []).next_job()
    assert job is not None and job.run_id == run_id and job.attempt == 2


@pytest.mark.parametrize(
    ("answer", "error"),
    [
        (_error(401, "unauthorized"), RunnerAuthError),
        (_error(403, "forbidden"), RunnerAuthError),
        (_error(409, "lease_lost"), LeaseLost),
        (_error(409, "conflict"), ApiRejected),
        (_error(422, "invalid_run"), ApiRejected),
        (_error(429, "rate_limited"), ApiUnavailable),
        (httpx.Response(500, text="boom"), ApiUnavailable),
        (httpx.Response(503), ApiUnavailable),
        (httpx.ConnectError("refused"), ApiUnavailable),
        (httpx.ReadTimeout("slow"), ApiUnavailable),
        (httpx.Response(200, text="<html>"), ApiUnavailable),
    ],
)
def test_answers_map_to_exceptions(answer: httpx.Response | Exception, error: type[Exception]) -> None:
    with pytest.raises(error):
        _client(answer, []).complete(new_run_id(), LEASE, {"hash": "0x" + "0" * 64})


def test_heartbeat_sends_the_lease_and_progress() -> None:
    seen: list[httpx.Request] = []
    run_id = new_run_id()
    _client(httpx.Response(200, json={"ok": True}), seen).heartbeat(run_id, LEASE, Progress(3, 10))
    [request] = seen
    assert str(request.url) == f"http://api.test/internal/jobs/{run_id}/heartbeat"
    assert json.loads(request.content) == {"leaseId": LEASE, "progress": {"round": 3, "rounds": 10}}


def test_fail_caps_the_reason_and_returns_the_status() -> None:
    seen: list[httpx.Request] = []
    status = _client(httpx.Response(200, json={"status": "queued"}), seen).fail(
        new_run_id(), LEASE, "x" * 2000, retryable=False
    )
    assert status == "queued"
    body = json.loads(seen[0].content)
    assert len(body["reason"]) == 500 and body["retryable"] is False


def test_the_upload_carries_no_runner_token() -> None:
    seen: list[httpx.Request] = []
    target = UploadTarget("http://api.test/u/1?sig=s", "PUT", {"X-Extra": "1"}, "", 10)
    _client(httpx.Response(200, json={"size": 2}), seen).upload(target, b"{}")
    [request] = seen
    assert request.method == "PUT" and "Authorization" not in request.headers
    assert request.headers["X-Extra"] == "1" and request.content == b"{}"


def test_a_refused_upload_link_is_retryable() -> None:
    target = UploadTarget("http://api.test/u/1?sig=old", "PUT", {}, "", 10)
    with pytest.raises(ApiUnavailable, match="upload link was refused"):
        _client(_error(403, "expired"), []).upload(target, b"{}")


def test_upload_url_is_read() -> None:
    answer = httpx.Response(
        200, json={"url": "http://api.test/u", "method": "PUT", "expiresAt": "2099-01-01T00:00:00Z", "maxBytes": 5}
    )
    target = _client(answer, []).upload_url(new_run_id(), LEASE)
    assert (target.url, target.method, target.max_bytes) == ("http://api.test/u", "PUT", 5)
    with pytest.raises(ApiUnavailable, match="malformed"):
        _client(httpx.Response(200, json={"method": "PUT"}), []).upload_url(new_run_id(), LEASE)
