# MiroFish simulation pipeline and runtime plumbing: notes for Hyvo

Area: how MiroFish drives OASIS, plus the Flask, IPC and runtime plumbing.
Spec context: `C:\.hyvo\docs\SPEC.md` sections 1, 5, 6 and 14 (run.json, injectedEvents, batched decisions, budgets, Phase 1 DoD).

## 0. Sources, versions and method

| Code | Root used for citations | Version |
|---|---|---|
| MiroFish (AGPL-3.0, vendored read-only) | `C:\.hyvo\engine\mirofish`, cited as `backend/...`, `frontend/...` | backend pyproject 0.1.0 |
| OASIS | `oasis-src/oasis` (a local checkout), cited as `oasis/...` | camel-oasis 0.2.5, tag v0.2.5, commit e97a1d8 |
| CAMEL | `C:\.hyvo\engine\.venv\Lib\site-packages`, cited as `camel/...` | camel-ai 0.2.78 |

- The installed `.venv/Lib/site-packages/oasis` is byte-identical to the source checkout (`diff -rq`, no differences).
- MiroFish pins `camel-oasis==0.2.5` and `camel-ai==0.2.78` (`backend/pyproject.toml:24-25`) with `requires-python >=3.11,<3.13` (`:5`). OASIS itself requires `python >=3.10.0,<3.12` (OASIS root `pyproject.toml:25`) and pulls torch, sentence-transformers, igraph and neo4j. The Hyvo engine pins the same versions with `>=3.11,<3.12` (`C:\.hyvo\engine\pyproject.toml:5,9-10`).
- I ran three read-only runtime probes from a scratch working directory (`python -B`, no bytecode written, nothing in the repo modified, no LLM call). Results:
  - Python 3.11.15 on win32. `import oasis` took **12.9 s**. It created `./log/` in the **current working directory** with 4 files: `oasis-*.log`, `social.agent-*.log`, `social.twitter-*.log`, `table-*.log`.
  - torch 2.9.1+cpu, `cuda.is_available() == False`.
  - CAMEL token limits: `qwen-plus` 131072, `deepseek-chat` 64000, `gpt-4o-mini` 128000. An unknown name such as `deepseek-v4-flash` gets **999,999,999** and logs the warning "Invalid or missing `max_tokens`...".
  - On Windows, `subprocess.Popen._execute_child` has the parameters `unused_start_new_session` and `unused_process_group`.
  - OASIS tool-schema size per LLM call: Twitter 6 tools = 2,970 chars (about 740 tokens). Reddit 13 tools = 6,752 chars (about 1,690 tokens). Schemas include `"strict": true`.
- Anything I did not see in code or probes is labelled **(inferred)**.

---

## Q1. End-to-end pipeline: what runs where

### 1.1 Stage map

| Stage | Trigger | Runs in | Key code | Output |
|---|---|---|---|---|
| Graph build | `/api/graph/*` | Flask (Zep Cloud) | `backend/app/api/graph.py`, `services/graph_builder.py` | `project.graph_id` |
| Create sim | `POST /api/simulation/create` | Flask request | `api/simulation.py:195-267`, `SimulationManager.create_simulation` `services/simulation_manager.py:208-242` | `backend/uploads/simulations/sim_<12hex>/state.json` |
| Prepare (env setup) | `POST /api/simulation/prepare` | Flask **daemon thread** `run_prepare` | `api/simulation.py:538-647`, `simulation_manager.py:244-477` | `reddit_profiles.json`, `twitter_profiles.csv`, `simulation_config.json` |
| Prepare progress | `POST /api/simulation/prepare/status` | Flask | in-memory `TaskManager` singleton `backend/app/models/task.py:56-73` | task progress (lost on restart) |
| Run | `POST /api/simulation/start` | **subprocess** `python backend/scripts/run_parallel_simulation.py --config <sim_dir>/simulation_config.json [--max-rounds N]` | `services/simulation_runner.py:371-617` (Popen `517-549`) | per-platform `actions.jsonl`, SQLite DBs |
| Monitor | started by `start_simulation` | Flask **daemon thread** `_monitor_simulation` | `simulation_runner.py:620-764`, `767-879` | `run_state.json`; optional Zep ingestion |
| Report | `/api/report/generate` | Flask daemon thread | `api/report.py:32-295`, `services/report_agent.py:871+` | report; its InterviewAgents tool goes through IPC (`services/zep_tools.py:1270-1382`) |
| Deep interaction | `POST /api/simulation/interview/batch`, `/api/report/chat` | Flask → **file IPC** → subprocess | `api/simulation.py:2433+`, `simulation_runner.py:1757-1814`; UI `frontend/src/components/Step5Interaction.vue:694,730-736,817` | interview answers |
| Close / stop | `/api/simulation/close-env` (IPC) or `/api/simulation/stop` (kill) | IPC or process kill | `simulation_runner.py:1876-1922`, `965-1084` | process exit |

### 1.2 How the run step works

- Flask spawns `[sys.executable, script_path, "--config", config_path]` with `cwd=sim_dir`. stdout and stderr go to `simulation.log`. The child env gets `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8`. `start_new_session=True` is also passed (`simulation_runner.py:517-549`).
- Script choice (`simulation_runner.py:466-475`):
  - `platform="parallel"` → `run_parallel_simulation.py`
  - `twitter` → `run_twitter_simulation.py`
  - `reddit` → `run_reddit_simulation.py`
- The single-platform scripts are **legacy**. They never write `actions.jsonl`: they do not import `action_logger` (`backend/scripts/run_twitter_simulation.py:16-131`). So the Flask monitor cannot see their progress **(inferred)**. They also do not check `_shutdown_event` inside the loop (`run_twitter_simulation.py:633-663`). The parallel script supports `--twitter-only` and `--reddit-only` with full logging (`run_parallel_simulation.py:1500-1509,1579-1582`).
- **Parallelism.** Twitter and Reddit run as two coroutines in one process and one event loop: `asyncio.gather(run_twitter_simulation(...), run_reddit_simulation(...))` (`run_parallel_simulation.py:1585-1589`). Each coroutine has its own OasisEnv, SQLite DB, Channel and model object. There are no threads or processes per platform.
- **Wait mode.** Flask never passes `--no-wait` (`simulation_runner.py:517-525`). After its loop the child enters wait-for-commands mode and keeps both envs alive for interviews (`run_parallel_simulation.py:1595-1633`). This is required by the report agent's InterviewAgents tool (`zep_tools.py:1288` "requires the simulation env to be running").
- **Status semantics.**
  - Platform completion is detected from the `simulation_end` line in `actions.jsonl` (`simulation_runner.py:806-828`).
  - `runner_status=COMPLETED` is published only after the **process exits** and any Zep drain finishes (`simulation_runner.py:670-745`; comment at `821-824`).
  - Consequence: in the stock flow the child stays alive in wait mode with `runner_status=running`, while `twitter_completed` and `reddit_completed` are true. It becomes `completed` only after close-env or stop. The UI's `checkPlatformsCompleted` helper is defined but unused (`Step3Simulation.vue:538-559`) **(inferred UX gap)**.
- **Enums.**
  - `SimulationStatus` (`simulation_manager.py:25-35`): created, preparing, ready, running, stopping, paused, stopped, completed, failed.
  - `RunnerStatus` (`simulation_runner.py:40-49`): idle, starting, running, paused, stopping, stopped, completed, failed. PAUSED is never set by any code path **(inferred, grep)**.
