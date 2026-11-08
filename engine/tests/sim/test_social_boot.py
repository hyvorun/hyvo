"""import_oasis: light recsys stand-in, idempotency, quiet UTF-8 logging, no ./log in the CWD."""

from __future__ import annotations

import ast
import importlib.util
import json
import logging
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from types import ModuleType

import pytest

from hyvo.sim import oasis_boot
from hyvo.sim.oasis_boot import (
    FULL_IMPORT_ENV,
    LOG_FILE_NAME,
    import_oasis,
    rec_sys_random,
    rec_sys_reddit,
)

# Runs in a fresh interpreter: light import + a two-agent world, with DNS and non-loopback
# connections blocked. Prints one JSON line and nothing else.
PROBE = r"""
import asyncio, json, logging, socket, sys, time
from pathlib import Path

LOCAL = (None, "localhost", "127.0.0.1", "::1")
real_getaddrinfo, real_connect = socket.getaddrinfo, socket.socket.connect

def getaddrinfo(host, *args, **kwargs):
    if host not in LOCAL:
        raise OSError(f"network blocked: {host}")
    return real_getaddrinfo(host, *args, **kwargs)

def connect(self, address):
    if isinstance(address, tuple) and address[0] not in LOCAL:
        raise OSError(f"network blocked: {address}")
    return real_connect(self, address)

socket.getaddrinfo, socket.socket.connect = getaddrinfo, connect

started = time.perf_counter()
from hyvo.sim.oasis_boot import import_oasis
import_oasis(log_dir=Path(sys.argv[1]))
import_s = time.perf_counter() - started
heavy = sorted(m for m in ("torch", "sentence_transformers", "transformers", "sklearn")
               if m in sys.modules)
logging.getLogger("social.agent").warning("emoji check \U0001f680 café")

from hyvo.personas import generate_crowd
from hyvo.sim.social import SocialWorld

async def run_world():
    async with SocialWorld(Path(sys.argv[2]), generate_crowd(2, seed=3)) as world:
        world.set_round(1)
        return await world.create_post("a01", "gm \U0001f680")

started = time.perf_counter()
ref = asyncio.run(run_world())
print(json.dumps({
    "import_s": import_s,
    "world_s": time.perf_counter() - started,
    "heavy": heavy,
    "heavy_after_world": sorted(m for m in ("torch", "transformers") if m in sys.modules),
    "tiktoken": "tiktoken" in sys.modules,
    "ref": ref,
}))
"""


def test_light_recsys_has_real_random_and_reddit_and_stubs_the_ml_ones():
    module = oasis_boot._light_recsys()
    assert module.__name__ == "oasis.social_platform.recsys"
    assert module.rec_sys_random is rec_sys_random
    assert module.rec_sys_reddit is rec_sys_reddit
    for name in ("rec_sys_personalized_twh", "rec_sys_personalized_with_trace"):
        with pytest.raises(NotImplementedError, match=FULL_IMPORT_ENV):
            getattr(module, name)([], [], [], [], 2)


def test_the_stand_in_provides_every_name_oasis_imports_from_recsys():
    spec = importlib.util.find_spec("oasis")  # locates the package without importing it
    assert spec is not None and spec.submodule_search_locations
    imported: set[str] = set()
    for path in Path(spec.submodule_search_locations[0]).rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.ImportFrom) and _resolves_to_recsys(node, path):
                imported.update(alias.name for alias in node.names)
    assert imported == {
        "rec_sys_personalized_twh",
        "rec_sys_personalized_with_trace",
        "rec_sys_random",
        "rec_sys_reddit",
    }
    module = oasis_boot._light_recsys()
    assert all(callable(getattr(module, name)) for name in imported)


def _resolves_to_recsys(node: ast.ImportFrom, path: Path) -> bool:
    if node.level == 0:
        return node.module == "oasis.social_platform.recsys"
    return node.level == 1 and node.module == "recsys" and path.parent.name == "social_platform"


