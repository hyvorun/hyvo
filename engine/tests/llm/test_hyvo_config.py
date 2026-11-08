from __future__ import annotations

import os
from pathlib import Path

import pytest

from hyvo.config import (
    DEFAULT_RUNS_DIR,
    REPO_ROOT,
    ConfigError,
    Settings,
    load_settings,
)

KEY = "sk-live-SECRET-abcdef"
TOKEN = "runner-SECRET-123"


def test_defaults_without_environment_or_dotenv():
    settings = load_settings(environ={}, dotenv_path=None)
    assert settings == Settings()
    assert settings.max_cost_usd_default == 0.50
    assert settings.max_llm_calls_default == 2000
    assert settings.runs_dir == DEFAULT_RUNS_DIR == REPO_ROOT / "engine" / ".runs"
    assert settings.llm_api_key is None


def test_reads_every_variable():
    settings = load_settings(
        environ={
            "LLM_API_KEY": KEY,
            "LLM_BASE_URL": "https://api.deepseek.com/v1",
            "LLM_MODEL_NAME": "deepseek-chat",
            "REPORT_MODEL_NAME": "deepseek-reasoner",
            "RH_RPC_URL": "https://rpc.example/v2/RPCSECRET",
            "HYVO_API_URL": "http://127.0.0.1:8787",
            "RUNNER_TOKEN": TOKEN,
            "MAX_COST_USD_DEFAULT": "1.25",
            "MAX_LLM_CALLS_DEFAULT": "300",
            "LLM_PRICE_INPUT_PER_M": "0.14",
            "LLM_PRICE_OUTPUT_PER_M": "0.28",
            "REPORT_PRICE_INPUT_PER_M": "0.5",
            "REPORT_PRICE_OUTPUT_PER_M": "2",
            "HYVO_RUNS_DIR": "engine/.runs-test",
        },
        dotenv_path=None,
    )
    assert settings.llm_api_key == KEY
    assert settings.llm_model_name == "deepseek-chat"
    assert settings.report_model_name == "deepseek-reasoner"
    assert settings.max_cost_usd_default == 1.25
    assert settings.max_llm_calls_default == 300
    assert (settings.llm_price_input_per_m, settings.llm_price_output_per_m) == (0.14, 0.28)
    assert (settings.report_price_input_per_m, settings.report_price_output_per_m) == (0.5, 2.0)
    assert settings.runs_dir == REPO_ROOT / "engine" / ".runs-test"


def test_dotenv_fills_gaps_and_environment_wins(tmp_path):
    dotenv = tmp_path / ".env"
    dotenv.write_text(
        "LLM_API_KEY=from-dotenv\n"
        "LLM_MODEL_NAME=dotenv-model              # agents (cheap model)\n"
        "REPORT_MODEL_NAME=dotenv-report\n"
        "MAX_LLM_CALLS_DEFAULT=\n",
        encoding="utf-8",
    )
    before = dict(os.environ)
    settings = load_settings(
        environ={"LLM_MODEL_NAME": "env-model", "REPORT_MODEL_NAME": ""}, dotenv_path=dotenv
    )
    assert settings.llm_api_key == "from-dotenv"
    assert settings.llm_model_name == "env-model"  # environment wins
    assert settings.report_model_name is None  # set-but-empty in the environment still wins
    assert settings.max_llm_calls_default == 2000  # empty value means unset
    assert dict(os.environ) == before  # the process environment is never modified


def test_missing_dotenv_file_is_fine(tmp_path):
    assert load_settings(environ={}, dotenv_path=tmp_path / "absent.env") == Settings()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("MAX_COST_USD_DEFAULT", "cheap"),
        ("MAX_COST_USD_DEFAULT", "-1"),
        ("MAX_COST_USD_DEFAULT", "inf"),
        ("MAX_LLM_CALLS_DEFAULT", "0"),
        ("MAX_LLM_CALLS_DEFAULT", "2.5"),
        ("MAX_LLM_CALLS_DEFAULT", "١٢"),
    ],
)
def test_malformed_numbers_name_the_variable(name, value):
    with pytest.raises(ConfigError, match=name):
        load_settings(environ={name: value}, dotenv_path=None)


@pytest.mark.parametrize("prefix", ["LLM_PRICE", "REPORT_PRICE"])
def test_price_overrides_come_in_pairs(prefix):
    with pytest.raises(ConfigError, match="set both"):
        load_settings(environ={f"{prefix}_INPUT_PER_M": "0.1"}, dotenv_path=None)


def test_absolute_runs_dir_is_kept(tmp_path):
    settings = load_settings(environ={"HYVO_RUNS_DIR": str(tmp_path)}, dotenv_path=None)
    assert settings.runs_dir == Path(tmp_path)