- **UI start parameters.** Step3 starts the run with `platform:'parallel', force:true, enable_graph_memory_update:true` (`frontend/src/components/Step3Simulation.vue:398-403`). It polls `/run-status` every 2 s and `/run-status/detail` every 3 s (`Step3Simulation.vue:470-474`).
- **Flask process.**
  - `backend/run.py:25-45`: `Config.validate()` must pass, then `app.run(threaded=True)` on port 5001.
  - `create_app` (`backend/app/__init__.py:19-79`) registers the `/api/graph`, `/api/simulation` and `/api/report` blueprints, plus `SimulationRunner.register_cleanup()` (`:46-47`).
  - All state is files under `backend/uploads/` plus in-memory class dicts (`simulation_runner.py:228-239`). There is no database.

---

## Q2. How MiroFish builds OASIS agents

### 2.1 Profile generation (`backend/app/services/oasis_profile_generator.py`)

- **Input type.** `EntityNode` is a plain dataclass with `uuid, name, labels, summary, attributes, related_edges, related_nodes` (`services/zep_entity_reader.py:21-50`). Normally it comes from Zep via `ZepEntityReader.filter_defined_entities` (`simulation_manager.py:294-303`), but it can be constructed by hand.
- **Output type.** The `OasisAgentProfile` dataclass (`oasis_profile_generator.py:79-121`) has:
  - user_id, user_name, name, bio, persona, karma, friend_count, follower_count, statuses_count
  - age, gender, mbti, country, profession, interested_topics
  - source_entity_uuid, source_entity_type, created_at
  - `__post_init__` coerces structured LLM values to strings (`:111-121`, helpers `:34-76`).
- **Per-entity generation** (`generate_profile_from_entity`, `:274-336`):
  - Username is the lowercased name plus a random 3-digit suffix (`:338-346`).
  - Context comes from entity attributes, edges and related nodes, plus optional Zep search (`:457-530`).
  - It calls `_generate_profile_with_llm` (`:540-625`) with OpenAI `response_format=json_object`. Up to 3 attempts, temperature 0.7, 0.6, 0.5. JSON repair on failure (`:627-714`), and a rule-based fallback (`:818-889`).
  - The prompts are Chinese (`:716-816`). They ask for a 200-char bio, a 2000-char persona, age, gender (male/female, or "other" for groups), mbti, country, profession and interested_topics. Individual vs group prompts are chosen by type lists (`:231-241`).
- **Batch generation.** `generate_profiles_from_entities` (`:895-1058`) uses `ThreadPoolExecutor(max_workers=parallel_count)` (`:1003`). The API default is `parallel_profile_count=5` (`api/simulation.py:499`). It saves files in real time after each completion (`:933-961`).
- **Zep is optional here.** With no `ZEP_API_KEY`, `zep_client=None` (`:264-272`) and `_search_zep_for_entity` returns empty results (`:363-364`). The constructor does require `LLM_API_KEY` (`:255-256`).
- **Language.** Prompts append `get_language_instruction()`. `locale` defaults to `'zh'` outside a request (`backend/app/utils/locale.py:28-32,66-69`).

### 2.2 File formats (what OASIS actually reads)

**Twitter CSV**

Written by `_save_twitter_csv` (`oasis_profile_generator.py:1114-1163`):
- Header: `user_id,name,username,user_char,description` (`:1139`).
- `user_char` = `bio + " " + persona` with newlines replaced by spaces (`:1145-1149`). `description` = bio.

Read by OASIS `generate_twitter_agent_graph` (`oasis/social_agent/agents_generator.py:614-649`):
- Loads with `pd.read_csv`. Uses only `username`, `user_char` and `description`. `agent_id` = **row index** (`:624-646`).
- System prompt (`oasis/social_platform/config/user.py:50-77`): "Your name is {username}. Your have profile: {user_char}. ... Please perform actions by tool calling."

**Reddit JSON**

Written by `_save_reddit_json` (`oasis_profile_generator.py:1190-1237`). It is a list of:
```json
{"user_id": 0, "username": "...", "name": "...", "bio": "<=150 chars", "persona": "...", "karma": 1000,
 "created_at": "YYYY-MM-DD", "age": 30, "gender": "male|female|other", "mbti": "ISTJ", "country": "中国",
 "profession": "...", "interested_topics": ["..."]}
```
Defaults are applied for age, gender, mbti and country (`:1220-1224`). Gender normalization is at `:1165-1188`.

Read by OASIS `generate_reddit_agent_graph` (`agents_generator.py:567-611`):
- Required keys (KeyError if missing): `persona, mbti, gender, age, country, username, bio` (`:585-593`). `agent_id` = **list index** `i` (`:598-600`). The JSON `user_id` is ignored by OASIS.
- System prompt adds "You are a {gender}, {age} years old, with an MBTI personality type of {mbti} from {country}." (`user.py:79-111`).

**Other format facts**

- **Sign-up.** `env.reset()` calls `generate_custom_agents`, which calls `sign_up(user_name=agent.user_info.user_name, name=..., bio=description)` (`agents_generator.py:547-564`). Because the loaders build `UserInfo(name=username, ...)`, `user_name` is None in the `user` table (`user.py:24-26`). The platform inserts `user_id = agent_id` (`oasis/social_platform/platform.py:178-206`).
- **Stale validator.** `backend/scripts/test_profile_format.py` checks old field sets. For Twitter it expects user_name, bio, friend_count... (`:89-90`). For Reddit it expects `realname` (`:113`). It is a print-only script, not a pytest test. Trust the `_save_*` writers and the OASIS loaders.
- **Index invariant.** `agent_configs[i].agent_id`, the CSV row index, the JSON list index and `initial_posts[].poster_agent_id` must all agree. MiroFish guarantees this by enumerating the same entity list for both:
  - profile `user_id=idx` (`oasis_profile_generator.py:974`)
  - config `agent_id = start_idx + i` (`simulation_config_generator.py:884`)
- **Real-time partial Twitter CSV.** The CSV saved during generation uses `to_twitter_format()` keys (no `user_char`), which OASIS cannot load (`oasis_profile_generator.py:951-959`). The final `save_profiles(..., "twitter")` overwrites it with the correct format (`simulation_manager.py:388-394`).

### 2.3 Simulation config (`backend/app/services/simulation_config_generator.py`)

**Dataclasses**
- `AgentActivityConfig` (`:52-81`): agent_id, entity_uuid, entity_name, entity_type, activity_level, posts_per_hour, comments_per_hour, active_hours, response_delay_min/max, sentiment_bias, stance, influence_weight.
- `TimeSimulationConfig` (`:84-111`): total_simulation_hours=72, minutes_per_round=60, agents_per_hour_min=5, agents_per_hour_max=20, peak_hours, peak_activity_multiplier=1.5, off_peak_hours, off_peak_activity_multiplier=0.05, morning_*, work_*.
- `EventConfig` (`:114-127`): initial_posts, scheduled_events, hot_topics, narrative_direction.
- `PlatformConfig` (`:130-144`).
- `SimulationParameters.to_dict` (`:177-194`) is the JSON schema written to `simulation_config.json` (`simulation_manager.py:443-445`).

**LLM cost of config generation**
- 3 + ceil(N/15) calls: time config, event config, then agent batches of 15 (`:217,276-327`).
- Each call has 3 attempts with JSON repair (`:435-535`) and falls back to defaults or rules on failure (`:593-611,710-719,874-879,910-991`).
- Initial-post authors are assigned by matching `poster_type` to entity types or aliases. The fallback is the agent with the highest `influence_weight` (`:730-813`).

