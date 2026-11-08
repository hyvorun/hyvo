from __future__ import annotations

import pytest

from hyvo.config import ConfigError, Settings
from hyvo.llm import pricing
from hyvo.llm.pricing import PricingUnknown, cost_usd, estimate_tokens, resolve_prices
from hyvo.llm.types import OFFLINE_MODEL_LABEL, Prices


def test_price_table_entries_are_model_labels_with_valid_prices():
    for label, prices in pricing.PRICES.items():
        provider, _, model = label.partition("/")
        assert provider and model, label
        assert isinstance(prices, Prices)
        assert all(isinstance(p, float) and p >= 0 for p in prices), label


def test_deepseek_flash_uses_the_peak_price():
    assert resolve_prices("deepseek/deepseek-flash", Settings()) == Prices(0.30, 1.20)


def test_offline_model_is_free():
    assert resolve_prices(OFFLINE_MODEL_LABEL, Settings()) == Prices(0.0, 0.0)


@pytest.mark.parametrize("bad", [(-0.1, 0.2), (0.1, float("nan")), (float("inf"), 0.0)])
def test_invalid_prices_are_a_config_error(monkeypatch, bad):
    monkeypatch.setattr(pricing, "PRICES", {"p/m": bad})
    with pytest.raises(ConfigError, match="'p/m'"):
        resolve_prices("p/m", Settings())
    override = Settings(llm_price_input_per_m=bad[0], llm_price_output_per_m=bad[1])
    with pytest.raises(ConfigError):
        resolve_prices("p/x", override)


def test_unknown_paid_model_is_refused():
    with pytest.raises(PricingUnknown, match="LLM_PRICE_INPUT_PER_M"):
        resolve_prices("deepseek/deepseek-chat", Settings())
    with pytest.raises(PricingUnknown, match="REPORT_PRICE_INPUT_PER_M"):
        resolve_prices("deepseek/deepseek-chat", Settings(), role="report")


def test_price_table_is_keyed_by_model_label(monkeypatch):
    monkeypatch.setattr(pricing, "PRICES", {"deepseek/deepseek-chat": (0.14, 0.28)})
    assert resolve_prices("deepseek/deepseek-chat", Settings()) == Prices(0.14, 0.28)
    with pytest.raises(PricingUnknown):
        resolve_prices("openrouter/deepseek-chat", Settings())


def test_settings_override_the_table(monkeypatch):
    monkeypatch.setattr(pricing, "PRICES", {"deepseek/deepseek-chat": (9.0, 9.0)})
    settings = Settings(llm_price_input_per_m=0.1, llm_price_output_per_m=0.2)
    assert resolve_prices("deepseek/deepseek-chat", settings) == Prices(0.1, 0.2)


def test_report_override_and_fallback_to_the_agents_override():
    agents_only = Settings(
        llm_model_name="m", llm_price_input_per_m=0.1, llm_price_output_per_m=0.2
    )
    # the report runs on the agents' model, so the agents' price applies
    assert resolve_prices("p/m", agents_only, role="report") == Prices(0.1, 0.2)
    same_name = Settings(
        llm_model_name="m", report_model_name="m", llm_price_input_per_m=0.1,
        llm_price_output_per_m=0.2,
    )  # fmt: skip
    assert resolve_prices("p/m", same_name, role="report") == Prices(0.1, 0.2)
    other_model = Settings(
        llm_model_name="m", report_model_name="big", llm_price_input_per_m=0.1,
        llm_price_output_per_m=0.2,
    )  # fmt: skip
    with pytest.raises(PricingUnknown):
        resolve_prices("p/big", other_model, role="report")
    with_report = Settings(
        llm_model_name="m", report_model_name="big", report_price_input_per_m=1.0,
        report_price_output_per_m=4.0,
    )  # fmt: skip
    assert resolve_prices("p/big", with_report, role="report") == Prices(1.0, 4.0)


def test_cost_and_token_math():
    assert cost_usd(Prices(0.14, 0.28), 1_000_000, 500_000) == pytest.approx(0.28)
    assert cost_usd(Prices(0.0, 0.0), 10**9, 10**9) == 0.0
    assert [estimate_tokens(n) for n in (0, 1, 4, 5, 400)] == [0, 1, 1, 2, 100]
