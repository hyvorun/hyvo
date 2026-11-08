"""One anvil node per job: a free port on 127.0.0.1, its own data dir, an optional fork and a
teardown that always runs.

anvil flags (Foundry 1.7.1, from ``anvil --help``):

- ``--host 127.0.0.1 --port <free port> --chain-id 4663``
- ``--auto-impersonate``: any address can send transactions, so agent wallets need no keys.
- ``--gas-price 0 --block-base-fee-per-gas 0 --disable-min-priority-fee``: a zero base fee and a
  zero ``eth_gasPrice``. Hyvo sends every transaction with ``gasPrice: 0``, so ETH balances move
  only through trades. (Without ``--disable-min-priority-fee``, a transaction without a gas price
  would pay anvil's 1 gwei minimum tip.)
- ``--cache-path <data dir>/state``: any state anvil persists to disk stays inside the data dir.
- ``--fork-url``/``--fork-block-number`` only when a fork URL is given (``RH_RPC_URL``; empty
  means a plain local chain). A loopback fork URL also gets ``--no-storage-caching``: a local
  node's state is not fixed per block number, so it must not enter the shared Foundry RPC cache
  (``~/.foundry/cache/rpc/<chain>/<block>``).

The data dir ``engine/.anvil/<owner pid>-<id>/`` (gitignored) holds ``anvil.log``. ``stop()``
kills the process tree, checks that it is gone and deletes the data dir. It is idempotent and runs
on ``with`` exit, and an ``atexit`` hook stops every instance still running when the interpreter
exits.

A hard kill of the owner (Task Manager, OOM, a native crash) skips all of that, so anvil is also
bound to its owner by the OS: on Windows it joins a job object that kills its processes when the
owner's last handle to it closes (``JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE``); on Linux it gets
``PR_SET_PDEATHSIG``. As a last resort, the first ``start()`` of a process sweeps the base dir:
anvil processes of dead owners are killed and their data dirs deleted.

Forks: ``fallback_fork_url`` (``RH_RPC_URL_FALLBACK``) is passed as a second ``--fork-url`` (anvil
spreads requests across them), and a forked start that fails is retried twice: a flaky public RPC
can fail a start that works a second later. Fork URLs may carry API keys, so they never appear in
``repr``, logs or error messages.
"""

from __future__ import annotations

import atexit
import contextlib
import http.client
import json
import logging
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from pathlib import Path
from typing import IO, Any, Self, TypeVar
from urllib.parse import urlsplit

import psutil
import requests
from web3 import HTTPProvider, Web3

from hyvo.config import ENGINE_ROOT, Settings, load_settings

CHAIN_ID = 4663
DEFAULT_BASE_DIR = ENGINE_ROOT / ".anvil"
LOG_NAME = "anvil.log"

_HOST = "127.0.0.1"
_PORT_ATTEMPTS = 5
_POLL_SECONDS = 0.05
_KILL_TIMEOUT = 10.0
_REMOVE_TIMEOUT = 10.0
_RPC_TIMEOUT = 60.0
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
_FORK_START_ATTEMPTS = 3  # a flaky fork RPC can fail a start that works a second later
_RETRY_BACKOFF_S = 1.0
_DATA_DIR_NAME = re.compile(r"^(?P<pid>[0-9]+)-[0-9a-f]+$")
log = logging.getLogger(__name__)
_PORT_IN_USE = re.compile(
    r"already in use|only one usage of each socket address|os error (?:10048|98|48)\b",
    re.IGNORECASE,
)
# A local RPC call never goes through an HTTP proxy configured in the environment.
_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_T = TypeVar("_T")


class AnvilError(RuntimeError):
    """anvil could not start, answered unexpectedly, or did not stop."""


class _PortTaken(Exception):
    """Another process holds the chosen port; start again on a new one."""