**Fields actually consumed at runtime** (by `run_parallel_simulation.py`):
- `time_config`: `total_simulation_hours, minutes_per_round` (`:1214-1217`) and `agents_per_hour_min/max, peak_hours, off_peak_hours, peak_activity_multiplier, off_peak_activity_multiplier` (`:1047-1061`).
- `agent_configs[]`: `agent_id, active_hours, activity_level` (`:1066-1075`) and `entity_name` (names in logs, `:633-654`).
- `event_config.initial_posts[]`: `poster_agent_id, content` (`:1172-1189`).
- `llm_model`, used only if `LLM_MODEL_NAME` is unset (`:1019-1020`). `simulation_id` is used for logging only.

**Generated but never used by the simulation.** A grep over `backend/` and `frontend/` finds them only in the generator and in `frontend/src/components/Step2EnvSetup.vue` (display), plus counts at `api/simulation.py:1287-1289`:
- `posts_per_hour`, `comments_per_hour`, `response_delay_*`, `sentiment_bias`, `stance`
- `influence_weight` (only used for the initial-post fallback)
- `morning_*` and `work_*` multipliers
- `hot_topics`, `narrative_direction`
- `scheduled_events`: always `[]` (`:725`), never read
- `twitter_config` and `reddit_config` (recsys weights; OASIS never receives them)
- `llm_base_url`

### 2.4 LLM model for OASIS agents

`create_model(config, use_boost)` (`run_parallel_simulation.py:984-1037`):
```python
llm_api_key = os.environ.get("LLM_API_KEY"); llm_base_url = os.environ.get("LLM_BASE_URL"); llm_model = os.environ.get("LLM_MODEL_NAME") or config.get("llm_model","gpt-4o-mini")
os.environ["OPENAI_API_KEY"] = llm_api_key; os.environ["OPENAI_API_BASE_URL"] = llm_base_url
return ModelFactory.create(model_platform=ModelPlatformType.OPENAI, model_type=llm_model)
```
- Twitter uses `use_boost=False`. Reddit uses `use_boost=True`, so `LLM_BOOST_API_KEY/BASE_URL/MODEL_NAME` are used if `LLM_BOOST_API_KEY` is non-empty (`:998-1016`, `:1130`, `:1322`). Config is passed by mutating process-global `os.environ`. It works only because each model is constructed synchronously before the first `await` **(inferred, fragile)**.
- **Placeholder trap.** `.env.example:14-16` ships `LLM_BOOST_API_KEY=your_api_key_here`. If that is left in place, Reddit uses garbage credentials (the file itself warns about this).
- **CAMEL side.** `ModelFactory.create(model_platform, model_type, model_config_dict=None, token_counter=None, api_key=None, url=None, timeout=None, max_retries=3)` (`camel/models/model_factory.py:113-121`). `OpenAIModel.__init__` (`camel/models/openai_model.py:103-162`) then uses:
  - api_key = `OPENAI_API_KEY`, url = `OPENAI_API_BASE_URL`, timeout = `MODEL_TIMEOUT` env var or 180 s (`:116-118`)
  - OpenAI and AsyncOpenAI clients with `max_retries=3` (`:149-161`)
  - `model_config_dict = ChatGPTConfig().as_dict()` with every None removed (`camel/configs/openai_config.py` fields 111-125; `camel/configs/base_config.py:64-86`). So **no temperature and no max_tokens** are sent. Hyvo must pass `model_config_dict={"temperature": 0.8}` explicitly.
- **Shared client.** One model object is shared by all agents of a platform, so there is one AsyncOpenAI client.
- **Context limit.** `BaseModelBackend.token_limit = model_config_dict.get("max_tokens") or model_type.token_limit` (`camel/models/base_model.py:530-542`). Known names get the real context window. Unknown names get 999,999,999 (probe; `camel/types/unified_model_type.py:64-71`). MiroFish deliberately hides that warning (`run_parallel_simulation.py:106-117`).
- **Provider requirement.** The provider must support OpenAI tool calling. Agents act only via tool calls, and tool schemas carry `"strict": true` (probe) **(inferred risk: some compatible providers reject `strict`)**.

### 2.5 Actions enabled per platform

- Twitter (`run_parallel_simulation.py:178-185`): `CREATE_POST, LIKE_POST, REPOST, FOLLOW, DO_NOTHING, QUOTE_POST`. This equals `ActionType.get_default_twitter_actions()` (`oasis/social_platform/typing.py:51-60`).
- Reddit (`:188-202`): `LIKE_POST, DISLIKE_POST, CREATE_POST, CREATE_COMMENT, LIKE_COMMENT, DISLIKE_COMMENT, SEARCH_POSTS, SEARCH_USER, TREND, REFRESH, DO_NOTHING, FOLLOW, MUTE`. This equals `get_default_reddit_actions()` (`typing.py:62-78`).
- `INTERVIEW` is deliberately excluded from the LLM tools and used only via `ManualAction` (`:177,187`).
- `Config.OASIS_TWITTER_ACTIONS` and `Config.OASIS_REDDIT_ACTIONS` (`backend/app/config.py:49-56`) are unused duplicates.
- The full `ActionType` enum is at `typing.py:17-49`. It includes PURCHASE_PRODUCT, groups and report_post.
- **Tool mechanics.**
  - `SocialAgent.__init__` filters `SocialAction.get_openai_function_list()` (29 functions, `oasis/social_agent/agent_action.py:28-61`) by `available_actions` (`oasis/social_agent/agent.py:85-104`).
  - It accepts extra `tools=` (`agent.py:68,105`). This is the **extension point for non-social tools** such as swaps.
  - `generate_*_agent_graph` do not pass `tools` or `user_info_template` (`agents_generator.py:598-604,640-646`). To use those parameters you must construct `SocialAgent` yourself.
  - `perform_action_by_data` looks up **all** SocialAction functions, not the filtered list (`agent.py:278-294`). So `ManualAction` can execute any social action.

---

## Q3. The simulation loop

### 3.1 Rounds vs simulated time

- Round count:
  - `total_rounds = (total_simulation_hours*60)//minutes_per_round` (`run_parallel_simulation.py:1214-1217`).
  - Script defaults are 72 h and 30 min (144 rounds). Generator defaults are 72 h and 60 min (72 rounds).
  - `--max-rounds` truncates the count (`:1220-1224`). `Config.OASIS_DEFAULT_MAX_ROUNDS=10` (`config.py:45`) is unused (grep).
- Clock hour per round: `simulated_hour = (round*minutes_per_round//60) % 24`, so **round 0 starts at 00:00** (`:1235-1237`). Early rounds therefore land in off-peak hours.
- MiroFish's clock is used **only** for agent activation. OASIS keeps its own clocks:
  - **Twitter:** `platform.sandbox_clock.time_step += 1` after every `env.step()` (`oasis/environment/env.py:196-198`). That integer becomes `created_at` in post and trace rows (`platform.py:400-405`). Initial-post steps and interview steps also increment it.
  - **Reddit:** `created_at = start_time + 60 × (wall-clock elapsed)` via `Clock(60)` (`platform.py:76-81`; `oasis/clock/clock.py:25-30`). Reddit timestamps depend on **real run duration**, not on `minutes_per_round`.

### 3.2 Which agents act each round (`get_active_agents_for_round`, `run_parallel_simulation.py:1040-1090`)

