"""Build the agents and report clients from settings."""

from __future__ import annotations

from ..config import ConfigError, Settings
from .offline import OfflineClient
from .openai_compat import OpenAICompatClient, model_label
from .pricing import resolve_prices
from .types import LLMClient


def make_clients(
    settings: Settings, offline: bool, *, seed: int = 0
) -> tuple[LLMClient, LLMClient]:
    """Return ``(agents_client, report_client)``.

    ``offline=True`` or a missing ``LLM_API_KEY`` gives the offline rules model for both
    (``seed`` feeds it). Otherwise both use ``LLM_BASE_URL`` with ``LLM_MODEL_NAME`` for agents
    and ``REPORT_MODEL_NAME`` (else ``LLM_MODEL_NAME``) for the report. Prices are resolved up
    front, so an unknown price raises ``PricingUnknown`` before any request is made.
    """
    if offline or not settings.llm_api_key:
        client = OfflineClient(seed)
        return client, client
    if not settings.llm_model_name:
        raise ConfigError("LLM_MODEL_NAME is required when LLM_API_KEY is set")
    report_model = settings.report_model_name or settings.llm_model_name
    agents_prices = resolve_prices(
        model_label(settings.llm_base_url, settings.llm_model_name), settings, role="agents"
    )
    report_prices = resolve_prices(
        model_label(settings.llm_base_url, report_model), settings, role="report"
    )
    agents = OpenAICompatClient(
        settings.llm_api_key, settings.llm_base_url, settings.llm_model_name, *agents_prices
    )
    report = OpenAICompatClient(
        settings.llm_api_key, settings.llm_base_url, report_model, *report_prices
    )
    return agents, report