class AnvilInstance:
    """A private anvil node for one job. Use it as a context manager, or call ``start``/``stop``.

    An instance starts once; create a new one for the next job.
    """

    def __init__(
        self,
        fork_url: str | None = None,
        fork_block_number: int | None = None,
        *,
        fallback_fork_url: str | None = None,
        chain_id: int = CHAIN_ID,
        base_dir: Path | str = DEFAULT_BASE_DIR,
        anvil_path: str | None = None,
        startup_timeout: float = 30.0,
    ) -> None:
        fork_url = (fork_url or "").strip() or None
        fallback_fork_url = (fallback_fork_url or "").strip() or None
        if fallback_fork_url is not None and fork_url is None:
            raise ValueError("fallback_fork_url needs a fork_url")
        if fork_block_number is not None:
            if fork_url is None:
                raise ValueError("fork_block_number needs a fork_url")
            if isinstance(fork_block_number, bool) or fork_block_number < 0:
                raise ValueError(
                    f"fork_block_number must be a block number, got {fork_block_number}"
                )
        self.chain_id = chain_id
        self.id = f"{os.getpid()}-{uuid.uuid4().hex[:10]}"
        self.data_dir = Path(base_dir) / self.id
        self._fork_url = fork_url
        self._fallback_fork_url = fallback_fork_url
        self._fork_block_number = fork_block_number
        self._anvil_path = anvil_path
        self._startup_timeout = startup_timeout
        self._lock = threading.Lock()
        self._state = "new"  # new -> starting -> running -> stopped
        self._created_dir = False
        self._proc: subprocess.Popen[bytes] | None = None
        self._create_time: float | None = None
        self._log: IO[bytes] | None = None
        self._session: requests.Session | None = None
        self._w3: Web3 | None = None
        self._port: int | None = None
        self._fork_block: int | None = None

    @classmethod
    def from_settings(cls, settings: Settings | None = None, **kwargs: Any) -> AnvilInstance:
        """An instance that forks ``RH_RPC_URL`` (with ``RH_RPC_URL_FALLBACK`` as a second fork
        URL) when it is set, else a plain local chain."""
        settings = load_settings() if settings is None else settings
        if settings.rh_rpc_url:
            kwargs.setdefault("fallback_fork_url", settings.rh_rpc_url_fallback)
        return cls(fork_url=settings.rh_rpc_url, **kwargs)

    def __enter__(self) -> Self:
        if self._state == "new":
            self.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.stop()

    def __repr__(self) -> str:
        return (
            f"AnvilInstance(id={self.id!r}, state={self._state!r}, port={self._port}, "
            f"forked={self.forked})"
        )

    # -- lifecycle -----------------------------------------------------------------------------

    def start(self) -> AnvilInstance:
        """Start anvil and wait until it answers ``eth_chainId`` with the expected chain id."""
        with self._lock:
            if self._state != "new":
                raise AnvilError(f"this instance is {self._state}; an AnvilInstance starts once")
            self._state = "starting"
        _register(self)
        try:
            binary = self._anvil_path or shutil.which("anvil")
            if binary is None:
                raise AnvilError("anvil not found on PATH; install Foundry (foundryup)")
            _sweep_once(self.data_dir.parent)
            self.data_dir.mkdir(parents=True)
            self._created_dir = True
            self._log = open(self.data_dir / LOG_NAME, "ab")  # noqa: SIM115 - closed by stop()
            attempts = _FORK_START_ATTEMPTS if self.forked else 1
            for attempt in range(1, attempts + 1):
                try:
                    self._launch_on_free_port(binary)
                    break
                except AnvilError as error:
                    if attempt == attempts:
                        raise
                    log.warning("anvil start attempt %d failed, retrying: %s", attempt, error)
                    time.sleep(_RETRY_BACKOFF_S * attempt)
        except BaseException:
            self.stop()
            raise
        with self._lock:
            if self._state == "starting":
                self._state = "running"
        return self

    def stop(self) -> None:
        """Kill anvil and its child processes, check they are gone and delete the data dir.

        Safe to call more than once, before ``start`` and after a failed start.
        """
        with self._lock:
            if self._state == "stopped":
                return
            self._state = "stopped"
            proc, self._proc = self._proc, None
            session, self._session = self._session, None
            self._w3 = None
        try:
            if proc is not None:
                _kill_tree(proc, self._create_time)
        finally:
            if session is not None:
                session.close()
            if self._log is not None:
                self._log.close()
                self._log = None
            if self._created_dir:
                _remove_dir(self.data_dir)
            _unregister(self)

    # -- properties ----------------------------------------------------------------------------

    @property
    def running(self) -> bool:
        proc = self._proc
        return self._state == "running" and proc is not None and proc.poll() is None

    @property
    def forked(self) -> bool:
        return self._fork_url is not None

    @property
    def fork_block(self) -> int | None:
        """The block anvil forked at (an int once a forked instance started), else None."""
        return self._fork_block

    @property
    def port(self) -> int:
        return self._while_running(self._port)

    @property
    def rpc_url(self) -> str:
        return f"http://{_HOST}:{self.port}"

    @property
    def w3(self) -> Web3:
        """A web3 client for this node (HTTP, no proxies, no retries)."""
        return self._while_running(self._w3)

    @property
    def pid(self) -> int:
        return self._while_running(self._proc).pid

    @property
    def log_path(self) -> Path:
        return self.data_dir / LOG_NAME

    # -- internals -----------------------------------------------------------------------------

    def _while_running(self, value: _T | None) -> _T:
        if self._state != "running" or value is None:
            raise AnvilError(f"anvil is not running (instance is {self._state})")
        return value

    def _launch_on_free_port(self, binary: str) -> None:
        for _ in range(_PORT_ATTEMPTS):
            try:
                self._launch(binary, _free_port())
                return
            except _PortTaken:
                continue
        raise AnvilError(f"no free port found in {_PORT_ATTEMPTS} attempts")

    def _command(self, binary: str, port: int) -> list[str]:
        command = [
            binary,
            "--host", _HOST,
            "--port", str(port),
            "--chain-id", str(self.chain_id),
            "--auto-impersonate",
            "--gas-price", "0",
            "--block-base-fee-per-gas", "0",
            "--disable-min-priority-fee",
            "--cache-path", str(self.data_dir / "state"),
        ]  # fmt: skip
        if self._fork_url is not None:
            command += ["--fork-url", self._fork_url]
            if self._fallback_fork_url is not None:
                command += ["--fork-url", self._fallback_fork_url]
            if self._fork_block_number is not None:
                command += ["--fork-block-number", str(self._fork_block_number)]
            if urlsplit(self._fork_url).hostname in _LOOPBACK_HOSTS:
                command.append("--no-storage-caching")
        return command

    def _launch(self, binary: str, port: int) -> None:
        try:
            self._proc = proc = subprocess.Popen(
                self._command(binary, port),
                stdin=subprocess.DEVNULL,
                stdout=self._log,
                stderr=subprocess.STDOUT,
                cwd=self.data_dir,
                # one prebound libc call, no imports: safe enough between fork and exec
                preexec_fn=_die_with_parent if _PRCTL is not None else None,  # noqa: PLW1509
            )
        except OSError as error:
            raise AnvilError(f"cannot run {binary}: {error}") from error
        _bind_to_owner(proc)
        with contextlib.suppress(psutil.NoSuchProcess):
            self._create_time = psutil.Process(proc.pid).create_time()
        try:
            self._wait_ready(proc, port)
        except (_PortTaken, AnvilError):
            self._proc = None
            _kill_tree(proc, self._create_time)
            raise
        url = f"http://{_HOST}:{port}"
        self._port = port
        self._session = requests.Session()
        self._session.trust_env = False  # no proxies for a local node
        self._w3 = Web3(
            HTTPProvider(
                url,
                request_kwargs={"timeout": _RPC_TIMEOUT},
                session=self._session,
                exception_retry_configuration=None,
            )
        )
        if self._fork_url is not None:
            fork_config = _rpc(url, "anvil_nodeInfo", timeout=_RPC_TIMEOUT)["forkConfig"]
            self._fork_block = _as_int(fork_config["forkBlockNumber"])

    def _wait_ready(self, proc: subprocess.Popen[bytes], port: int) -> None:
        url = f"http://{_HOST}:{port}"
        deadline = time.monotonic() + self._startup_timeout
        while True:
            if proc.poll() is not None:
                tail = self._log_tail()
                if _PORT_IN_USE.search(tail):
                    raise _PortTaken
                raise AnvilError(
                    f"anvil exited with code {proc.returncode} while starting:\n{tail}"
                )
            try:
                answer = _rpc(url, "eth_chainId", timeout=1.0)
            except (OSError, http.client.HTTPException, ValueError):
                answer = None  # not listening yet
            if answer is not None:
                if not _listens(proc.pid, port):
                    raise _PortTaken  # another process answered on this port
                if _as_int(answer) != self.chain_id:
                    raise AnvilError(
                        f"anvil reports chain id {_as_int(answer)}, expected {self.chain_id}"
                    )
                return
            if time.monotonic() >= deadline:
                raise AnvilError(
                    f"anvil did not answer within {self._startup_timeout} s:\n{self._log_tail()}"
                )
            time.sleep(_POLL_SECONDS)

    def _log_tail(self, size: int = 2000) -> str:
        """The end of anvil.log, with the fork URL masked."""
        try:
            with open(self.log_path, "rb") as log:
                log.seek(0, os.SEEK_END)
                log.seek(max(0, log.tell() - size))
                text = log.read().decode("utf-8", errors="replace")
        except OSError:
            return ""
        for url in (self._fork_url, self._fallback_fork_url):
            if url:
                text = text.replace(url, "<fork-url>")
        return text


