"""An in-memory stand-in for the Worker's runner endpoints (docs/API.md, "Runner jobs").

It is served over real HTTP, so the runner's client, backoff and retries are exercised as they
would be against ``wrangler dev``. Its state lives in this object and survives ``restart()``,
the way D1 survives a Worker restart.
"""

from __future__ import annotations

import hashlib
import json
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit

from hyvo.dryrun.document import hash_dry_run
from hyvo.runfile import hash_run
from hyvo.runfile.canonical import new_run_id

TOKEN = "test-runner-token"
MAX_BYTES = 5 * 1024 * 1024


def small_spec(**overrides: Any) -> dict[str, Any]:
    spec: dict[str, Any] = {
        "version": 1,
        "scenario": {
            "title": "Runner test: fictional token FIZZ lists",
            "seedText": "FIZZ is a fictional token made up for this test. Liquidity is thin.",
            "events": [{"round": 2, "text": "A large wallet posts that it entered early."}],
            "market": {"tokenSymbol": "FIZZ", "liquidityEth": "5", "feeBps": 100},
        },
        "agents": 6,
        "rounds": 2,
        "mix": None,
        "batchSize": 10,
        "maxCostUsd": 0.5,
        "maxLlmCalls": 100,
        "seed": 11,
    }
    spec.update(overrides)
    return spec


class FakeJobsApi:
    def __init__(self, token: str = TOKEN) -> None:
        self.token = token
        self.lock = threading.Lock()
        self.queue: list[dict[str, Any]] = []
        self.leases: dict[str, str] = {}  # runId -> the lease currently allowed
        self.held: dict[str, dict[str, Any]] = {}  # runId -> the job as it was claimed
        self.attempts: dict[str, int] = {}
        self.heartbeats: list[tuple[str, dict[str, Any]]] = []
        self.uploads: dict[str, bytes] = {}
        self.upload_headers: list[dict[str, str]] = []
        self.completed: dict[str, str] = {}  # runId -> hash
        self.completes: list[dict[str, Any]] = []  # bodies of the accepted complete calls
        self.failures: list[dict[str, Any]] = []
        self.lose_lease_after: int | None = None  # heartbeats answered before 409 lease_lost
        self.next_status: int | None = None  # force one answer of GET /internal/jobs/next
        self.on_claim: Callable[[str], None] | None = None
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self.port = 0
        self._lease_counter = 0

    # --- lifecycle --------------------------------------------------------------------------

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> FakeJobsApi:
        api = self

        class Handler(_Handler):
            fake = api

        self._server = ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        self._server.daemon_threads = True
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def restart_after(self, delay_s: float) -> threading.Thread:
        """Stop now and come back on the same port after ``delay_s`` (state kept)."""
        self.stop()
        timer = threading.Timer(delay_s, self.start)
        timer.start()
        return timer

    # --- queue ------------------------------------------------------------------------------

    def add_job(
        self,
        spec: dict[str, Any] | None = None,
        *,
        run_id: str | None = None,
        timeout_s: float = 600,
        heartbeat_s: float = 0.5,
        kind: str | None = None,
    ) -> str:
        run_id = run_id or new_run_id()
        with self.lock:
            self.queue.append(
                {"runId": run_id, "spec": spec or small_spec(), "timeoutS": timeout_s, "heartbeatIntervalS": heartbeat_s, **({"kind": kind} if kind else {})}
            )
        return run_id

    def take_back(self, run_id: str) -> None:
        """What the Worker's sweep does to a job whose runner went quiet: its lease ends and it is queued again."""
        with self.lock:
            self.leases.pop(run_id, None)
            self.queue.append(self.held[run_id])

    def claim(self) -> dict[str, Any] | None:
        with self.lock:
            if not self.queue:
                return None
            entry = self.queue.pop(0)
            run_id = entry["runId"]
            self.held[run_id] = entry
            self._lease_counter += 1
            lease = f"lease_{self._lease_counter:016d}"
            self.leases[run_id] = lease
            self.attempts[run_id] = self.attempts.get(run_id, 0) + 1
            job = {
                "runId": run_id,
                "leaseId": lease,
                "attempt": self.attempts[run_id],
                "heartbeatIntervalS": entry["heartbeatIntervalS"],
                "timeoutS": entry["timeoutS"],
                "spec": entry["spec"],
                **({"kind": entry["kind"]} if "kind" in entry else {}),
            }
        if self.on_claim is not None:
            self.on_claim(run_id)
        return job


