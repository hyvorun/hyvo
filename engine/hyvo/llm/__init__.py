"""Hyvo LLM layer: clients, budgets and the replay log.

Import from the submodules (this package does not re-export them, so importing the light
modules does not pull in the OpenAI SDK):

- ``types``          ChatMessage, LLMResult, Prices, errors, the ``LLMClient`` protocol
- ``protocol``       ``HYVO_PROTOCOL: <name>/v<k>`` tags that route prompts to offline responders
- ``json_utils``     strict JSON-object parsing of model output
- ``pricing``        price table, price resolution, token estimates, cost math
- ``openai_compat``  ``OpenAICompatClient`` for any OpenAI-compatible endpoint
- ``offline``        ``OfflineClient``: deterministic rules model, no network
- ``budget``         ``BudgetMeter``: ``maxCostUsd`` / ``maxLlmCalls`` with a report reserve
- ``log``            ``LLMLog``: ``llm-log.jsonl`` replay log
- ``metered``        ``MeteredClient``: budget check, call, record, log
- ``factory``        ``make_clients``: agents and report clients from settings
"""
