"""Import OASIS (camel-oasis 0.2.5) once per process: light, quiet and outside the CWD.

``import oasis`` has side effects Hyvo must contain (docs/mirofish/oasis-internals.md section 9):

- ``oasis.social_platform.recsys`` imports torch, sentence-transformers, transformers and
  scikit-learn at module level. Hyvo only uses the ``reddit`` and ``random`` recommenders, which
  need none of them, so the light import (the default) first puts a stand-in module in
  ``sys.modules``: real copies of those two recommenders, and stubs for the ML ones.
- ``platform.py``, ``agent.py``, ``env.py`` and ``testing/show_db.py`` create ``./log`` in the
  working directory at import and open log files there, two of them without an encoding
  (cp1252 ``UnicodeEncodeError`` on Windows). The import runs inside ``log_dir``; afterwards
  every OASIS and camel logger writes WARNING and above to one UTF-8 file,
  ``<log_dir>/oasis.log``, and nothing goes to stdout or stderr.
- camel configures root logging to stdout at import unless ``CAMEL_LOGGING_DISABLED=true``.

Call :func:`import_oasis` early, before worker threads start: it changes the process-wide working
directory while the import runs.
"""

from __future__ import annotations

import heapq
import importlib
import logging
import os
import random
import sys
import threading
from collections.abc import Callable
from datetime import datetime
from math import log
from pathlib import Path
from types import ModuleType
from typing import Any

__all__ = ["DEFAULT_LOG_DIR", "FULL_IMPORT_ENV", "LOG_FILE_NAME", "import_oasis"]

DEFAULT_LOG_DIR = Path(__file__).resolve().parents[2] / ".oasis-logs"
FULL_IMPORT_ENV = "HYVO_OASIS_FULL_IMPORT"
LOG_FILE_NAME = "oasis.log"

_RECSYS_MODULE = "oasis.social_platform.recsys"
# What oasis/social_platform/platform.py imports from recsys and needs torch for.
_ML_RECOMMENDERS = ("rec_sys_personalized_twh", "rec_sys_personalized_with_trace")
# Loggers OASIS 0.2.5 and camel create at import (social.rec only on the full import).
_LOGGERS = ("social.twitter", "social.agent", "social.rec", "oasis.env", "table", "camel")
_TRUTHY = frozenset({"1", "true", "yes", "on"})

_lock = threading.Lock()
_oasis: ModuleType | None = None


def import_oasis(log_dir: str | os.PathLike[str] | None = None, light: bool = True) -> ModuleType:
    """Return the ``oasis`` package, importing it on the first call (idempotent, thread-safe).

    Args:
        log_dir: directory for OASIS's import-time ``./log`` and for ``oasis.log``; created if
            missing. Defaults to ``engine/.oasis-logs``. Only the first call's value counts.
        light: install the recsys stand-in so torch and friends are never imported. The
            environment variable ``HYVO_OASIS_FULL_IMPORT=1`` overrides it with a full import.
            Neither applies if something imported ``oasis`` before the first call.
    """
    global _oasis
    with _lock:
        if _oasis is None:
            directory = Path(DEFAULT_LOG_DIR if log_dir is None else log_dir).resolve()
            directory.mkdir(parents=True, exist_ok=True)
            os.environ["CAMEL_LOGGING_DISABLED"] = "true"
            module = sys.modules.get("oasis") or _import_inside(directory, _wants_light(light))
            _quiet_logging(directory)
            _oasis = module
        return _oasis


def _wants_light(light: bool) -> bool:
    return light and os.environ.get(FULL_IMPORT_ENV, "").strip().lower() not in _TRUTHY


def _import_inside(directory: Path, light: bool) -> ModuleType:
    """Import ``oasis`` with ``directory`` as the working directory (its ``./log`` lands there)."""
    if light and _RECSYS_MODULE not in sys.modules:
        sys.modules[_RECSYS_MODULE] = _light_recsys()
    previous = os.getcwd()
    os.chdir(directory)
    try:
        return importlib.import_module("oasis")
    finally:
        os.chdir(previous)


