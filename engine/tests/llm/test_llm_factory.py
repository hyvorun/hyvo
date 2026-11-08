from __future__ import annotations

import pytest

from hyvo.config import ConfigError, Settings
from hyvo.llm.factory import make_clients
from hyvo.llm.offline import OfflineClient
from hyvo.llm.openai_compat import OpenAICompatClient
from hyvo.llm.pricing import PricingUnknown
from hyvo.llm.types import LLMClient, Prices

PAID = {
    "llm_api_key": "sk-test-SECRET",
    "llm_base_url": "https://api.deepseek.com/v1",
    "llm_model_name": "deepseek-chat",
    "llm_price_input_per_m": 0.14,
    "llm_price_output_per_m": 0.28,
}


def test_offline_flag_wins_over_a_key():
    agents, report = make_clients(Settings(**PAID), offline=True, seed=5)
    assert isinstance(agents, OfflineClient) and isinstance(report, OfflineClient)
    assert agents.model_label == report.model_label == "offline/rules-v1"
    assert agents.seed == 5


def test_missing_key_falls_back_to_offline():
    agents, report = make_clients(Settings(llm_model_name="deepseek-chat"), offline=False)
    assert agents.model_label == report.model_label == "offline/rules-v1"


def test_paid_clients_share_the_endpoint_and_resolve_prices():
    agents, report = make_clients(Settings(**PAID), offline=False)
    assert isinstance(agents, OpenAICompatClient) and isinstance(report, OpenAICompatClient)
    assert isinstance(agents, LLMClient)
    assert agents.model_label == report.model_label == "deepseek/deepseek-chat"
    assert agents.prices == report.prices == Prices(0.14, 0.28)


def test_report_model_has_its_own_label_and_price():
    settings = Settings(
        **PAID,
        report_model_name="deepseek-reasoner",
        report_price_input_per_m=0.55,
        report_price_output_per_m=2.19,
    )
    agents, report = make_clients(settings, offline=False)
    assert agents.model_label == "deepseek/deepseek-chat"
    assert report.model_label == "deepseek/deepseek-reasoner"
    assert report.prices == Prices(0.55, 2.19)


def test_unknown_price_is_refused_before_any_request():
    unpriced = {k: v for k, v in PAID.items() if "price" not in k}
    with pytest.raises(PricingUnknown):
        make_clients(Settings(**unpriced), offline=False)
    with pytest.raises(PricingUnknown):
        make_clients(Settings(**PAID, report_model_name="other-model"), offline=False)


def test_key_without_model_is_a_config_error():
    with pytest.raises(ConfigError, match="LLM_MODEL_NAME"):
        make_clients(Settings(llm_api_key="sk-test"), offline=False)
