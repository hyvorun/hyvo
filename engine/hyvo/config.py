"""Engine settings from the process environment plus an optional repo-root ``.env``.

Precedence is the same as ``python-dotenv``'s ``load_dotenv(override=False)``: a variable that is
already set in the environment (even to an empty string) wins over the ``.env`` file. The process
environment itself is never modified, so secrets read from ``.env`` do not leak into child
processes such as anvil.

Empty values count as unset, and so do values that start with ``#``: python-dotenv reads
``NAME=      # comment`` (the layout of ``.env.example``) as the value ``# comment``, and no setting
legitimately starts with ``#``. Secrets are masked in ``repr`` and Hyvo code never logs them.
"""

from __future__ import annotations

import math
import os
from collections.abc import Mapping
from dataclasses import dataclass, fields
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import dotenv_values

ENGINE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ENGINE_ROOT.parent
DEFAULT_DOTENV = REPO_ROOT / ".env"
DEFAULT_RUNS_DIR = ENGINE_ROOT / ".runs"

_SECRET_FIELDS = frozenset({"llm_api_key", "runner_token", "neynar_api_key", "blockscout_api_key"})
# RPC URLs often carry an API key in the path or query, so only scheme and host are shown.
_HOST_ONLY_URL_FIELDS = frozenset({"rh_rpc_url", "rh_rpc_url_fallback"})
# Other URLs keep their path; user info, query and fragment are hidden.
_URL_FIELDS = frozenset({"llm_base_url", "hyvo_api_url"})


class ConfigError(ValueError):
    """A setting is missing or malformed. Messages never contain secret values."""


@dataclass(frozen=True, repr=False)
class Settings:
    """Typed engine settings. Build with :func:`load_settings`."""

    llm_api_key: str | None = None
    llm_base_url: str | None = None
    llm_model_name: str | None = None
    report_model_name: str | None = None
    rh_rpc_url: str | None = None
    rh_rpc_url_fallback: str | None = None
    hyvo_api_url: str | None = None
    runner_token: str | None = None
    max_cost_usd_default: float = 0.50
    max_llm_calls_default: int = 2000
    llm_price_input_per_m: float | None = None
    llm_price_output_per_m: float | None = None
    report_price_input_per_m: float | None = None
    report_price_output_per_m: float | None = None
    runs_dir: Path = DEFAULT_RUNS_DIR
    neynar_api_key: str | None = None
    blockscout_api_key: str | None = None
    blockscout_api_url: str | None = None
    narrative_rss_urls: tuple[str, ...] = ()
    hyvo_site_url: str | None = None

    def __repr__(self) -> str:
        parts = []
        for f in fields(self):
            value = getattr(self, f.name)
            if value is None:
                shown = "None"
            elif f.name in _SECRET_FIELDS:
                shown = "'***'"
            elif f.name in _HOST_ONLY_URL_FIELDS:
                shown = repr(_mask_url(value, keep_path=False))
            elif f.name in _URL_FIELDS:
                shown = repr(_mask_url(value, keep_path=True))
            else:
                shown = repr(value)
            parts.append(f"{f.name}={shown}")
        return f"Settings({', '.join(parts)})"