def _quiet_logging(directory: Path) -> None:
    """Route OASIS and camel logging to one UTF-8 file at WARNING; drop OASIS's own handlers."""
    handler = logging.FileHandler(directory / LOG_FILE_NAME, encoding="utf-8", delay=True)
    handler.setLevel(logging.WARNING)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    for name in _LOGGERS:
        logger = logging.getLogger(name)
        for old in list(logger.handlers):
            logger.removeHandler(old)
            old.close()
            if isinstance(old, logging.FileHandler):
                _remove_if_empty(Path(old.baseFilename))
        logger.addHandler(handler)
        logger.setLevel(logging.WARNING)
        logger.propagate = False
    import_log_dir = directory / "log"
    if import_log_dir.is_dir() and not any(import_log_dir.iterdir()):
        import_log_dir.rmdir()


def _remove_if_empty(path: Path) -> None:
    """OASIS opens four timestamped files per import; keep only the ones that got a record."""
    if path.is_file() and path.stat().st_size == 0:
        path.unlink()


def _light_recsys() -> ModuleType:
    module = ModuleType(_RECSYS_MODULE, "Hyvo light stand-in for OASIS recsys (no torch).")
    module.rec_sys_random = rec_sys_random  # type: ignore[attr-defined]
    module.rec_sys_reddit = rec_sys_reddit  # type: ignore[attr-defined]
    module.calculate_hot_score = calculate_hot_score  # type: ignore[attr-defined]
    for name in _ML_RECOMMENDERS:
        setattr(module, name, _unavailable(name))
    return module


def _unavailable(name: str) -> Callable[..., Any]:
    def recommender(*args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError(
            f"OASIS recommender {name} needs torch, but OASIS was imported in light mode; "
            f"set {FULL_IMPORT_ENV}=1 for the full import"
        )

    recommender.__name__ = recommender.__qualname__ = name
    return recommender


# --- Adapted from OASIS oasis/social_platform/recsys.py (Apache-2.0), camel-oasis 0.2.5 --------
# Copyright 2023 @ CAMEL-AI.org. Copied unchanged in behavior; only formatting and type hints
# differ. Licensed under the Apache License, Version 2.0: http://www.apache.org/licenses/LICENSE-2.0


def rec_sys_random(
    post_table: list[dict[str, Any]], rec_matrix: list[list], max_rec_post_len: int
) -> list[list]:
    """Randomly recommend posts to users."""
    post_ids = [post["post_id"] for post in post_table]
    new_rec_matrix = []
    if len(post_ids) <= max_rec_post_len:
        new_rec_matrix = [post_ids] * len(rec_matrix)
    else:
        for _ in range(len(rec_matrix)):
            new_rec_matrix.append(random.sample(post_ids, max_rec_post_len))
    return new_rec_matrix


def calculate_hot_score(num_likes: int, num_dislikes: int, created_at: datetime) -> float:
    """Reddit hot score of a post (likes minus dislikes, decayed by creation time)."""
    s = num_likes - num_dislikes
    order = log(max(abs(s), 1), 10)  # noqa: FURB163 (log10 can differ in the last bit)
    sign = 1 if s > 0 else -1 if s < 0 else 0
    epoch = datetime(1970, 1, 1)
    td = created_at - epoch
    epoch_seconds_result = td.days * 86400 + td.seconds + (float(td.microseconds) / 1e6)
    seconds = epoch_seconds_result - 1134028003
    return round(sign * order + seconds / 45000, 7)


def rec_sys_reddit(
    post_table: list[dict[str, Any]], rec_matrix: list[list], max_rec_post_len: int
) -> list[list]:
    """Recommend the same top posts by Reddit hot score to every user."""
    post_ids = [post["post_id"] for post in post_table]
    if len(post_ids) <= max_rec_post_len:
        new_rec_matrix = [post_ids] * len(rec_matrix)
    else:
        all_hot_score = []
        for post in post_table:
            try:
                created_at_dt = datetime.strptime(post["created_at"], "%Y-%m-%d %H:%M:%S.%f")
            except Exception:  # noqa: BLE001 (as in OASIS)
                created_at_dt = datetime.strptime(post["created_at"], "%Y-%m-%d %H:%M:%S")
            hot_score = calculate_hot_score(post["num_likes"], post["num_dislikes"], created_at_dt)
            all_hot_score.append((hot_score, post["post_id"]))
        top_posts = heapq.nlargest(max_rec_post_len, all_hot_score, key=lambda x: x[0])
        top_post_ids = [post_id for _, post_id in top_posts]
        new_rec_matrix = [top_post_ids] * len(rec_matrix)
    return new_rec_matrix


# --- end of the OASIS adaptation -----------------------------------------------------------------
