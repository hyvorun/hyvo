"""HTTP client for the runner endpoints of the Hyvo API (docs/API.md, "Runner jobs").

Every call but the upload sends ``Authorization: Bearer <RUNNER_TOKEN>``. The upload goes to the
signed URL the API returns and carries no token: the signature authorizes it, and the token never
travels to a host other than the API's. Answers are mapped to exceptions:

- ``ApiUnavailable``: the API could not be reached, timed out, or answered 429/5xx. Retry later.
- ``LeaseLost``: 409 ``lease_lost``; the job went back to the queue or was finished elsewhere.
- ``RunnerAuthError``: 401/403; the token is wrong. Retrying cannot help.
- ``ApiRejected``: any other refusal, with the API's error code and message.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Self

import httpx

from .models import Job, parse_job

TIMEOUT_S = 30.0
UPLOAD_TIMEOUT_S = 120.0


class ApiUnavailable(RuntimeError):
    """The API did not answer usefully; the call may succeed later."""


class ApiRejected(RuntimeError):
    """The API refused the call."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code


class LeaseLost(ApiRejected):
    """This runner no longer holds the job."""


class RunnerAuthError(ApiRejected):
    """The runner token was refused."""


@dataclass(frozen=True)
class Progress:
    round: int
    rounds: int


@dataclass(frozen=True)
class UploadTarget:
    url: str
    method: str
    headers: dict[str, str]
    expires_at: str
    max_bytes: int


class JobsApi:
    def __init__(
        self, base_url: str, token: str, *, client: httpx.Client | None = None
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._token = token
        self._own_client = client is None
        self._http = client or httpx.Client(timeout=TIMEOUT_S, trust_env=False)

    def close(self) -> None:
        if self._own_client:
            self._http.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # --- calls ------------------------------------------------------------------------------

    def next_job(self) -> Job | None:
        """Claim the next queued job; ``None`` when there is none or the queue is paused."""
        response = self._call("GET", "/internal/jobs/next")
        if response.status_code == 204:
            return None
        return parse_job(_json(response).get("job"))

    def heartbeat(self, run_id: str, lease_id: str, progress: Progress | None = None) -> None:
        body: dict[str, Any] = {"leaseId": lease_id}
        if progress is not None:
            body["progress"] = {"round": progress.round, "rounds": progress.rounds}
        self._call("POST", f"/internal/jobs/{run_id}/heartbeat", json=body)

    def upload_url(self, run_id: str, lease_id: str) -> UploadTarget:
        body = _json(self._call("POST", f"/internal/jobs/{run_id}/upload-url", json={"leaseId": lease_id}))
        try:
            return UploadTarget(
                url=str(body["url"]),
                method=str(body.get("method", "PUT")),
                headers={str(k): str(v) for k, v in dict(body.get("headers") or {}).items()},
                expires_at=str(body.get("expiresAt", "")),
                max_bytes=int(body.get("maxBytes", 0)),
            )
        except (KeyError, TypeError, ValueError):
            raise ApiUnavailable("the upload-url answer is malformed") from None

    def upload(self, target: UploadTarget, data: bytes) -> None:
        """Send run.json to the signed URL (no runner token)."""
        headers = {"Content-Type": "application/json", **target.headers}
        try:
            response = self._http.request(
                target.method, target.url, content=data, headers=headers, timeout=UPLOAD_TIMEOUT_S
            )
        except httpx.HTTPError as error:
            raise ApiUnavailable(f"upload failed: {type(error).__name__}") from None
        if response.status_code == 403:  # an expired or bad link: ask for a new one and retry
            raise ApiUnavailable(f"the upload link was refused: {_error(response)[1]}")
        _check(response)

    def complete(self, run_id: str, lease_id: str, meta: Mapping[str, Any]) -> dict[str, Any]:
        """Publish the uploaded run; ``meta`` is ``hyvo.runfile.run_meta`` of its exact bytes."""
        body = {"leaseId": lease_id, **meta}
        return _json(self._call("POST", f"/internal/jobs/{run_id}/complete", json=body))

    def fail(self, run_id: str, lease_id: str, reason: str, *, retryable: bool = True) -> str:
        """Report a failed attempt; returns the job's new status (``queued`` or ``failed``)."""
        body = {"leaseId": lease_id, "reason": reason[:500], "retryable": retryable}
        answer = _json(self._call("POST", f"/internal/jobs/{run_id}/fail", json=body))
        return str(answer.get("status", "unknown"))

    # --- plumbing ---------------------------------------------------------------------------

    def _call(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        headers = {"Authorization": f"Bearer {self._token}"}
        try:
            response = self._http.request(method, self.base_url + path, headers=headers, **kwargs)
        except httpx.HTTPError as error:
            raise ApiUnavailable(f"cannot reach the API: {type(error).__name__}") from None
        _check(response)
        return response


def _check(response: httpx.Response) -> None:
    status = response.status_code
    if status < 300:
        return
    if status == 429 or status >= 500:
        raise ApiUnavailable(f"the API answered {status}")
    code, message = _error(response)
    if status in (401, 403):
        raise RunnerAuthError(status, code, message)
    if status == 409 and code == "lease_lost":
        raise LeaseLost(status, code, message)
    raise ApiRejected(status, code, message)


def _error(response: httpx.Response) -> tuple[str, str]:
    try:
        error = response.json()["error"]
        return str(error["code"]), str(error["message"])
    except (ValueError, KeyError, TypeError):
        return "http_error", response.text[:200] or "no details"


def _json(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        raise ApiUnavailable("the API answered with something that is not JSON") from None
    if not isinstance(body, dict):
        raise ApiUnavailable("the API answered with JSON that is not an object")
    return body