```
mult = peak_activity_multiplier (1.5) if hour in peak_hours
     | off_peak_activity_multiplier (generator writes 0.05; script default 0.3) if hour in off_peak_hours
     | 1.0
target = int(random.uniform(agents_per_hour_min, agents_per_hour_max) * mult)
candidates = [a for a in agent_configs if hour in a.active_hours and random.random() < a.activity_level]
active = random.sample(candidates, min(target, len(candidates)))
```
- `random` is the unseeded global module, so runs are **not reproducible**.
- At off-peak hours with multiplier 0.05, `target` is usually 0, so the whole round is skipped (`:1247-1251`).
- "agents_per_hour" is really per round **(inferred naming mismatch)**.

**Per active agent**
- The env receives `{agent: LLMAction()}` (`:1253-1254`). `env.step` calls `agent.perform_action_by_llm()` under `asyncio.Semaphore(30)` (`:1155-1160`; `env.py:69-70,124-128`).
- That is **exactly one model call per active agent per round**. `SocialAgent` sets `self.max_iteration = 1` after `super().__init__` (`agent.py:112`), and CAMEL breaks the loop after one iteration (`camel/agents/chat_agent.py:2069-2073`) or when there are no tool calls (`:2078`).
- All tool calls in that single response are executed (`chat_agent.py:2038-2063`), so one LLM call can produce several social actions.
- Agents that are not selected do not observe anything that round.

### 3.3 What an agent sees

- `perform_action_by_llm` (`agent.py:125-155`) sends the user message "Please perform social media actions after observing the platform environments... Here is your social media environment: {env_prompt}".
- `env_prompt` = groups text + "After refreshing, you see some posts <JSON, indent=4, with comments>" + "pick one you want to perform action..." (`oasis/social_agent/agent_environment.py:49-66,118-135`).
- Follower and follow counts are computed but **not included** in the template (`:49-53` vs `:130-135`). They are also read from the wrong DB: `get_db_path()` resolves to `OASIS_DB_PATH` or the package `data/` dir (`oasis/social_platform/database.py:62-74`).
- **Feed (recommendation system).** `env.step` rebuilds the `rec` table at the **start** of every step (`env.py:151-153`). `refresh` samples from `rec` (`platform.py:258-326`).
  - **Reddit** (`env.py:87-97`): hot score, top `max_rec_post_len=100` posts, identical for every user (`oasis/social_platform/recsys.py:213-259`). Each refresh samples `refresh_rec_post_count=5` of them. No ML.
  - **Twitter** (`env.py:76-85`): `recsys_type="twhin-bert"`, `max_rec_post_len=2`, `refresh_rec_post_count=2`, plus up to 3 posts from followed users.
    - It lazily downloads and runs HF `Twitter/twhin-bert-base` on CPU (`recsys.py:64-80,419-606`).
    - Errors are swallowed and the rec update is skipped (`platform.py:372-375`).
    - It keeps **module-global state** (`recsys.py:48-61`; `reset_globals` at `124-133`), so two Twitter envs in one process share state **(inferred corruption risk)**.
    - `pdb.set_trace()` traps exist only when `enable_like_score=True` (`recsys.py:564-565,579-580`). The default is False, so they are not reached.
- **Memory.**
  - `ChatHistoryMemory` with no window (`chat_agent.py:478-487`).
  - Every step appends the full env prompt (`chat_agent.py:1981`), plus the tool-call and tool-result messages.
  - The whole history is resent each round. It is pruned only at `token_limit` (64k to 131k for known models, 999,999,999 for unknown ones).
  - So input tokens per call grow linearly with the agent's active rounds, and total tokens grow quadratically **(inferred from code)**.
  - On top of that, each call carries a fixed tool-schema load of about 740 (Twitter) or 1,690 (Reddit) tokens (probe), plus a persona of up to about 2000 Chinese characters.

### 3.4 How actions are logged

**`actions.jsonl` format** (`backend/scripts/action_logger.py:22-116`; files `<sim_dir>/twitter/actions.jsonl` and `<sim_dir>/reddit/actions.jsonl`):
```jsonc
{"round": 3, "timestamp": "<local ISO>", "agent_id": 7, "agent_name": "<entity_name>", "action_type": "CREATE_POST",
 "action_args": {"content": "...", "post_id": 12}, "result": null, "success": true}                       // action line
{"round": 3, "timestamp": "...", "event_type": "round_start", "simulated_hour": 2}
{"round": 3, "timestamp": "...", "event_type": "round_end", "actions_count": 9}
{"timestamp": "...", "event_type": "simulation_start", "platform": "twitter", "total_rounds": 144, "agents_count": 50}
{"timestamp": "...", "event_type": "simulation_end", "platform": "twitter", "total_rounds": 72, "total_actions": 812}
```
- Action lines are **not** taken from the LLM response. After each `env.step`, `fetch_new_actions_from_db` reads OASIS `trace` rows with `rowid > last_rowid` (`run_parallel_simulation.py:657-746`). It then:
  - drops `refresh` and `sign_up` (`:611`)
  - maps names to upper case (`:614-630`)
  - keeps only `content, post_id, comment_id, quoted_id, new_post_id, follow_id, query, like_id, dislike_id` (`:708-727`)
  - enriches entries with post or comment text and author names (`_enrich_action_context` and helpers, `:749-981`)
- `result` is always null and `success` always true, because callers never pass them (`:1263-1270`).

**OASIS SQLite schema** (`oasis/social_platform/schema/*.sql`):
```sql
CREATE TABLE trace (user_id INTEGER, created_at DATETIME, action TEXT, info TEXT,
  PRIMARY KEY(user_id, created_at, action, info));                       -- trace.sql:2 (info = json.dumps(action_info), platform_utils.py:188-213)
CREATE TABLE post (post_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, original_post_id INTEGER, content TEXT DEFAULT '',
  quote_content TEXT, created_at DATETIME, num_likes INTEGER DEFAULT 0, num_dislikes INTEGER DEFAULT 0,
  num_shares INTEGER DEFAULT 0, num_reports INTEGER DEFAULT 0);          -- post.sql:3
CREATE TABLE user (user_id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER, user_name TEXT, name TEXT, bio TEXT,
  created_at DATETIME, num_followings INTEGER DEFAULT 0, num_followers INTEGER DEFAULT 0);   -- user.sql:2
CREATE TABLE comment (comment_id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, user_id INTEGER, content TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, num_likes INTEGER DEFAULT 0, num_dislikes INTEGER DEFAULT 0); -- comment.sql:2
-- also follow(follow_id, follower_id, followee_id, created_at) follow.sql:2, rec(user_id, post_id) rec.sql:2, like, dislike, mute, report, groups
```
- `refresh` writes the full list of seen posts into `trace.info` on every observation (`platform.py:319-322`), so the trace table grows quickly.
- `create_db` prints and ignores "table already exists" (`database.py:198-199`). Reusing a DB path silently mixes runs. MiroFish deletes the DB first (`run_parallel_simulation.py:1151-1153,1342-1344`).

**Logging bugs (inferred from code, high confidence)**
- `simulation_start.total_rounds = total_simulation_hours * 2`, which assumes 30-minute rounds (`action_logger.py:98`).
- `round_end` has no `simulated_hours`, but the Flask monitor reads `action_data.get("simulated_hours", 0)`. Displayed hours are therefore always 0 (`simulation_runner.py:833`).
- **Initial posts are logged twice.** They are logged once manually as round 0 (`run_parallel_simulation.py:1192-1201`). Then `last_rowid` is still 0 (`:1169`), so the first active round re-reads those `create_post` trace rows and logs them again with round ≥ 1 (`:1257-1272`).
- **Twitter initial posts by the same agent overwrite each other.** The dict key is the agent (`:1186-1190`), but all of them are logged. The Reddit branch handles lists correctly (`:1378-1389`).
- `simulation_end.total_rounds` is the planned value, not the number executed (`:1284`).
- Failed decisions leave **no trace at all** (see Q5).