class _Handler(BaseHTTPRequestHandler):
    fake: FakeJobsApi

    def log_message(self, format: str, *args: Any) -> None:
        pass

    # --- routing ----------------------------------------------------------------------------

    def do_GET(self) -> None:
        if not self._authorized():
            return
        if urlsplit(self.path).path != "/internal/jobs/next":
            return self._error(404, "not_found", "no such endpoint")
        if self.fake.next_status is not None:
            status, self.fake.next_status = self.fake.next_status, None
            return self._error(status, "forced", "forced answer")
        job = self.fake.claim()
        if job is None:
            self.send_response(204)
            self.end_headers()
            return None
        return self._json(200, {"job": job})

    def do_PUT(self) -> None:
        parts = urlsplit(self.path)
        segments = parts.path.strip("/").split("/")
        if len(segments) != 2 or segments[0] != "uploads" or parts.query != "sig=ok":
            return self._error(403, "bad_signature", "the upload link is not valid")
        self.fake.upload_headers.append(dict(self.headers))
        data = self._body()
        with self.fake.lock:
            self.fake.uploads[segments[1]] = data
        return self._json(200, {"size": len(data)})

    def do_POST(self) -> None:
        if not self._authorized():
            return None
        segments = urlsplit(self.path).path.strip("/").split("/")
        if len(segments) != 4 or segments[:2] != ["internal", "jobs"]:
            return self._error(404, "not_found", "no such endpoint")
        run_id, action = segments[2], segments[3]
        body = json.loads(self._body() or b"{}")
        fake = self.fake
        with fake.lock:
            if fake.leases.get(run_id) != body.get("leaseId"):
                return self._error(409, "lease_lost", "this runner no longer holds the job")
            if action == "heartbeat":
                fake.heartbeats.append((run_id, body))
                beats = sum(1 for rid, _ in fake.heartbeats if rid == run_id)
                if fake.lose_lease_after is not None and beats > fake.lose_lease_after:
                    fake.leases.pop(run_id, None)
                    return self._error(409, "lease_lost", "the job went back to the queue")
                return self._json(200, {"ok": True})
            if action == "upload-url":
                return self._json(
                    200,
                    {
                        "url": f"{fake.url}/uploads/{run_id}?sig=ok",
                        "method": "PUT",
                        "expiresAt": "2099-01-01T00:00:00Z",
                        "maxBytes": MAX_BYTES,
                    },
                )
            if action == "complete":
                return self._complete(run_id, body)
            if action == "fail":
                retry = bool(body.get("retryable", True)) and fake.attempts.get(run_id, 1) < 2
                fake.failures.append({"runId": run_id, **body})
                fake.leases.pop(run_id, None)
                return self._json(200, {"status": "queued" if retry else "failed"})
        return self._error(404, "not_found", "no such endpoint")

    def _complete(self, run_id: str, body: dict[str, Any]) -> None:
        fake = self.fake
        data = fake.uploads.get(run_id)
        if data is None:
            return self._error(422, "missing_upload", "run.json was not uploaded")
        doc = json.loads(data)
        if doc.get("runId") != run_id:
            return self._error(422, "invalid_run", "the run carries another runId")
        expected = hash_dry_run(doc) if doc.get("kind") == "dryrun" else hash_run(doc)
        if expected != doc.get("hash") or doc.get("hash") != body.get("hash"):
            return self._error(422, "hash_mismatch", "the hash does not match the uploaded run")
        if hashlib.sha256(data).hexdigest() != body.get("sha256"):
            return self._error(422, "run_mismatch", "the sha256 is not the upload's")
        fake.completes.append(body)
        fake.completed[run_id] = body["hash"]
        fake.leases.pop(run_id, None)
        return self._json(200, {"status": "complete"})

    # --- plumbing ---------------------------------------------------------------------------

    def _authorized(self) -> bool:
        if self.headers.get("Authorization") == f"Bearer {self.fake.token}":
            return True
        self._error(401, "unauthorized", "a valid runner token is required")
        return False

    def _body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _json(self, status: int, value: Any) -> None:
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _error(self, status: int, code: str, message: str) -> None:
        self._json(status, {"error": {"code": code, "message": message}})