def test_rec_sys_reddit_ranks_by_hot_score_and_returns_the_same_list_to_everyone():
    now = datetime(2026, 11, 3, 10, 0, 0)

    def post(post_id: int, likes: int, minutes_ago: int) -> dict:
        created = (now - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%d %H:%M:%S.%f")
        return {"post_id": post_id, "num_likes": likes, "num_dislikes": 0, "created_at": created}

    table = [post(1, 0, 600), post(2, 50, 600), post(3, 0, 0), post(4, 0, 300)]
    assert rec_sys_reddit(table, [[], []], 10) == [[1, 2, 3, 4], [1, 2, 3, 4]]
    top = rec_sys_reddit(table, [[], [], []], 2)
    assert top == [[2, 3]] * 3  # many likes beat age; then the newest post


def test_rec_sys_random_samples_distinct_posts_per_user():
    table = [{"post_id": n} for n in range(1, 11)]
    assert rec_sys_random(table[:2], [[], []], 3) == [[1, 2], [1, 2]]
    matrix = rec_sys_random(table, [[], [], []], 4)
    assert len(matrix) == 3
    for row in matrix:
        assert len(row) == len(set(row)) == 4
        assert set(row) <= set(range(1, 11))


@pytest.mark.parametrize(
    ("light", "env_value", "expected"),
    [(True, None, True), (True, "1", False), (True, "true", False), (True, "0", True),
     (False, None, False)],
)  # fmt: skip
def test_full_import_env_overrides_light(monkeypatch, light, env_value, expected):
    if env_value is None:
        monkeypatch.delenv(FULL_IMPORT_ENV, raising=False)
    else:
        monkeypatch.setenv(FULL_IMPORT_ENV, env_value)
    assert oasis_boot._wants_light(light) is expected


def test_importing_hyvo_sim_does_not_import_oasis():
    code = "import sys, hyvo.sim; print(sorted(m for m in ('oasis', 'camel') if m in sys.modules))"
    proc = subprocess.run(
        [sys.executable, "-c", code], check=True, capture_output=True, text=True, timeout=60
    )
    assert proc.stdout.strip() == "[]"


@pytest.mark.oasis
def test_import_is_idempotent_and_leaves_logging_quiet(oasis_module: ModuleType):
    assert import_oasis() is oasis_module
    assert import_oasis(log_dir="ignored-after-the-first-call", light=False) is oasis_module
    assert os.environ["CAMEL_LOGGING_DISABLED"] == "true"
    for name in ("social.twitter", "social.agent", "oasis.env", "table", "camel"):
        logger = logging.getLogger(name)
        assert logger.level == logging.WARNING
        assert logger.propagate is False
        [handler] = logger.handlers
        assert isinstance(handler, logging.FileHandler)
        assert handler.encoding == "utf-8"
        assert Path(handler.baseFilename).name == LOG_FILE_NAME


@pytest.mark.oasis
def test_light_import_in_a_fresh_process(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    cwd, log_dir, job_dir = tmp_path / "cwd", tmp_path / "logs", tmp_path / "job"
    cwd.mkdir()
    env = {k: v for k, v in os.environ.items() if k not in (FULL_IMPORT_ENV, "PYTHONIOENCODING")}
    env["PYTHONUTF8"] = "0"  # legacy Windows encodings (cp1252), where OASIS logging used to break
    proc = subprocess.run(
        [sys.executable, "-c", PROBE, str(log_dir), str(job_dir)],
        check=False,  # the return code is asserted below, with stderr in the message
        cwd=cwd,
        env=env,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )
    assert proc.returncode == 0, proc.stderr
    lines = proc.stdout.strip().splitlines()
    assert len(lines) == 1, f"unexpected stdout: {proc.stdout!r}"  # no OASIS/camel prints
    result = json.loads(lines[0])
    assert result["heavy"] == [] and result["heavy_after_world"] == []
    assert result["tiktoken"] is False  # STUB model: no tokenizer, so no BPE download
    assert result["ref"] == "p1"
    assert list(cwd.iterdir()) == []  # no ./log in the working directory
    assert not (log_dir / "log").exists()  # OASIS's empty import-time log files are cleaned up
    assert "emoji check \U0001f680 café" in (log_dir / LOG_FILE_NAME).read_text("utf-8")
    assert "Logging error" not in proc.stderr
    with capsys.disabled():
        print(
            f"\n[hyvo.sim] OASIS light import {result['import_s']:.2f} s, "
            f"2-agent world {result['world_s']:.2f} s (fresh process)"
        )
