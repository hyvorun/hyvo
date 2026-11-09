"""Model prices, token estimates and cost math.

``PRICES`` holds only verified entries (source and date in a comment), keyed by model label
``"<provider slug>/<model>"``, exactly as written to run.json ``crowd.model``. Settings overrides
(``LLM_PRICE_*`` / ``REPORT_PRICE_*``) take precedence. Hyvo refuses to run a paid model whose
price is unknown, so every budget stays enforceable.

Costs use the full input price for every prompt token, and time-of-day pricing uses the most
expensive window. Hyvo therefore records at most what a provider charges, never less.
"""

from __future__ import annotations

import math

from ..config import ConfigError, Settings
from .types import OFFLINE_MODEL_LABEL, Prices, Purpose

PRICES: dict[str, Prices] = {
    # DeepSeek, USD per 1M tokens, peak window (01-04 and 06-10 UTC Mon-Fri), cache-miss input.
    # Source: https://api-docs.deepseek.com/quick_start/pricing (checked 2026-11-02). Off-peak is half.
    # deepseek-v4-flash is a retired alias served by V4.1 Flash at the Flash price.
    "deepseek/deepseek-flash": Prices(0.30, 1.20),
    "deepseek/deepseek-v4-flash": Prices(0.30, 1.20),
    "deepseek/deepseek-v4-pro": Prices(1.32, 3.96),
    # OpenRouter, USD per 1M tokens: the price cap each call sends as provider.max_price (openai_compat.py),
    # so OpenRouter only routes to providers at or under it. DeepSeek V4 Flash's providers listed
    # $0.05-0.21 input and $0.165-0.56 output on https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash/endpoints
    # (read 2026-11-09); most sit under this cap.
    "openrouter/deepseek/deepseek-v4-flash": Prices(0.15, 0.30),
    # Cloudflare Workers AI, USD per 1M tokens. The free allocation (10,000 neurons a day) is about
    # $0.11 at these prices. Source: https://developers.cloudflare.com/workers-ai/platform/pricing/
    # (checked 2026-11-04).
    "@cf/qwen/qwen3-30b-a3b-fp8": Prices(0.051, 0.335),
    "@cf/zai-org/glm-4.7-flash": Prices(0.060, 0.400),
    "@cf/meta/llama-3.1-8b-instruct-fp8-fast": Prices(0.045, 0.384),
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast": Prices(0.293, 2.253),
    "@cf/meta/llama-4-scout-17b-16e-instruct": Prices(0.270, 0.850),
    "@cf/google/gemma-4-26b-a4b-it": Prices(0.100, 0.300),
    "@cf/ibm-granite/granite-4.0-h-micro": Prices(0.017, 0.112),
    "@cf/openai/gpt-oss-20b": Prices(0.200, 0.300),
    "@cf/mistralai/mistral-small-3.1-24b-instruct": Prices(0.351, 0.555),
}

FREE = Prices(0.0, 0.0)


class PricingUnknown(LookupError):
    """No verified price for a paid model."""


def resolve_prices(model: str, settings: Settings, *, role: Purpose = "agents") -> Prices:
    """Prices for ``model`` (a model label) used as the agents or the report model.

    Order: offline model (free), the role's settings override, then ``PRICES``. When the report
    runs on the agents' model (``REPORT_MODEL_NAME`` unset or equal), the ``LLM_PRICE_*``
    override applies to it too. Raises ``PricingUnknown`` when no price is known and
    ``ConfigError`` for a price that is not a finite number >= 0.
    """
    if model == OFFLINE_MODEL_LABEL:
        return FREE
    prices = _override(settings, role)
    if prices is None and model in PRICES:
        prices = Prices(*PRICES[model])
    if prices is None:
        prefix = "REPORT_PRICE" if role == "report" else "LLM_PRICE"
        raise PricingUnknown(
            f"no verified price for model {model!r}; set {prefix}_INPUT_PER_M and "
            f"{prefix}_OUTPUT_PER_M, or add it to hyvo.llm.pricing.PRICES "
            "(Hyvo does not run a paid model without a known price)"
        )
    if not all(isinstance(p, (int, float)) and math.isfinite(p) and p >= 0 for p in prices):
        raise ConfigError(f"the price of model {model!r} must be two finite numbers >= 0")
    return Prices(float(prices.input_per_m), float(prices.output_per_m))


def cost_usd(prices: Prices, input_tokens: int, output_tokens: int) -> float:
    return (input_tokens * prices.input_per_m + output_tokens * prices.output_per_m) / 1_000_000


def estimate_tokens(chars: int) -> int:
    """Hyvo's provider-independent token estimate: ``ceil(chars / 4)``."""
    return math.ceil(chars / 4)


def _override(settings: Settings, role: Purpose) -> Prices | None:
    agents = _pair(settings.llm_price_input_per_m, settings.llm_price_output_per_m)
    if role == "agents":
        return agents
    report = _pair(settings.report_price_input_per_m, settings.report_price_output_per_m)
    if report is not None:
        return report
    same_model = settings.report_model_name in (None, settings.llm_model_name)
    return agents if same_model else None


def _pair(input_per_m: float | None, output_per_m: float | None) -> Prices | None:
    if input_per_m is None or output_per_m is None:
        return None
    return Prices(input_per_m, output_per_m)