# -- process registry (atexit safety net) -------------------------------------------------------

_live: set[AnvilInstance] = set()
_live_lock = threading.Lock()


def _register(instance: AnvilInstance) -> None:
    with _live_lock:
        _live.add(instance)


def _unregister(instance: AnvilInstance) -> None:
    with _live_lock:
        _live.discard(instance)


@atexit.register
def stop_all() -> None:
    """Stop every instance that is still running. Runs automatically at interpreter exit."""
    with _live_lock:
        instances = list(_live)
    for instance in instances:
        with contextlib.suppress(Exception):
            instance.stop()


# -- owner binding and stale sweep ---------------------------------------------------------------

_job: int | None = None  # Windows job object; its handle lives (and closes) with this process
_job_lock = threading.Lock()
_swept: set[Path] = set()
_sweep_lock = threading.Lock()


def _bind_to_owner(proc: subprocess.Popen[bytes]) -> None:
    """On Windows, put ``proc`` in this process's kill-on-close job object, so the OS kills it
    when this process dies however it dies. (Linux uses ``_die_with_parent`` instead.)"""
    if sys.platform != "win32":
        return
    import ctypes

    job = _windows_job()
    handle = getattr(proc, "_handle", None)
    if job is None or handle is None:
        return
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    if not kernel32.AssignProcessToJobObject(job, int(handle)):
        log.warning("could not bind anvil to this process (error %d)", ctypes.get_last_error())