### 3.5 Injecting events or posts at a given round

- The only mechanism is `event_config.initial_posts`, executed once before round 1 as `ManualAction(CREATE_POST, {"content": ...})` by `poster_agent_id` (`run_parallel_simulation.py:1171-1211`).
- `scheduled_events` is declared (`simulation_config_generator.py:121`) but always `[]` (`:725`) and **never read** (grep).
- `hot_topics` and `narrative_direction` are never shown to agents.
- IPC is not polled during the loop, so nothing can be injected at runtime.
- **How Hyvo can do it with OASIS (no MiroFish edits).** Before round `r`'s decision step, run
  `await env.step({narrator_agent: [ManualAction(ActionType.CREATE_POST, {"content": e.text}) for e in events_at_r]})`.
  The post then exists before round `r`, and round `r`'s `update_rec_table` sees it (`env.py:151-153,158-175`).
  - Caveat: neither recsys **guarantees** exposure. Reddit samples 5 of the top-100 hot posts; Twitter shows 2 recommended plus 3 followed.
  - For SPEC 5.2 `injectedEvents`, put the event text directly into every agent's per-round observation built by Hyvo, and also post it to the feed for replay.
  - Each extra `env.step` increments the Twitter `time_step`.

---

## Q4. IPC (`backend/app/services/simulation_ipc.py`): how Flask talks to a running simulation

**Mechanism:** file system polling only. No sockets, pipes, signals or shared memory.

- **Command.** Flask writes `<sim_dir>/ipc_commands/<uuid4>.json` = `{"command_id", "command_type": "interview"|"batch_interview"|"close_env", "args", "timestamp"}` (`simulation_ipc.py:25-29,40-63,139-149`).
- **Response.** Flask polls `<sim_dir>/ipc_responses/<command_id>.json` every 0.5 s until `timeout`, then deletes both files (`:153-187`). The response is `{"command_id", "status": "completed"|"failed", "result", "error", "timestamp"}` (`:66-92`).
- **Child side** (`run_parallel_simulation.py:217-601`), **only in wait mode** after the loop (`:1603-1631`):
  - Every 0.5 s (`asyncio.wait_for(_shutdown_event.wait(), 0.5)`, `:1615-1624`) it takes the **oldest** command file by mtime (`:256-277`) and dispatches it (`:560-601`).
  - It writes the response and deletes the command file (`:279-298`).
  - `close_env` returns False, which exits the wait loop and leads to `env.close()` (`:594-597,1635-1642`).
- **Args.**
  - interview: `{agent_id, prompt, platform?}`. With no platform, both platforms are asked in parallel (`:345-414`).
  - batch_interview: `{interviews:[{agent_id, prompt, platform?}], platform?}`. Requests are grouped per platform and run as one `env.step` each (`:416-515`).
  - close_env: `{}`.
- **Interview execution.**
  - `env.step({agent: ManualAction(ActionType.INTERVIEW, {"prompt": p})})` calls `agent.perform_interview` (`env.py:177-184`).
  - That makes a direct model call with the agent's memory context and **no tools** (`agent.py:197-249`).
  - The platform records trace action `interview` with info `{prompt, response, interview_id}` (`platform.py:1348-1392`).
  - The handler reads it back with `SELECT ... WHERE action='interview' AND user_id=? ORDER BY created_at DESC LIMIT 1` (`run_parallel_simulation.py:517-558`).
  - Interviews are not written to memory unless `interview_record=True` (default False, `agent.py:70,205-207,231-234`). That is why the UI pastes chat history into the prompt (`Step5Interaction.vue:725-727`).
  - The API adds a Chinese prefix meaning "answer in text, don't call tools" (`api/simulation.py:55-73,2397`).
- **Liveness.** `env_status.json` = `{status: "alive"|"stopped", twitter_available, reddit_available, timestamp}` (`run_parallel_simulation.py:246-254`). It is set to `alive` at `:1611` and `stopped` at `:1633`. `check_env_alive` only reads that file and does **no PID check** (`simulation_ipc.py:270-285`).
- **Timeouts:** interview 60 s, batch 120 s, all-agents 180 s, close 30 s (`simulation_runner.py:1700,1763,1822,1880`). The report agent uses 180 s (`zep_tools.py:1381`).
- **Dead code:** `SimulationIPCServer` (`simulation_ipc.py:288-394`) is exported but unused (grep). The scripts carry their own copies of the handler.
- **Stop is not IPC.** `stop_simulation` (`simulation_runner.py:965-1084`) calls `_terminate_process` (`:909-962`).

**Windows compatibility**

- `start_new_session=True` (`simulation_runner.py:548`) is ignored on Windows: the probe shows `unused_start_new_session`. It is harmless.
- The POSIX-only `os.getpgid`, `os.killpg` and SIGKILL calls are confined to the non-Windows branch (`:947-962`).
- **Windows kill path** (`:918-946`):
  1. `taskkill /PID <pid> /T` (no /F)
  2. wait 10 s
  3. `taskkill /F /PID <pid> /T`
  4. fallback to `terminate()` and then `kill()`
  - A console child without a window normally ignores the non-/F taskkill, so stop is effectively a **hard kill after about 10 s** **(inferred)**.
  - The child's SIGTERM/SIGINT handler (`run_parallel_simulation.py:1653-1681`) never runs. So there is no `env.close()`, no `simulation_end` line, and `env_status.json` stays `"alive"` (**stale**), which makes `check_env_alive` lie until a forced restart deletes the file (`simulation_runner.py:1405`).
- **Signals.** On Windows, SIGTERM cannot be delivered externally to a Python handler (`os.kill` equals TerminateProcess). SIGINT arrives only via Ctrl+C in an attached console. No `creationflags` or `CREATE_NEW_PROCESS_GROUP`/`CTRL_BREAK_EVENT` is used (grep). So `_shutdown_event` (`:1230,1429`) is unreachable from Flask on Windows.
- **No fork.** There is no `os.fork` or multiprocessing in the backend or OASIS (grep). `multiprocessing` is imported only for `resource_tracker` cleanup (`run_parallel_simulation.py:1693-1697`).
- **Paths and encoding.**
  - `os.path.join` is used throughout.
  - OASIS opens files without an encoding (`agents_generator.py:574`, `database.py:100` etc.). MiroFish therefore monkey-patches `builtins.open` to default to UTF-8 on win32 (`run_parallel_simulation.py:35-65`) and sets `PYTHONUTF8=1` in the child env (`simulation_runner.py:533-535`).
- **File races** (non-atomic `open('w')` + `json.dump`):
  - Both sides catch `JSONDecodeError` and retry on the next poll (`simulation_ipc.py:173-174`; `run_parallel_simulation.py:274-275`).
  - `os.remove` of a file open in another process raises PermissionError and is caught (OSError).
  - A command file that never parses is skipped forever and never deleted **(inferred)**.