def test_repr_masks_secrets():
    settings = load_settings(
        environ={
            "LLM_API_KEY": KEY,
            "RUNNER_TOKEN": TOKEN,
            "RH_RPC_URL": "https://user:pw@rpc.example:8545/v2/RPCSECRET?k=1",
            "RH_RPC_URL_FALLBACK": "https://eth.alchemy.example/v2/FALLBACKSECRET",
            "LLM_BASE_URL": "https://proxy:PROXYPW@llm.example/v1?key=URLKEY#frag",
            "HYVO_API_URL": "http://127.0.0.1:8787/api",
            "LLM_MODEL_NAME": "deepseek-chat",
        },
        dotenv_path=None,
    )
    shown = repr(settings)
    secrets = (KEY, TOKEN, "RPCSECRET", "user:pw", "FALLBACKSECRET", "PROXYPW", "URLKEY", "frag")
    for secret in secrets:
        assert secret not in shown
    assert "llm_api_key='***'" in shown and "runner_token='***'" in shown
    assert "rh_rpc_url='https://rpc.example:8545/***'" in shown
    assert "rh_rpc_url_fallback='https://eth.alchemy.example/***'" in shown
    assert "llm_base_url='https://llm.example/v1?***'" in shown
    assert "hyvo_api_url='http://127.0.0.1:8787/api'" in shown
    assert "llm_model_name='deepseek-chat'" in shown
    assert str(settings) == shown
    assert settings.llm_api_key == KEY  # masking is display-only


def test_repr_shows_unset_secrets_as_none_and_plain_rpc_hosts():
    shown = repr(load_settings(environ={"RH_RPC_URL": "https://rpc.example"}, dotenv_path=None))
    assert "llm_api_key=None" in shown and "rh_rpc_url='https://rpc.example'" in shown


def test_env_example_copied_verbatim_gives_the_defaults():
    # .env.example puts comments after empty values ("NAME=   # comment"), which python-dotenv
    # reads as the value "# comment". Copying the example to .env must not configure anything.
    example = REPO_ROOT / ".env.example"
    if not example.is_file():
        pytest.skip(".env.example is missing")
    assert load_settings(environ={}, dotenv_path=example) == Settings()


@pytest.mark.parametrize("value", ["# agents (cheap model)", "   #", "#"])
def test_values_that_are_comments_count_as_unset(value):
    environ = {"LLM_MODEL_NAME": value, "RH_RPC_URL": value}
    settings = load_settings(environ=environ, dotenv_path=None)
    assert settings.llm_model_name is None and settings.rh_rpc_url is None


def test_dotenv_with_a_byte_order_mark_is_read(tmp_path):
    dotenv = tmp_path / ".env"
    dotenv.write_text("LLM_API_KEY=from-bom-file\n", encoding="utf-8-sig")
    assert load_settings(environ={}, dotenv_path=dotenv).llm_api_key == "from-bom-file"


@pytest.mark.parametrize("name", ["LLM_BASE_URL", "HYVO_API_URL"])
@pytest.mark.parametrize(
    "value", ["api.deepseek.com/v1", "ftp://files.example/v1", "https:///v1", "http://[::1"]
)
def test_service_urls_must_be_http_and_are_not_echoed(name, value):
    with pytest.raises(ConfigError, match=f"{name} must be an http") as captured:
        load_settings(environ={name: value}, dotenv_path=None)
    assert value not in str(captured.value)


def test_fallback_rpc_url_is_read():
    settings = load_settings(
        environ={"RH_RPC_URL_FALLBACK": "https://backup.example/rpc"}, dotenv_path=None
    )
    assert settings.rh_rpc_url_fallback == "https://backup.example/rpc"


def test_the_switch_skips_the_default_file_and_no_other(tmp_path, monkeypatch):
    default = tmp_path / ".env"
    default.write_text("LLM_API_KEY=from-default\n", encoding="utf-8")
    other = tmp_path / "other.env"
    other.write_text("LLM_API_KEY=from-other\n", encoding="utf-8")
    monkeypatch.setattr("hyvo.config.DEFAULT_DOTENV", default)
    switch = {"HYVO_NO_DOTENV": "1"}
    assert load_settings(environ={}, dotenv_path=default).llm_api_key == "from-default"
    assert load_settings(environ=switch, dotenv_path=default).llm_api_key is None
    assert load_settings(environ=switch, dotenv_path=other).llm_api_key == "from-other"


def test_the_suite_cannot_read_the_real_settings_file():
    """It holds the production API URL and tokens (tests/conftest.py)."""
    assert os.environ["HYVO_NO_DOTENV"] == "1"