def load_settings(
    environ: Mapping[str, str] | None = None,
    dotenv_path: str | os.PathLike[str] | None = DEFAULT_DOTENV,
) -> Settings:
    """Read settings from ``environ`` (default ``os.environ``) and ``dotenv_path`` if it exists.

    Pass ``dotenv_path=None`` to ignore any ``.env`` file. ``HYVO_NO_DOTENV=1`` in the environment
    ignores the repo's own ``.env``, for the tests and every process they start: that file points
    at production. A relative ``HYVO_RUNS_DIR`` is resolved against the repo root, so the runs
    directory does not depend on the working directory.
    """
    env = os.environ if environ is None else environ
    if env.get("HYVO_NO_DOTENV") and dotenv_path == DEFAULT_DOTENV:
        dotenv_path = None
    values: dict[str, str] = {}
    if dotenv_path is not None and Path(dotenv_path).is_file():
        # utf-8-sig: editors on Windows may save .env with a byte order mark.
        loaded = dotenv_values(dotenv_path, encoding="utf-8-sig")
        values.update({k: v for k, v in loaded.items() if v is not None})
    values.update(env)

    max_cost = _number(values, "MAX_COST_USD_DEFAULT")
    llm_in, llm_out = _price_pair(values, "LLM_PRICE_INPUT_PER_M", "LLM_PRICE_OUTPUT_PER_M")
    rep_in, rep_out = _price_pair(values, "REPORT_PRICE_INPUT_PER_M", "REPORT_PRICE_OUTPUT_PER_M")
    return Settings(
        llm_api_key=_text(values, "LLM_API_KEY"),
        llm_base_url=_http_url(values, "LLM_BASE_URL"),
        llm_model_name=_text(values, "LLM_MODEL_NAME"),
        report_model_name=_text(values, "REPORT_MODEL_NAME"),
        rh_rpc_url=_text(values, "RH_RPC_URL"),
        rh_rpc_url_fallback=_text(values, "RH_RPC_URL_FALLBACK"),
        hyvo_api_url=_http_url(values, "HYVO_API_URL"),
        runner_token=_text(values, "RUNNER_TOKEN"),
        max_cost_usd_default=0.50 if max_cost is None else max_cost,
        max_llm_calls_default=_positive_int(values, "MAX_LLM_CALLS_DEFAULT", 2000),
        llm_price_input_per_m=llm_in,
        llm_price_output_per_m=llm_out,
        report_price_input_per_m=rep_in,
        report_price_output_per_m=rep_out,
        runs_dir=_runs_dir(_text(values, "HYVO_RUNS_DIR")),
        neynar_api_key=_text(values, "NEYNAR_API_KEY"),
        blockscout_api_key=_text(values, "BLOCKSCOUT_API_KEY"),
        blockscout_api_url=_text(values, "BLOCKSCOUT_API_URL"),
        narrative_rss_urls=tuple(url.strip() for url in (_text(values, "NARRATIVE_RSS_URLS") or "").split(",") if url.strip()),
        hyvo_site_url=_http_url(values, "HYVO_SITE_URL"),
    )


def _text(values: Mapping[str, str], name: str) -> str | None:
    raw = values.get(name)
    if raw is None:
        return None
    value = raw.strip()
    if not value or value.startswith("#"):
        return None
    return value


def _http_url(values: Mapping[str, str], name: str) -> str | None:
    url = _text(values, name)
    if url is None:
        return None
    try:
        parts = urlsplit(url)
        valid = parts.scheme in ("http", "https") and bool(parts.hostname)
    except ValueError:
        valid = False
    if not valid:
        # The value is not echoed: a URL may embed a key.
        raise ConfigError(f"{name} must be an http(s) URL such as https://api.example.com/v1")
    return url


def _number(values: Mapping[str, str], name: str) -> float | None:
    raw = _text(values, name)
    if raw is None:
        return None
    try:
        value = float(raw)
    except ValueError:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from None
    if not math.isfinite(value) or value < 0:
        raise ConfigError(f"{name} must be a finite number >= 0, got {raw!r}")
    return value


def _positive_int(values: Mapping[str, str], name: str, default: int) -> int:
    raw = _text(values, name)
    if raw is None:
        return default
    if not raw.isascii() or not raw.isdigit() or int(raw) < 1:
        raise ConfigError(f"{name} must be a whole number >= 1, got {raw!r}")
    return int(raw)


def _price_pair(
    values: Mapping[str, str], input_name: str, output_name: str
) -> tuple[float | None, float | None]:
    pair = (_number(values, input_name), _number(values, output_name))
    if (pair[0] is None) != (pair[1] is None):
        raise ConfigError(f"set both {input_name} and {output_name}, or neither")
    return pair


def _runs_dir(raw: str | None) -> Path:
    if raw is None:
        return DEFAULT_RUNS_DIR
    path = Path(raw).expanduser()
    return path if path.is_absolute() else REPO_ROOT / path


def _mask_url(url: str, *, keep_path: bool) -> str:
    """Hide the parts of a URL that may embed a credential.

    User info, query and fragment are always hidden; so is the path unless ``keep_path``.
    """
    scheme, sep, rest = url.partition("://")
    if not sep:
        return "***"
    cut = _first_index(rest, "/?#")
    authority, tail = rest[:cut], rest[cut:]
    shown = f"{scheme}://{authority.rpartition('@')[2]}"
    if not tail:
        return shown
    if not keep_path:
        return shown + "/***"
    end = _first_index(tail, "?#")
    return shown + tail[:end] + ("?***" if end < len(tail) else "")


def _first_index(text: str, chars: str) -> int:
    """Index of the first character of ``text`` that is in ``chars``, else ``len(text)``."""
    return next((i for i, ch in enumerate(text) if ch in chars), len(text))