- **`simulation.log` is written by two handles:** the parent's stdout redirect (`simulation_runner.py:528-549`) and the child's `FileHandler(mode='w')` (`action_logger.py:150`). Expect overwritten or interleaved text **(inferred)**.
- **Flask cleanup.** `register_cleanup` handles the missing SIGHUP on Windows (`simulation_runner.py:1579-1583,1617-1619`) and the werkzeug reloader (`:1565-1574`). It uses atexit plus SIGINT/SIGTERM handlers (`:1609-1622`).

---

## Q5. LLM usage and cost tracking, retries, timeouts, stopping, error handling

- **No token, call or cost accounting exists anywhere in MiroFish.** A grep for `usage`, `prompt_tokens`, `completion_tokens` and `cost` in `backend/app` and `backend/scripts` finds only a GPT-5 parameter comment in `utils/openai_chat_compat.py:34,53`. There is no budget or stop-on-cost. The only bounds are `--max-rounds` and `agents_per_hour_max`.
- **OASIS discards per-decision usage.**
  - `env.step` runs `await asyncio.gather(*tasks)` and drops the results (`env.py:192-193`).
  - `perform_action_by_llm` returns the CAMEL `ChatAgentResponse` (`agent.py:139-152`). Its `info["usage"]` = `{prompt_tokens, completion_tokens, total_tokens}` summed over the step's API calls (`camel/agents/chat_agent.py:2104-2123,2136-2151`; `camel/agents/_utils.py:159-166`). It comes from the provider's `response.usage` (`chat_agent.py:2542-2544`).
  - `perform_interview` drops usage too (`agent.py:226-249`).
  - To count tokens, the call site must be owned. Options: Hyvo's own client, a wrapper `BaseModelBackend`, or calling `agent.perform_action_by_llm()` directly and reading `resp.info["usage"]`.
- **Retries.**
  - CAMEL ChatAgent `retry_attempts=3` covers **only RateLimitError**, with exponential backoff, a 60 s cap and jitter (`chat_agent.py:2246-2268`). Any other exception is re-raised.
  - The OpenAI SDK `max_retries=3` covers connection errors and 408/409/429/5xx (`openai_model.py:111,149-161`). So a persistent 429 can cost up to about (1+3)×3 HTTP attempts per decision **(inferred)**.
  - Profile and config generation use their own 3-attempt loops with decreasing temperature, JSON repair and rule fallbacks (`oasis_profile_generator.py:567-625`; `simulation_config_generator.py:435-483`).
  - `utils/retry.py` (`retry_with_backoff`, `RetryableAPIClient`) is **unused** (grep).
  - `utils/llm_client.py` (`LLMClient`) is used only by the ontology, report and zep_tools code, not the simulation step.
- **Timeouts.** Per HTTP request: `MODEL_TIMEOUT` or 180 s (`openai_model.py:118`). There is no per-step timeout (`step_timeout=None`, `chat_agent.py:460,1933-1948`) and no per-round or per-run timeout in the scripts.
- **Error handling.**
  - `perform_action_by_llm` catches **every** exception, logs to logger `social.agent`, and returns it (`agent.py:153-155`). MiroFish silences that logger (`run_parallel_simulation.py:120-138`). So model errors and malformed tool-argument JSON (`chat_agent.py:2552`) produce **silently missing actions**.
  - `Platform.running()` has no try/except around handlers (`platform.py:128-173`). One raising handler kills the platform task. Every later action then spins forever in `Channel.read_from_send_queue` (0.1 s poll, `oasis/social_platform/channel.py:62-71`) **(inferred hang; needs a watchdog on `env.platform_task.done()`)**.
  - Prepare failures set state FAILED (`simulation_manager.py:470-477`). A non-zero child exit is turned into FAILED with the last 2,000 chars of `simulation.log` (`simulation_runner.py:693-705`).
- **Stopping.**
  - Cooperative stop: `_shutdown_event` is checked at the start of each round (`run_parallel_simulation.py:1230,1429`). It is set only by the signal handler (`:1663-1678`), so it is POSIX- or Ctrl+C-only.
  - API stop: process-tree kill (Q4). On POSIX that is SIGTERM to the process group, then SIGKILL after 10 s (`simulation_runner.py:947-962`).
  - There is no mid-round cancellation. In-flight LLM calls finish or time out.

---

## Q6. Running one simulation headless from Python without Flask

### Option A: run the stock script as a subprocess (no MiroFish edits, closest to upstream)

```bat
cd /d <job_dir>                     & rem OASIS creates .\log at import time in the CWD
set LLM_API_KEY=...                 & rem required; the script raises if missing (run_parallel_simulation.py:1026-1027)
set LLM_BASE_URL=https://...        & rem optional
set LLM_MODEL_NAME=...              & rem else config "llm_model", else "gpt-4o-mini"
set PYTHONUTF8=1
C:\.hyvo\engine\.venv\Scripts\python.exe C:\.hyvo\engine\mirofish\backend\scripts\run_parallel_simulation.py ^
    --config <job_dir>\simulation_config.json --reddit-only --max-rounds 10 --no-wait
```
- **CLI** (`:1492-1523`): `--config` (required), `--twitter-only`, `--reddit-only`, `--max-rounds N`, `--no-wait`. Use `--no-wait`, otherwise the process waits for IPC forever.
- **The output directory** is `dirname(--config)` (`:1534`).
- **Env loading.** The script loads `C:\.hyvo\engine\mirofish\.env`, or else `backend\.env`, if present (`:92-103`). It uses `load_dotenv` defaults, so it does not override variables Hyvo has already set. Do not leave `LLM_BOOST_API_KEY` defined.
- **Required input files**, in the same directory as the config:
  - `reddit_profiles.json` (Reddit) and/or `twitter_profiles.csv` (Twitter), formats in Q2.2.
  - If one is missing, that platform is skipped with only a log line (`:1133-1136,1324-1327`).
- **Minimal `simulation_config.json`** (only consumed fields; makes every agent act every round):
```json
{
  "simulation_id": "job_local_01",
  "llm_model": "deepseek-chat",
  "time_config": {
    "total_simulation_hours": 10, "minutes_per_round": 60,
    "agents_per_hour_min": 50, "agents_per_hour_max": 50,
    "peak_hours": [], "off_peak_hours": [],
    "peak_activity_multiplier": 1.0, "off_peak_activity_multiplier": 1.0
  },
  "agent_configs": [
    {"agent_id": 0, "entity_name": "sniper_01", "active_hours": [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23], "activity_level": 1.0}
  ],
  "event_config": {"initial_posts": [{"poster_agent_id": 0, "content": "Seed: token X lists with 5% creator tax"}]}
}
```
  - Pass `peak_hours` and `off_peak_hours` explicitly. When the keys are missing, the script uses non-empty defaults (`:1053-1054`).
  - With `activity_level=1.0`, `random.random() < 1.0` is always true.
- **Outputs in `<job_dir>`:**
  - `twitter/actions.jsonl`, `reddit/actions.jsonl` (Q3.4)
  - `simulation.log` (main log, mode 'w', `action_logger.py:140-167`)
  - `twitter_simulation.db`, `reddit_simulation.db` (deleted and recreated at start, `:1151-1153,1342-1344`)
  - `log/` (OASIS loggers; `init_logging_for_simulation` deletes `<sim_dir>/log` at start, `:141-155`)
  - Only without `--no-wait`: `env_status.json`, `ipc_commands/`, `ipc_responses/`.
  - There is no `run_state.json`; Flask writes that file.
- **Limits:** no token counts, no budget stop, no graceful stop on Windows except finishing `--max-rounds`, and no market or custom actions.

### Option B: import the script module in-process (not recommended)

