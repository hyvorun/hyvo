# MiroFish notes: how it is wired, and how Hyvo extends it

Written before any Hyvo engine code that touches MiroFish (spec §0.2). It summarizes how MiroFish's agents,
actions, platforms, memory and report agent are wired, with file paths, and records the integration decision.
Detailed evidence (file:line citations, runtime probes on this laptop) is in three appendices:

- [`docs/mirofish/simulation-pipeline.md`](mirofish/simulation-pipeline.md): how MiroFish drives OASIS, Flask, IPC.
- [`docs/mirofish/oasis-internals.md`](mirofish/oasis-internals.md): OASIS agents, actions, platform, recsys, models.
- [`docs/mirofish/graph-memory-report.md`](mirofish/graph-memory-report.md): Zep graph, memory, ReportAgent, LLM client.

**Versions studied:** MiroFish `7657031` (subtree at `engine/mirofish/`), camel-oasis 0.2.5 (tag `v0.2.5`, byte-identical
to `engine/.venv/Lib/site-packages/oasis/`), camel-ai 0.2.78, Python 3.11.15 on Windows 11.
**Path conventions:** `backend/...` and `frontend/...` are relative to `engine/mirofish/`; `oasis/...` to the OASIS
package root; `camel/...` to `engine/.venv/Lib/site-packages/`.

---

## 1. Pipeline at a glance

| Stage | Runs in | Key code | Output |
|---|---|---|---|
| Graph build (seed docs → Zep graph) | Flask + Zep Cloud | `backend/app/api/graph.py`, `backend/app/services/graph_builder.py`, `ontology_generator.py` | `graph_id` |
| Prepare (personas + sim config) | Flask daemon thread | `backend/app/services/simulation_manager.py:244-477`, `oasis_profile_generator.py`, `simulation_config_generator.py` | `reddit_profiles.json`, `twitter_profiles.csv`, `simulation_config.json` |
| Run | subprocess `backend/scripts/run_parallel_simulation.py` | spawned by `simulation_runner.py:517-549` | `actions.jsonl` per platform, SQLite DBs |
| Report | Flask daemon thread | `backend/app/services/report_agent.py`, `zep_tools.py` | Markdown report |
| Deep interaction | Flask → file IPC → subprocess | `backend/app/services/simulation_ipc.py`, `report_agent.py:1810-1928` | interview answers, chat |

Twitter-style and Reddit-style platforms run as two coroutines in one process
(`run_parallel_simulation.py:1585-1589`). Zep is required by graph build, prepare (`zep_entity_reader.py:80-85`),
Flask boot (`config.py:69-70`) and the report agent (`zep_tools.py:430-438`), but **not** by the simulation
subprocess itself.

## 2. Agents

- **Profiles.** `OasisProfileGenerator` turns Zep entities into personas with an LLM (Chinese prompts,
  `oasis_profile_generator.py:540-816`) and writes the formats OASIS loads: Twitter CSV
  (`user_id,name,username,user_char,description`, `:1114-1163`) and Reddit JSON (`:1190-1237`). OASIS loaders
  `generate_twitter_agent_graph` / `generate_reddit_agent_graph` (`oasis/social_agent/agents_generator.py:567-649`)
  build one `SocialAgent` per row, with `agent_id` = row index.
- **SocialAgent** (`oasis/social_agent/agent.py`) is a camel `ChatAgent`. Its system prompt comes from `UserInfo`
  (`oasis/social_platform/config/user.py:50-111`); its observation is `SocialEnvironment.to_text_prompt`
  (`oasis/social_agent/agent_environment.py:118-135`): a `refresh()` of the feed as JSON.
- **Decision loop.** `env.step({agent: LLMAction()})` makes **exactly one LLM call per active agent per step**
  (`max_iteration = 1`, `agent.py:112`; `camel/agents/chat_agent.py:2069-2073`). Every tool call in that one
  response is executed. MiroFish activates a random subset of agents each round by simulated clock hour
  (`run_parallel_simulation.py:1040-1090`, unseeded `random`).
- **Model.** MiroFish builds one shared camel backend per platform with `ModelFactory.create(OPENAI, model)` after
  copying `LLM_API_KEY`/`LLM_BASE_URL` into `OPENAI_API_KEY`/`OPENAI_API_BASE_URL` (`run_parallel_simulation.py:984-1037`).
  No temperature is sent unless passed in `model_config_dict`.
- **Agent memory.** camel `ChatHistoryMemory` with no window; the full history is resent every call and the token
  limit is effectively infinite for unknown model names (`camel/models/base_model.py:529-542`). Cost grows roughly
  quadratically with rounds.

## 3. Actions

- **Action space.** `ActionType` (`oasis/social_platform/typing.py:17-49`): `create_post`, `like_post`, `repost`,
  `quote_post`, `create_comment`, `follow`, `mute`, `do_nothing`, `refresh`, `search_*`, `trend`, `interview`, groups,
  and more. MiroFish enables the Twitter defaults (`CREATE_POST, LIKE_POST, REPOST, FOLLOW, DO_NOTHING, QUOTE_POST`) and
  the Reddit defaults (13 actions) (`run_parallel_simulation.py:178-202`; `typing.py:51-78`).