def _windows_job() -> int | None:
    """This process's job object with ``JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE``, created once."""
    global _job
    with _job_lock:
        if _job is not None:
            return _job
        import ctypes
        from ctypes import wintypes

        class _Basic(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class _Extended(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", _Basic),
                ("IoInfo", ctypes.c_uint64 * 6),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = ctypes.c_void_p
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
        kernel32.SetInformationJobObject.argtypes = [
            ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        ]  # fmt: skip
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            log.warning("could not create a job object (error %d)", ctypes.get_last_error())
            return None
        info = _Extended()
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        extended_limit_information = 9  # JobObjectExtendedLimitInformation
        if not kernel32.SetInformationJobObject(
            job, extended_limit_information, ctypes.byref(info), ctypes.sizeof(info)
        ):
            log.warning("could not configure the job object (error %d)", ctypes.get_last_error())
            kernel32.CloseHandle(job)
            return None
        _job = job
        return _job


def _load_prctl() -> Any:
    if not sys.platform.startswith("linux"):
        return None
    import ctypes

    return ctypes.CDLL("libc.so.6", use_errno=True).prctl


# Loaded in the parent: between fork and exec the child must not import or allocate much.
_PRCTL = _load_prctl()
_PR_SET_PDEATHSIG = 1
_SIGKILL = 9


def _die_with_parent() -> None:  # pragma: no cover - runs in the child on Linux only
    """``preexec_fn``: the kernel sends SIGKILL to anvil when its parent dies."""
    _PRCTL(_PR_SET_PDEATHSIG, _SIGKILL)


def sweep_stale(base_dir: Path | str = DEFAULT_BASE_DIR) -> list[Path]:
    """Kill anvil processes whose owner died and delete their data dirs; return the removed dirs.

    A data dir is named ``<owner pid>-<id>``. Its owner is dead when no process has that pid any
    more (a reused pid only makes the sweep skip the dir). anvil processes are matched by their
    ``--cache-path``, which points into the data dir.
    """
    base = Path(base_dir)
    if not base.is_dir():
        return []
    removed: list[Path] = []
    for entry in sorted(base.iterdir()):
        match = _DATA_DIR_NAME.match(entry.name)
        if not entry.is_dir() or match is None:
            continue
        owner = int(match.group("pid"))
        if owner == os.getpid() or psutil.pid_exists(owner):
            continue
        state = str(entry / "state")
        orphans = []
        for process in psutil.process_iter(["cmdline"]):
            if state in (process.info.get("cmdline") or ()):
                with contextlib.suppress(psutil.Error):
                    process.kill()
                    orphans.append(process)
        psutil.wait_procs(orphans, timeout=_KILL_TIMEOUT)
        try:
            _remove_dir(entry)
        except OSError as error:
            log.warning("could not remove the stale anvil dir %s: %s", entry.name, error)
            continue
        log.info("removed stale anvil dir %s (%d orphaned processes killed)", entry.name, len(orphans))
        removed.append(entry)
    return removed


def _sweep_once(base_dir: Path) -> None:
    with _sweep_lock:
        if base_dir in _swept:
            return
        _swept.add(base_dir)
    sweep_stale(base_dir)


# -- helpers ------------------------------------------------------------------------------------


def _free_port() -> int:
    """A port free right now on 127.0.0.1 and not used by a live instance of this process."""
    with _live_lock:
        taken = {instance._port for instance in _live}
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind((_HOST, 0))
            port = sock.getsockname()[1]
        if port not in taken:
            return port


def _rpc(url: str, method: str, params: list[Any] | None = None, timeout: float = 5.0) -> Any:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []})
    request = urllib.request.Request(
        url, data=body.encode(), headers={"Content-Type": "application/json"}
    )
    with _NO_PROXY_OPENER.open(request, timeout=timeout) as response:
        reply = json.loads(response.read())
    if "error" in reply:
        raise AnvilError(f"{method} failed: {reply['error']}")
    return reply["result"]