Importing `run_parallel_simulation` has process-wide side effects:
- On win32 it replaces `builtins.open` (`:50-65`).
- It mutates `os.environ["OPENAI_API_KEY"/"OPENAI_API_BASE_URL"]` (`:1022-1030`).
- It adds a root-logger filter (`:117`) and silences OASIS loggers (`:120-138`).
- It relies on the module global `_shutdown_event` (`:81,1526-1527`).
- `import oasis` creates `./log` in the CWD.

### Option C: drive OASIS directly from Hyvo code (recommended; see Q8)

The OASIS entry points are a plain library API, with no Flask or files beyond the SQLite DB:
- `oasis.make(agent_graph, platform=DefaultPlatformType.REDDIT|TWITTER|Platform(...), database_path, semaphore)` (`env.py:48-116`)
- `await env.reset()` starts the platform task and signs agents up (`env.py:118-122`)
- `await env.step({agent: ManualAction | LLMAction | [..]})` (`env.py:136-198`)
- `await env.close()` (`env.py:200-208`)

**Do not import MiroFish `app.*` from Hyvo.**
- `import app.services.X` runs `backend/app/__init__.py`, which imports Flask and flask_cors and `config.py`. That calls `load_dotenv(mirofish/.env, override=True)` (`config.py:8-14`).
- It also runs `utils/logger.py:108` `setup_logger()`, which creates `C:\.hyvo\engine\mirofish\backend\logs\<date>.log` **inside the vendored tree** (`logger.py:27,42`). The path is gitignored (`.gitignore` `backend/logs/`) but it is still a write.
- It also eagerly imports every service via `app/services/__init__.py:5-38` (zep_cloud, httpx and so on).
- `SimulationManager()` creates `backend/uploads/simulations` (`simulation_manager.py:145-147`).
- `utils/locale.py` imports flask at module level (`:4`).

---

## Q7. Is Zep required during the simulation step?

**No.** It can be disabled cleanly.

- The subprocess scripts never import Zep or any `app.*` module (grep of imports in `backend/scripts/run_*.py`).
- Zep's only role during the run lives in the **Flask process**. If `enable_graph_memory_update=true`:
  - `start_simulation` creates a `ZepGraphMemoryUpdater` (`simulation_runner.py:441-463`).
  - The monitor forwards each `actions.jsonl` action line (`simulation_runner.py:786-791,870-872`).
  - The updater batches 5 per platform, waits 0.5 s between sends, calls `graph.add`, skips DO_NOTHING, and waits up to 600 s for ingestion on stop (`zep_graph_memory_updater.py:213-412`; `utils/zep.py` 60 s HTTP and 600 s ingestion constants).
  - Terminal status waits on that drain (`simulation_runner.py:710-731`).
- The flag defaults to False in the API (`api/simulation.py:1554`) and the runner (`simulation_runner.py:376`). The **stock UI sends true** (`Step3Simulation.vue:402`).
- **Ways to disable:** omit the flag when calling the API, or run the script directly (Q6). Either way there is no Zep traffic.
- **Zep is still required elsewhere in the stock pipeline:**
  - Prepare: `ZepEntityReader` raises without a key (`zep_entity_reader.py:80-85`; used at `simulation_manager.py:294-303` and `api/simulation.py:503-518`).
  - Flask boot: `Config.validate()` rejects a missing `ZEP_API_KEY` (`config.py:69-70`; `run.py:28-34`).
  - Report agent: `ZepToolsService` (`report_agent.py:913`).
- `OasisProfileGenerator` and `SimulationConfigGenerator` themselves run without Zep if you hand them `EntityNode` objects. Importing them still pulls in `zep_cloud`, which is installed (`zep_entity_reader.py:8`, `utils/zep.py:11-12`).

---

## Q8. Recommendation for Hyvo

**Recommendation:** write a Hyvo round loop that uses **OASIS directly** as the social world. Do not wrap `run_parallel_simulation.py`. Port a few pure MiroFish functions into `engine/hyvo/...` with attribution. Hyvo's engine package is declared `AGPL-3.0-or-later` (`C:\.hyvo\engine\pyproject.toml:6`), so copying AGPL MiroFish code is license-consistent; keep the notices. Never import MiroFish `app.*`, and never write under `engine/mirofish`.

### Why not wrap the stock runner

1. **Batching is impossible through MiroFish.** OASIS makes one ChatAgent call per active agent per round (Q3.2). SPEC 6.6 needs batched decisions. Hyvo can make one batched LLM call for K agents and execute the resulting social actions through `ManualAction`. `perform_action_by_data` does **not** call an LLM (`agent.py:278-294`; `env.py:177-188`).
2. **Budget enforcement needs the call site.** MiroFish has zero accounting, and OASIS drops `usage` (Q5). Hyvo must count `response.usage` on every call, check `maxCostUsd` and `maxLlmCalls` **before** each call, stop between rounds, and mark the run `partial`.
3. **The observation is fixed.** The prompt template has no hook for MarketState, balances or PnL (`agent_environment.py:49-53`). Swap tools need custom `SocialAgent(tools=...)` construction, which the graph generators do not expose (`agents_generator.py:598-604,640-646`).
4. **No `injectedEvents` mechanism.** `scheduled_events` is dead, and IPC is not polled mid-run (Q3.5).
5. **Windows.** Subprocess stop means taskkill, so no cleanup runs and status goes stale (Q4). An in-process asyncio loop can always stop between rounds and `await env.close()`.
6. **Cost growth.** History is resent unbounded with every call (Q3.3). That breaks the SPEC 12 estimate of about $0.0003 per decision. Hyvo should send compact stateless prompts per round: persona + last N feed items + MarketState + own balances/PnL + this round's events.
7. **Twitter platform cost.** It needs a twhin-bert download and CPU inference every step, and has module-global state. Use **one** Reddit-style OASIS platform: ML-free hot ranking, with comments that map to `replyTo`. Alternatively pass `Platform(db_path, channel, recsys_type="random"|"reddit", ...)` to `oasis.make` (`env.py:103-112`; `platform.py:56-69`). Two platforms double the LLM bill for one `run.json` feed.
8. **Determinism.** Seed `random` yourself; MiroFish's activation is unseeded (Q3.2).

### Sketch (untested, API-accurate to OASIS 0.2.5 / CAMEL 0.2.78)