- **Execution path.** `SocialAction` methods (`oasis/social_agent/agent_action.py:28-61`) are wrapped as camel
  `FunctionTool`s with `strict: true` schemas and filtered by `available_actions` (`agent.py:85-104`). A tool call goes
  through the `Channel` queue to `Platform.running`, which dispatches by name (`oasis/social_platform/platform.py:128-173`),
  runs SQL and writes a `trace` row.
- **Without an LLM.** `ManualAction(action_type, action_args)` (`oasis/environment/env_action.py:20-37`) runs any of the
  29 actions via `perform_action_by_data` (`agent.py:278-294`), ignoring `available_actions`. Several per agent per step
  are allowed. `env.step` returns `None`; new ids only come back from direct calls
  (`await agent.env.action.create_post(text)` → `{"success": True, "post_id": N}`). `INTERVIEW` is the exception: it
  triggers an LLM call (`env.py:161-168`).
- **Extension points.** `SocialAgent(tools=...)` accepts extra camel tools (`agent.py:68,105`), but the graph
  generators do not expose it, and `ChatAgent.add_external_tool` is broken in camel 0.2.78 (`chat_agent.py:779-783`).

## 4. Platforms

- **Database.** One SQLite file per platform, 16 tables (`oasis/social_platform/schema/*.sql`): `user`, `post`,
  `comment`, `like`, `dislike`, `follow`, `mute`, `trace`, `rec`, `report`, groups, products. Plain `CREATE TABLE`, so
  the file must be deleted before each run; no foreign-key enforcement.
- **Recsys.** `env.step` rebuilds the `rec` table at the start of every step (`env.py:151-153`).
  `reddit` (hot score, same list for everyone) and `random` need no ML. `twhin-bert` (forced by
  `DefaultPlatformType.TWITTER`) downloads `Twitter/twhin-bert-base` and runs torch on CPU; `twitter` crashes with
  `KeyError: 'post_id'` past `max_rec_post_len` (`recsys.py:670,786-789`).
- **Clocks.** Twitter mode increments `sandbox_clock.time_step` once per `env.step`; Reddit mode uses wall clock × 60
  (`oasis/clock/clock.py:25-30`), so rounds must be tracked outside OASIS.

## 5. Memory

- **Per-agent memory** is camel chat history only (section 2).
- **Zep knowledge graph.** `GraphBuilderService` chunks seed documents (500 chars) into Zep episodes after an
  LLM-generated ontology (`graph_builder.py`, `ontology_generator.py`). During a run, if
  `enable_graph_memory_update` is on, the Flask monitor forwards each action line to `ZepGraphMemoryUpdater`
  (`zep_graph_memory_updater.py:213-412`, batches of 5, Chinese episode templates). That flag defaults to off in the API
  but the stock UI turns it on (`frontend/src/components/Step3Simulation.vue:402`).

## 6. Report agent

- `ReportAgent.generate_report` (`report_agent.py:1576-1808`): one planning call (`plan_outline`, `:1176-1258`), then
  one ReACT loop per section using a text protocol (`<tool_call>{...}</tool_call>` or `Final Answer:`, `:727-742`),
  at least 3 and at most 5 tool calls per section. Tools: `insight_forge`, `panorama_search`, `quick_search`,
  `interview_agents`, all over Zep (`zep_tools.py:943-1480`).
- About 19-51 LLM calls per report, no token accounting, free-form Markdown output with no structured fields.
- The prompts frame the output as a "future prediction report" from a "god's-eye view" (`report_agent.py:553-569,
  625-637`). **That conflicts with Hyvo's copy rules and must not be copied.**
- Reusable patterns: anti-fabrication rules (`:662-671`), strict JSON handling, the `agent_log.jsonl` step log
  (`:36-305`), the bounded chat pattern (`:1810-1928`).

## 7. Deep interaction

- Report chat: `POST /api/report/chat` creates a new `ReportAgent` per request (`api/report.py:591-683`).
- Agent interviews: Flask writes a command file, the simulation subprocess (kept alive in "wait mode" after its loop)
  polls every 0.5 s and runs `ManualAction(INTERVIEW)` (`simulation_ipc.py:25-187`; `run_parallel_simulation.py:217-601`).

## 8. LLM client

`backend/app/utils/llm_client.py` (`chat`, `chat_json`) handles `response_format` fallback, `<think>` stripping and
strict JSON parsing, but **never records token usage** (`:131-232`). `openai_chat_compat.py:20-101` maps GPT-5 request
quirks. Simulation agents bypass it and use camel backends.

---

## 9. How Hyvo extends the action space (decision)

**Decision: option (c).** Hyvo runs its own round loop and uses OASIS directly as the social world. It does not wrap
`run_parallel_simulation.py` and never edits or imports MiroFish `app.*`.

- **Social substrate = OASIS.** One OASIS `Platform` per job with `recsys_type="reddit"` (or `"random"`), its own
  SQLite file, agents `0..N-1` (plus a narrator account for injected events) built as `SocialAgent`s on camel's
  `ModelType.STUB` backend with a custom token counter, so construction needs no key and no network.