def _as_int(value: int | str) -> int:
    return int(value, 16) if isinstance(value, str) else int(value)


def _listens(pid: int, port: int) -> bool:
    """Whether ``pid`` holds a listening TCP socket on ``port`` (True when the OS will not say)."""
    try:
        process = psutil.Process(pid)
        connections = getattr(process, "net_connections", process.connections)(kind="tcp")
    except psutil.AccessDenied:
        return True
    except psutil.NoSuchProcess:
        return False
    return any(
        conn.status == psutil.CONN_LISTEN and conn.laddr and conn.laddr.port == port
        for conn in connections
    )


def _kill_tree(proc: subprocess.Popen[bytes], create_time: float | None) -> None:
    """Kill ``proc`` and its descendants and wait until every one of them has exited."""
    if proc.poll() is None:
        try:
            root = psutil.Process(proc.pid)
            family = [root, *root.children(recursive=True)]  # collected before any kill
        except psutil.NoSuchProcess:
            family = []
        for member in family:
            with contextlib.suppress(psutil.NoSuchProcess):
                member.kill()
        _, alive = psutil.wait_procs(family, timeout=_KILL_TIMEOUT)
        if alive:
            raise AnvilError(f"anvil processes did not exit: {[p.pid for p in alive]}")
    proc.wait(timeout=_KILL_TIMEOUT)
    if create_time is not None and _same_process_running(proc.pid, create_time):
        raise AnvilError(f"anvil (pid {proc.pid}) is still running after kill")


def _same_process_running(pid: int, create_time: float) -> bool:
    """Whether ``pid`` is still the process created at ``create_time`` (a reused pid is not)."""
    try:
        process = psutil.Process(pid)
        return process.create_time() == create_time and process.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def _remove_dir(path: Path) -> None:
    """Delete ``path``, retrying while Windows still holds a handle on a file in it."""
    deadline = time.monotonic() + _REMOVE_TIMEOUT
    while path.exists():
        try:
            shutil.rmtree(path)
        except OSError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.1)