```python
# engine/hyvo/runner/world_social.py
os.chdir(job_dir)                                   # BEFORE importing oasis: it writes ./log into the CWD
import oasis
from oasis import ActionType, ManualAction, AgentGraph, SocialAgent, UserInfo, DefaultPlatformType
from camel.models import ModelFactory
from camel.types import ModelPlatformType, ModelType

stub = ModelFactory.create(ModelPlatformType.OPENAI, ModelType.STUB)   # no network; Hyvo makes decisions (model_factory.py:187-188)
graph = AgentGraph()                                                    # igraph backend by default, no neo4j
for i, p in enumerate(personas):                                       # index 0 can be a "narrator/news" account for injected events
    ui = UserInfo(user_name=p.handle, name=p.handle, description=p.bio,
                  profile={"other_info": {"user_profile": p.persona}}, recsys_type="twitter")  # template choice only
    graph.add_agent(SocialAgent(agent_id=i, user_info=ui, model=stub, agent_graph=graph,
                                available_actions=[ActionType.CREATE_POST, ActionType.CREATE_COMMENT,
                                                   ActionType.LIKE_POST, ActionType.DISLIKE_POST, ActionType.DO_NOTHING]))
env = oasis.make(agent_graph=graph, platform=DefaultPlatformType.REDDIT, database_path=str(job_dir / "social.db"))
await env.reset()
for r in range(1, rounds + 1):
    if budget.exhausted(): status = "partial"; break
    if ev := events_by_round.get(r):
        await env.step({graph.get_agent(0): [ManualAction(ActionType.CREATE_POST, {"content": e.text}) for e in ev]})
    feed = read_feed(db, limit=N)                                       # port of _get_post_info/_get_comment_info SQL
    decisions = await batched_decide(active_agents, feed, market.state(), balances, ev, budget)   # Hyvo client, counts usage
    await env.step({graph.get_agent(d.agent_id): [ManualAction(a.type, a.args) for a in d.social] for d in decisions if d.social})
    for d in decisions: market.execute(d.market_action)                 # validated web3.py swap or hold
    log_round(fetch_new_actions_from_db(db, last_rowid, names))         # port; build run.json rounds[r]
await env.close()
```
- `UserInfo.recsys_type="twitter"` only selects the system-message template, which avoids the Reddit template's required gender, age, mbti and country keys (`user.py:44-48,79-98`). The platform's recsys is chosen by `oasis.make` (`env.py:71-98`).
- For optional post-run interviews (report "objections" and deep interaction), give agents a real model and use `perform_interview` in-process before `env.close()` (`agent.py:197-249`). Count those calls against the budget too.
- Add a watchdog: if `env.platform_task.done()`, abort the run and surface `platform_task.exception()` (Q5).

### MiroFish pieces worth porting (copy with AGPL attribution)

| Piece | Where | Use in Hyvo |
|---|---|---|
| `fetch_new_actions_from_db`, `_enrich_action_context`, `_get_post_info`, `_get_user_name`, `_get_comment_info`, `ACTION_TYPE_MAP`, `FILTERED_ACTIONS` | `backend/scripts/run_parallel_simulation.py:610-981` | trace → per-round actions and posts with author, content and likes for `run.json.rounds[]`. Fix the initial-post double read by setting `last_rowid` after round 0. |
| `PlatformActionLogger` and the event-line format | `backend/scripts/action_logger.py:22-116` | append-only replay log (SPEC 5.2 "replayable from logs"). Fix the `total_rounds` bug and add `usage` per line. |
| `get_active_agents_for_round` | `run_parallel_simulation.py:1040-1090` | template for per-round activation, with a seeded RNG and without clock hours |
| `create_model` pattern | `run_parallel_simulation.py:984-1037` | but call `ModelFactory.create(..., api_key=, url=, timeout=, model_config_dict={"temperature": 0.8})` explicitly |
| interview flow (`ManualAction(INTERVIEW)` + trace read-back) | `run_parallel_simulation.py:317-343,517-558` | in-process interviews, no file IPC |
| OASIS profile contract (`to_reddit_format`, `_save_reddit_json`, `_save_twitter_csv`, `_normalize_gender`, `_coerce_to_str*`) | `backend/app/services/oasis_profile_generator.py:34-76,123-179,1114-1237` | only needed if Hyvo feeds files to `generate_*_agent_graph` |
| JSON-robust LLM helpers (`_call_llm_with_retry`, `_fix_truncated_json`, `_try_fix_config_json`) | `backend/app/services/simulation_config_generator.py:435-535` | persona and report JSON generation |
| `create_chat_completion`, `extract_chat_completion_text` | `backend/app/utils/openai_chat_compat.py:20-101` (dependency-free) | Hyvo's OpenAI-compatible client wrapper (GPT-5 parameter quirks) |
| strict JSON parse (`LLMClient._parse_json_response`, `_clean_chat_text`, `_is_response_format_unsupported`) | `backend/app/utils/llm_client.py:27-88,234-290` | batched-decision response parsing with `<think>` stripping and response_format fallback |
| persona prompt structure | `oasis_profile_generator.py:721-816` | as a reference only; Hyvo personas are archetypes (SPEC 6.4) and must be English |

**Do not reuse:** the Flask API, `SimulationManager` (Zep-bound), `SimulationRunner` (Flask process registry and Zep barrier), file IPC, `run_twitter_simulation.py` and `run_reddit_simulation.py` (legacy), `test_profile_format.py` (stale), `utils/retry.py` (unused).

**Phase 1 smoke check.** For the DoD wording "MiroFish runs locally", keep a tiny check that runs Option A (`--reddit-only --max-rounds 2 --no-wait`) on fixture profiles once an LLM key exists. It proves the vendored stack works without coupling production to it.

---

## Gotchas checklist (consolidated)

1. **OASIS import side effects.** About 13 s import (torch). It creates `./log` in the CWD with 4 open log files (probe; `env.py:29-45`, `platform.py:37-50`, `agent.py:38-50`, `testing/show_db.py:21`). Set the CWD to the job dir first.
2. **Unbounded agent memory** in the LLMAction path. Every call resends the full history plus 0.7k to 1.7k tokens of tool schemas (Q3.3).
3. **No usage or cost tracking** anywhere (Q5).
4. **Silent decision failures** (`agent.py:153-155`), and a possible platform-task hang (`platform.py:128-173`).
5. **Unseeded randomness** (`run_parallel_simulation.py:1063,1074,1077`).
6. **Reddit timestamps follow the wall clock ×60** (`platform.py:76-81`). Twitter time_step increments on every `env.step`, including manual and interview steps (`env.py:196-198`).
7. **Initial-post logging bugs:** duplicate lines, and Twitter overwriting same-author posts (Q3.4).
8. `scheduled_events`, `hot_topics`, `stance`, `sentiment_bias`, `influence_weight` and the PlatformConfig weights are **display-only** (Q2.3).
9. **Windows stop** is a hard kill, leaving a stale `env_status.json` (Q4).
10. **`create_db` silently reuses an existing DB** (`database.py:198-199`).
11. **Process-global env mutation** for model config (`run_parallel_simulation.py:1022-1030`).
12. **Importing MiroFish `app.*` writes `backend/logs/`** into the vendored tree and loads `mirofish/.env` with override=True (Q6).
13. **twhin-bert recsys:** an HF download, CPU cost, and module-global state across envs in one process (Q3.3).
14. **Prompts and locale default to Chinese** (`locale.py:28-32`; generator prompts). Hyvo content must be English (SPEC header).

## Open questions

1. Phase 1 DoD says "MiroFish runs locally". Is an OASIS-based Hyvo loop sufficient, or must the stock Flask pipeline run? The stock pipeline needs Zep for prepare and boot, and there is no Zep key yet.
2. Which cheap model will be used? Does it support OpenAI tool calling with `strict: true` (only needed for OASIS LLMAction or interviews) and JSON mode (needed for Hyvo's batched decisions)? Its CAMEL `token_limit` depends on whether the name is a known `ModelType` (probe).
3. Single feed: is a Reddit-style feed (posts plus comments as `replyTo`, likes and dislikes) acceptable for `run.json`, or are quote and repost semantics needed (Twitter-style)?
4. Are post-run agent interviews (deep interaction) in Stage 1 scope? If so, they need a real model per agent and add LLM calls outside the batched budget.
5. Should the OASIS SQLite DB be archived with the run (SPEC 5.2 "store every agent output"), or is the Hyvo JSONL log the only replay source?
6. Should Hyvo control the OASIS Reddit clock (a custom `Platform(sandbox_clock=Clock(k), start_time=...)`) so DB timestamps map to rounds deterministically?