- **Decisions = Hyvo.** Each round Hyvo builds one compact, stateless prompt per batch of K agents (persona, recent
  feed read from SQLite, `MarketState`, own balances and PnL, this round's events) and makes **one LLM call per batch**
  through its own budget-metered client. The response is a JSON list of decisions.
- **Execution.** Validated social decisions run through OASIS action methods (direct `agent.env.action.*` calls, so new
  ids come back); market decisions run through `engine/hyvo/actions` against the per-job anvil.

| Hyvo action | Mechanism | `run.json` |
|---|---|---|
| post | OASIS `create_post(content)` | `posts[]` with `id = p<post_id>` |
| reply | OASIS `create_comment(post_id, content)` | `posts[]` with `id = c<comment_id>`, `replyTo = p<post_id>` |
| like | OASIS `like_post(post_id)` | counted into `posts[].likes` |
| `swap_buy`, `swap_sell` | Hyvo actions layer → web3.py → `HyvoV2Router` on anvil | `actions[]` with amounts, txHash, status |
| `hold` | no transaction | `actions[]`, status `ok` |
| `check_market` | no transaction this round; next observation adds a detailed market panel | `actions[]`, status `ok` |

**Why not options (a)/(b) (OASIS LLM agents with extra swap tools):** no batching (one call per agent per step), no
usage surfaced anywhere, a fixed observation template with no hook for `MarketState`/PnL, unbounded memory, reliance
on strict native tool calling that cheap providers may not support, and no event-injection mechanism
(`scheduled_events` is never read). All of these collide with spec §6.3 and §6.6.

**Report agent deviation (needs founder sign-off; see `docs/OPEN_ITEMS.md`).** Spec §6.7 says "uses MiroFish's
ReportAgent". Running it as-is needs Zep, makes 19-51 uncounted calls, returns Markdown, and uses prediction framing.
Hyvo instead ships a light report agent in `engine/hyvo/report/` modeled on ReportAgent's structure and rules:
numbers computed in code, one structured LLM call, a banned-phrase guard, and the fixed disclaimer.

**"MiroFish runs locally" (Phase 1 DoD).** Hyvo's engine runs MiroFish's simulation substrate (OASIS) locally. A
separate smoke check of the stock `run_parallel_simulation.py --reddit-only --max-rounds 2 --no-wait` on fixture
profiles is planned once an LLM key exists.

## 10. Gotchas Hyvo must handle

| Gotcha | Mitigation in Hyvo |
|---|---|
| `import oasis` takes ~14 s (torch, sentence-transformers) | import once per runner process; optional `sys.modules` recsys stub (~4 s) |
| import creates `./log` with 4 open log files in the CWD | import from a fixed directory (`engine/.oasis-logs/`) |
| camel logs every observation to stdout; cp1252 emoji errors | `CAMEL_LOGGING_DISABLED=true`, `PYTHONUTF8=1` |
| tiktoken download when constructing agents on real backends | STUB backend + custom token counter |
| `OASIS_DB_PATH` is read on every observation; DB reused silently | set it to the job DB; delete the file before `env.reset()` |
| trace primary key rejects identical same-step actions | de-duplicate decisions per agent per round |
| `quote_post` first in feed crashes `refresh` | do not expose quote posts in Stage 1 |
| no FK checks (likes/replies to unknown ids "succeed") | validate every target id in Hyvo |
| wrong `ManualAction` kwarg raises mid-step | call action methods directly with checked arguments |
| Reddit clock follows the wall clock | track rounds in Hyvo (rowid ranges per round) |
| MiroFish `app.*` imports load `mirofish/.env` and write `backend/logs/` | never import `app.*`; port small functions with attribution |

## 11. What Hyvo reuses

| From | Reused as |
|---|---|
| OASIS `Platform`, schema, action semantics, trace | the social world of every run |
| `llm_client.py` JSON handling, `openai_chat_compat.py` | ported into `engine/hyvo/llm/` (with usage capture added) |
| ReportAgent anti-fabrication rules, step-log schema | `engine/hyvo/report/` prompts and logs |
| `fetch_new_actions_from_db` and helpers (`run_parallel_simulation.py:610-981`) | pattern for reading posts/likes per round |
| `graph_builder.py`, `zep_*.py` utilities | Stage 3 Narrative Engine (rolling graph), with a Hyvo ontology |

Ported code keeps an `Adapted from MiroFish <path> (AGPL-3.0)` comment.

## 12. Upstream updates and license

- Update: `git subtree pull --prefix=engine/mirofish mirofish-upstream main --squash`, then
  `uv run python scripts/sync_mirofish_constraints.py && uv lock && uv sync` in `engine/`, then the engine tests.
- MiroFish is **AGPL-3.0**. The engine (`engine/`, `AGPL-3.0-or-later`) contains adapted MiroFish code and links OASIS
  (Apache-2.0). Because Hyvo serves results to users over a network, plan to publish the engine source. See
  `docs/OPEN_ITEMS.md` item 1.
