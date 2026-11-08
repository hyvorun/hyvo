# OASIS core (camel-oasis 0.2.5): agents, action space, platform, recsys, model backends

Area owner notes for Hyvo. These notes answer the 8 questions in the task. Each claim cites code, and
"(probe)" marks a claim I confirmed by running code. Anything I did not verify is labelled **inferred**.

## 0. Sources, versions, conventions

| What | Where | Cited as |
|---|---|---|
| OASIS v0.2.5 source (git tag `v0.2.5`, commit e97a1d8) | `oasis-src/oasis` (a local checkout) | `oasis/...`, `examples/...`, `test/...` |
| Installed OASIS in the engine venv | `C:\.hyvo\engine\.venv\Lib\site-packages\oasis` | byte-identical to the source above (checked with `diff -r`) |
| camel-ai 0.2.78 (installed) | `C:\.hyvo\engine\.venv\Lib\site-packages\camel` | `camel/...` (identical to the uv cache copy) |
| MiroFish (vendored) | `C:\.hyvo\engine\mirofish` | `backend/...` |

Versions resolved by `C:\.hyvo\engine\uv.lock`: camel-ai 0.2.78, camel-oasis 0.2.5, openai 1.109.1, torch 2.9.1 (CPU),
sentence-transformers 3.0.0, transformers 4.57.3, tiktoken 0.7.0, numpy 2.3.5, pandas 2.2.2, igraph 0.11.6, neo4j 5.23.0.
The installed interpreter is CPython 3.11.15. OASIS requires `>=3.10,<3.12` (pyproject.toml:25), so Python 3.11 works.

**Probes.** All probes ran with `C:\.hyvo\engine\.venv\Scripts\python.exe -B -I` (no bytecode writes, isolated mode). The
working directory, SQLite DBs and logs were all in a scratch directory. A socket hook blocked and recorded every non-loopback
connection. Nothing was written under `C:\.hyvo`.

- Scripts: `probes/` in that directory (`netblock.py`, `probe_import.py`, `probe_zero_llm.py`, `probe_recsys_models.py`,
  `probe_misc.py`, `probe_misc2.py`, `probe_external.py`).
- Outputs: `probe_run/` in that directory (`zero_llm_result.json`, `recsys_out.txt`, `misc_out.txt`, `ext_out.txt`,
  `importtime.txt`).

---

## 1. Architecture in one picture

```
OasisEnv (oasis/environment/env.py)
  ├─ agent_graph: AgentGraph (igraph | neo4j)  ── holds SocialAgent instances, keyed by agent_id
  ├─ platform:   Platform (oasis/social_platform/platform.py)
  │               one sqlite3 connection + one asyncio task `running()` that pops a queue and executes actions in order
  └─ channel:    Channel (asyncio.Queue in, dict out, consumer polls every 0.1 s)

SocialAgent(ChatAgent)  (oasis/social_agent/agent.py)
  ├─ env = SocialEnvironment(SocialAction(agent_id, channel))   builds the observation text
  ├─ tools = FunctionTool(bound SocialAction methods) [+ user tools]
  └─ astep() ─► camel ModelManager ─► BaseModelBackend.arun ─► OpenAI-compatible HTTP

SocialAction.<method>(args) ─► channel.write_to_receive_queue((agent_id, message, action_type))
                            ─► Platform.running(): getattr(self, action)(agent_id, message) ─► SQL + trace row
                            ─► channel.send_to((message_id, agent_id, result_dict)) ─► result returned to caller
```

---

## 2. Q1: how a SocialAgent decides

### 2.1 Constructor (oasis/social_agent/agent.py:58-70)

```python
SocialAgent(agent_id: int, user_info: UserInfo, user_info_template: TextPrompt | None = None,
            channel: Channel | None = None,
            model: BaseModelBackend | List[BaseModelBackend] | ModelManager | None = None,
            agent_graph: AgentGraph = None, available_actions: list[ActionType] = None,
            tools: Optional[List[FunctionTool | Callable]] = None,
            max_iteration: int = 1, interview_record: bool = False)
```

- With no `channel`, the agent creates its own `Channel()` (agent.py:73). `env.reset()` later rebinds it to the env channel
  (agents_generator.py:537-544).
- The constructor calls `ChatAgent.__init__(system_message=..., model=model, scheduling_strategy='random_model',
  tools=all_tools)` (agent.py:106-111). It does **not** forward `message_window_size`, `token_limit`, `external_tools`,
  `prune_tool_calls_from_memory`, `retry_attempts` or `step_timeout`. You need a subclass to set them.
- It sets `self.max_iteration = max_iteration` *after* `super().__init__`, which overrides camel's default `None`
  (agent.py:112). (probe) The effective value is 1.

### 2.2 System prompt (from UserInfo)

`UserInfo` is a dataclass (oasis/social_platform/config/user.py:22-29):

```python
user_name: str|None; name: str|None; description: str|None; profile: dict|None;
recsys_type: str = "twitter"; is_controllable: bool = False
```

- With a template, the prompt is `to_custom_system_message(TextPrompt)` (user.py:31-42; agent.py:75-79). The template keys
  must exactly match `profile.keys()`. A missing key raises `ValueError` and an extra key raises a warning. This is the
  clean hook for Hyvo persona prompts.
- Without a template, the prompt is `to_twitter_system_message()` (user.py:50-77), or `to_reddit_system_message()` when
  `recsys_type == "reddit"` (user.py:79-111). The twitter prompt is:

  ```
  # OBJECTIVE
  You're a Twitter user, and I'll present you with some posts. After you see the posts, choose some actions from the following functions.
  # SELF-DESCRIPTION
  Your actions should be consistent with your self-description and personality.
  Your name is {name}.
  Your have profile: {profile["other_info"]["user_profile"]}.
  # RESPONSE METHOD
  Please perform actions by tool calling.
  ```

  The reddit prompt adds gender, age, MBTI and country from `profile["other_info"]` (user.py:94-98). It also `print()`s the
  profile (user.py:93).
- `UserInfo.description` is **not** used in either prompt. It only becomes the sign-up bio (agents_generator.py:558-560).
- **Bug (probe).** If `profile` has `other_info` but no `user_profile` key, or `user_profile` is `None`, the local
  `description` is never assigned. Agent construction then raises `UnboundLocalError` (user.py:57-71).
- `perform_interview` strips the prompt at `"# RESPONSE FORMAT"` (agent.py:215). The prompts say `# RESPONSE METHOD`, so the
  split does nothing.

### 2.3 Observation text (SocialEnvironment)

`perform_action_by_llm` (agent.py:125-155) builds the user message:
`"Please perform social media actions after observing the platform environments. Notice that don't limit your actions for
example to just like the posts. Here is your social media environment: {env_prompt}"` (agent.py:128-134).

`env_prompt = await self.env.to_text_prompt()` (oasis/social_agent/agent_environment.py:118-135) is built from
`env_template` (agent_environment.py:49-53): `"$groups_env\n$posts_env\npick one you want to perform action ..."`.

- **posts_env** (agent_environment.py:58-66) calls `SocialAction.refresh()` through the channel. That is a real platform
  action that writes a `refresh` row into `trace`. The result is rendered with `json.dumps(posts, indent=4)` and default
  `ensure_ascii=True`, so all non-ASCII text (emoji, CJK, accents) reaches the LLM as `\uXXXX` escapes (probe:
  `"\ud83d\ude80 to the moon \u4e2d\u6587 caf\u00e9"`). That costs extra tokens and hurts comprehension (**inferred**).
- **groups_env** (agent_environment.py:103-116) is always included, even when the agent has no group actions. It adds about
  330 characters of group-chat boilerplate every round (probe output shows it).
- Follower and following counts are computed (agent_environment.py:68-101) but the template has no placeholder for them,
  so they are dropped. They also read from `get_db_path()` (the `OASIS_DB_PATH` env var or a default inside
  site-packages), not from the platform's own DB.
- (probe) A 5-post feed produced a 2,694-character observation. A sample is in `probe_run\zero_llm_out.json` (log lines).

### 2.4 Tool list

- `SocialAction.get_openai_function_list()` wraps **29** bound async methods in `FunctionTool` (agent_action.py:28-61).
- `available_actions` filters that list by function name (agent.py:85-104). With nothing passed, the agent gets all 29
  (agent.py:85-87), including interview, purchase_product and the group-chat tools.
- Default subsets: `ActionType.get_default_twitter_actions()` gives CREATE_POST, LIKE_POST, REPOST, FOLLOW, DO_NOTHING,
  QUOTE_POST (oasis/social_platform/typing.py:51-60). The reddit default has 13 actions (typing.py:62-78). MiroFish uses
  those lists (backend/scripts/run_parallel_simulation.py:177-200).
- Extra `tools` are prepended: `all_tools = (tools or []) + self.action_tools` (agent.py:105). camel keys tools by function
  name (camel/agents/chat_agent.py:517-522), so a name collision means the later tool (the social action) wins
  (**inferred** from dict-comprehension order).
- Schema generation: camel builds the JSON schema from the signature and docstring and **always** sets `"strict": true`
  and `additionalProperties: false` (camel/toolkits/function_tool.py:176-191; `"strict": True` at :181). You can override
  this only by passing `FunctionTool(func, openai_tool_schema=...)` (function_tool.py:413-425).
- (probe) Schema payload sent with **every** call: 2,970 characters for the 6 default twitter tools and 14,253 characters for
  all 29 (about 750 and 3,500 tokens at 4 characters per token, **approximate**).

### 2.5 How tool calls map to platform actions

1. The model returns `tool_calls`. camel parses each into `ToolCallRequest(tool_name, args=json.loads(arguments))`
   (chat_agent.py:2546-2556). Malformed JSON raises there.
2. `_aexecute_tool` looks up `self._internal_tools[name]` (chat_agent.py:2657). That lookup sits outside the try, so an
   unknown tool name raises `KeyError`. The tool is then awaited as `tool.func(**args)` (chat_agent.py:2670-2674).
   Exceptions raised *inside* the tool are caught and turned into a "Tool execution failed" string (chat_agent.py:2684-2688).
3. A bound `SocialAction.<method>` packs its args into one `message` (a tuple for multi-arg actions, e.g.
   `create_comment → (post_id, content)` at agent_action.py:531-533). It then calls
   `perform_action(message, ActionType.X.value)`, which writes `(agent_id, message, type)` to the channel and waits for the
   reply (agent_action.py:63-67).
4. `Platform.running()` handles messages one at a time (platform.py:128-173). It converts with `ActionType(action)`
   (platform.py:133), which raises `ValueError` on unknown strings. It finds the method with `getattr(self, action.value)`
   (platform.py:148) and builds kwargs by introspecting `co_varnames`: `agent_id` plus at most one message parameter. More
   than 3 parameters raises (platform.py:150-168).
5. The result dict goes back through `channel.send_to` (platform.py:171). camel records the call and result in memory as an
   assistant tool-call message plus a function message (chat_agent.py:2691-2761). It also lists the call in
   `response.info["tool_calls"]`.

`quote_post` passes the enum rather than `.value` (agent_action.py:217). It still works because `ActionType(member)` returns
the member (probe: quote succeeded).

### 2.6 How many LLM calls per agent per `env.step`

- An `LLMAction` triggers `_perform_llm_action` and then `perform_action_by_llm()` (env.py:124-128, 174-175, 189-190). That
  makes **one** `astep`.
- Inside `astep`, the loop (chat_agent.py:1993-2078) calls the model, executes **all** tool calls in that response, then
  breaks because `iteration_count >= max_iteration (=1)` (chat_agent.py:2069-2073). The result is **1 LLM call per agent per
  step**, no matter how many tool calls the model emits.
- (probe) 3 LLMActions produced 3 model calls. A fake model that returned 2 parallel tool calls (`swap_buy` and
  `create_post`) produced 1 call with both executed. With `max_iteration=3` it made 2 calls (a second call after the tool
  results). Raising `max_iteration` multiplies cost.
- Hidden extra calls:
  - camel retries only on `RateLimitError`, up to `retry_attempts=3` with backoff (chat_agent.py:2246-2268).
  - The OpenAI SDK client has its own `max_retries` (default 3 from `ModelFactory.create`, model_factory.py:121). Those
    retries are invisible to camel. Timeouts default to 180 s (`MODEL_TIMEOUT`, openai_compatible_model.py:99) and may
    still be billed (**inferred**).
- Each `LLMAction` also costs 2 platform round trips for the observation (refresh and listen_from_group), each with at
  least about 0.1 s of polling latency (oasis/social_platform/channel.py:62-71). Concurrent agents hide this latency.
- LLM concurrency is capped by `asyncio.Semaphore(semaphore)` (default 128; env.py:55, 70, 124-128). MiroFish uses 30
  (backend/scripts/run_parallel_simulation.py:1155-1160). Manual actions are not semaphore-limited.

**Return value.** `perform_action_by_llm` iterates `response.info['tool_calls']` and `return`s inside the loop on the first
item (agent.py:140-152). With no tool calls it returns `None` (probe). On an exception it returns the exception object
(agent.py:153-155). `env.step` discards all task results (env.py:193). OASIS gives the caller no usage information.

### 2.7 Memory window

- camel `ChatHistoryMemory(ScoreBasedContextCreator(token_counter, token_limit), window_size=None)`
  (chat_agent.py:478-487). SocialAgent passes no window size, so the whole history is kept.
- `token_limit` is `model_config_dict["max_tokens"]`, or else `model_type.token_limit` (camel/models/base_model.py:529-542;
  ModelManager proxies it at model_manager.py:135-145).
  - Unknown model names (`UnifiedModelType`) get **999,999,999**, which never truncates
    (camel/types/unified_model_type.py:64-71).
  - Known enums use their table value (camel/types/enums.py:1093+). (probe) `"deepseek-chat"` mapped to 64,000 and
    `ModelType.STUB` to 4,096.
- **Pitfall (probe).** Setting `max_tokens` in `model_config_dict` to cap output length also sets the context window
  (`max_tokens=300` gave a context limit of 300). Once system plus current message exceed it, camel raises inside
  `get_context()`. `astep` then returns `_step_terminate(..., "max_tokens_exceeded")` with **no model call and no action**
  (chat_agent.py:2001-2007; camel/memories/context_creators/score_based.py:99-105, 177-183).
- Every round appends the observation (the user message, chat_agent.py:1981), the assistant output and 2 records per tool
  call. Prompt tokens therefore grow linearly with the round number and total cost grows quadratically (**inferred**). In
  the probe, agent 0 held 8 memory records after 3 ManualActions and 2 LLM steps.
  - Rough illustration (**inferred**): 50 agents × 10 rounds with about 700-token observations plus about 750 tokens of
    tool schemas comes to about 2.3M input tokens.
- `perform_action_by_data` (ManualAction) also writes a memory record (agent.py:286-291; probe: +1 record).

### 2.8 Per-agent model and temperature

- Each SocialAgent wraps whatever you pass in its own `ModelManager` (chat_agent.py:463-471). A list of backends means a
  random backend per call (`scheduling_strategy='random_model'`, agent.py:109; camel/models/model_manager.py:190-196).
- Temperature and other sampling parameters live in the backend's `model_config_dict`. It is forwarded verbatim as kwargs
  to `chat.completions.create` (camel/models/openai_compatible_model.py:287-301).
  - Per-persona temperature means one backend instance per temperature.
  - Mutating `agent.model_backend.model_config_dict` changes the shared backend for every agent using it (setter at
    model_manager.py:107-115; **inferred** sharing effect).
  - `ChatGPTConfig()` defaults are all `None`, so the OPENAI platform sends nothing extra by default
    (camel/configs/openai_config.py:111-125; base_config.py:64-86).
  - `parallel_tool_calls` and `tool_choice` are settable there.
- MiroFish shares **one** backend across all agents: `ModelFactory.create(ModelPlatformType.OPENAI, model_type=LLM_MODEL_NAME)`
  after copying `LLM_API_KEY` and `LLM_BASE_URL` into `OPENAI_API_KEY` and `OPENAI_API_BASE_URL`
  (backend/scripts/run_parallel_simulation.py:1013-1037, 1130, 1138-1142).

---

## 3. Q2: options for adding swap_buy / swap_sell / hold / check_market

### (a) Extra FunctionTools on SocialAgent (no subclass)

- **Code.** `SocialAgent(..., tools=[FunctionTool(m.swap_buy), ...])` (agent.py:68, 105). The `generate_*_agent_graph` helpers
  do not take `tools` (agents_generator.py:567-649), so call `agent.add_tools([...])` afterwards (chat_agent.py:769-777) or
  build agents yourself, as quick_start does (examples/quick_start.py:44-74). `available_actions` only filters built-in
  social tools.
- **Works (probe).** An `async def swap_buy(amount_eth: float)` with a Google-style docstring produced a valid schema. When
  the model called it, camel executed it in-process, **outside the platform channel**, in the same response as a
  `create_post`. The result was stored in memory and in `info["tool_calls"]`. Bind agent identity with a per-agent object
  or closure, since tools only receive model arguments (SocialAction itself uses bound methods, agent_action.py:22-61).
- **Effort.** About 0.5–1 day.
- **Pitfalls.**
  - "At most one market action" cannot be enforced by the prompt: the model can emit several parallel tool calls and camel
    executes them all before you see them (probe). Enforce it inside the tool with a per-agent, per-round counter, or set
    `{"parallel_tool_calls": False}` (provider support varies, **inferred**), which also limits social actions to one.
  - `check_market` as a tool is pointless with `max_iteration=1`. Its result lands in memory and the model only sees it
    next round. `max_iteration=2` doubles calls. Put MarketState in the observation instead.
  - Requires native tool calling with `strict: true` schemas on every request (function_tool.py:176-183). Cheap or
    open-weight OpenAI-compatible endpoints may reject `strict` or produce malformed arguments (**inferred**).
  - Malformed JSON arguments, or a hallucinated tool name, raise inside `astep` (chat_agent.py:2552, 2657). The call is
    billed, but `perform_action_by_llm` swallows the exception and returns it (agent.py:153-155): the agent silently does
    nothing that round.
  - Cost: N calls per round for N agents, each carrying tool schemas (about 750 tokens for 6 tools plus the market tools)
    and growing memory. No batching is possible.
  - Usage capture needs a backend wrapper (see §7.3). Synchronous web3 calls block the event loop; use `AsyncWeb3` or
    `run_in_executor` (**inferred**).

### (b) Subclass SocialAgent (and/or SocialEnvironment)

Override `perform_action_by_llm` to:

- build the observation, e.g. `await self.env.to_text_prompt()` plus Hyvo's persona, MarketState, balances and PnL block;
- call `self.astep(...)`;
- **return the full response** with `info["usage"]`;
- handle errors.

Override `__init__` to pass `token_limit`, `message_window_size` and `prune_tool_calls_from_memory=True` to
`ChatAgent.__init__`.

- **Server-side validation of market actions.** Use camel external tools. Calls to them are **returned, not executed**: the
  loop breaks and they appear in `info["external_tool_call_requests"]` (chat_agent.py:2038-2067). Hyvo can then validate
  bounds, balance and slippage, apply the one-market-action rule, and execute via web3. (probe) A `create_post` in the same
  response was executed while `swap_buy` came back as a request.
  - camel 0.2.78 bug (probe): `ChatAgent.add_external_tool(FunctionTool(...))` raises `KeyError: 'name'`
    (chat_agent.py:779-783 indexes `schema["name"]`, but the schema nests it under `function`; compare :530-535). SocialAgent
    also does not forward `external_tools`. Register through `ChatAgent.__init__(external_tools=...)` in your subclass, or
    set `agent._external_tool_schemas[name] = schema` (private API; works in probe).
  - With only external calls, the stock `perform_action_by_llm` returns `None` and the request is lost (probe). The
    override is mandatory.
- **Custom platform ActionTypes** (routing market actions through the channel) are not recommended. `ActionType` is a
  closed Enum (typing.py:17-49), `Platform.running` rejects unknown values (platform.py:133), and it needs Platform methods
  (platform.py:148). That means patching OASIS, and market state does not belong in the social DB.
- **Effort.** About 1–2 days.
- **Pitfalls.** Same N-calls-per-round cost and tool-calling dependence as (a), but with control over the observation,
  validation, usage and memory.

### (c) Bypass OASIS decisions: batched Hyvo LLM call, OASIS only executes social actions

- Build agents with a **StubModel** backend. `ModelFactory.create(ModelPlatformType.OPENAI, ModelType.STUB)` needs no key
  and no network and uses `StubTokenCounter` (camel/models/stub_model.py:33-147; model_factory.py:187-188).
- Each round, Hyvo builds one prompt per batch of K agents (persona + feed read from SQLite + MarketState + balances/PnL).
  The model returns JSON with each agent's social actions and at most one market action. Hyvo validates the output.
- Social actions then run either:
  - (i) as `ManualAction`s in one `env.step` (list per agent allowed; env.py:157-190), or
  - (ii) as direct `await agent.env.action.create_post(...)` calls that **return new ids** (probe:
    `{'success': True, 'post_id': 5}`), followed by `env.platform.sandbox_clock.time_step += 1`.
- Market actions run via web3 in Hyvo code. `hold` and `check_market` are Hyvo-side no-ops, since MarketState is always in
  the prompt.
- (probe) Two full ManualAction steps made **0** model calls.
- **Effort.** About 2–4 days: prompt builder, batch JSON schema and validator, executor, feed builder, usage/budget wrapper,
  replay log.
- **Benefits.**
  - Exact call count: ceil(N/K) per round plus the report.
  - Exact token accounting from Hyvo's own client's `response.usage`.
  - A budget check before every call.
  - No tool-calling or `strict` dependence: plain JSON works with `response_format={"type": "json_object"}` or tolerant
    parsing.
  - No hidden memory growth.
  - Every output is stored for replay (spec §5.2).
- **Pitfalls.**
  - Read feeds from SQLite, not with `refresh()`. `refresh` writes a trace row, and a second refresh in the same step with
    the same result fails with `UNIQUE constraint failed: trace...`, returning `success: False` (probe, §5.5).
  - Validate ids yourself: foreign keys are not enforced, so `follow(999)` succeeded (probe), while `like_post(999)` returned
    an error dict (probe).
  - `ManualAction.action_args` must use the exact parameter names (`followee_id`, `quote_content`, ...). A wrong name raises
    `TypeError` out of `env.step`, because `asyncio.gather` runs without `return_exceptions` (env.py:193). Earlier actions in
    the same step have already run, and the clock does not advance (probe).
  - Do not use `ActionType.INTERVIEW` via ManualAction: `env.step` routes it to `perform_interview`, which calls the LLM
    (env.py:161-168; agent.py:197-249; with StubModel you get "Lorem Ipsum"). Do interviews with Hyvo's client and record
    them with `agent.env.action.perform_action({"prompt": p, "response": r}, "interview")` (platform.py:1348-1392).
  - For dependent actions in one round (comment on a post created that round), use sequential direct calls. ManualAction
    tasks enqueue in list order in practice, but that rests on CPython asyncio scheduling (**inferred**; probe: quote then
    comment in one step both succeeded).
  - Agents lose OASIS's per-agent chat memory. Hyvo must put "your last N actions/posts" in the prompt, which is cheaper.
  - Batch quality risks: JSON adherence of cheap models, and voices of agents in the same batch converging. Keep K moderate
    and give each agent its own section (**inferred**).

### Recommendation

**(c).** It is the only option that meets the spec's "batch decisions per round", exact token counting and a clean stop at
`maxCostUsd`/`maxLlmCalls`. It also removes the dependence on tool-calling and strict-mode support in cheap models.

- Keep OASIS as the social substrate: SQLite schema, action semantics and counters, trace, and sign-up through `env.reset()`.
  Keep `OasisEnv` and `AgentGraph` for compatibility with MiroFish code paths that expect `env.agent_graph` (**inferred**;
  check with the MiroFish-area notes).
- Use recsys `"reddit"` or `"random"`, or a Hyvo feed built from SQL (§5).
- Keep (b) with external tools as a fallback "fidelity mode" if per-agent MiroFish-style calls are ever needed.

Minimal sketch for (c):

```python
stub = ModelFactory.create(ModelPlatformType.OPENAI, ModelType.STUB)        # never called
graph = AgentGraph()
for i, p in enumerate(personas):
    graph.add_agent(SocialAgent(agent_id=i, agent_graph=graph, model=stub,     # agent ids must be 0..N-1 (see §5.6)
        user_info=UserInfo(user_name=p.handle, name=p.handle, description=p.bio,
                           profile={"other_info": {"user_profile": p.text}}, recsys_type="reddit")))
os.environ["OASIS_DB_PATH"] = job_db                                          # see §9
platform = Platform(db_path=job_db, channel=Channel(), recsys_type="reddit",
                    max_rec_post_len=50, refresh_rec_post_count=10)
env = oasis.make(agent_graph=graph, platform=platform, database_path=job_db)
await env.reset()                                                             # sign-ups only, no LLM
for rnd in range(rounds):
    await env.platform.update_rec_table()
    feeds = read_feeds_sql(job_db)          # rec + post + comment + like tables, no trace writes
    decisions = await hyvo_llm.batch(...)   # Hyvo client: usage counted, budget checked first
    ids = await execute_social(graph, decisions)   # direct agent.env.action.* calls, validated
    await execute_market(decisions)                # web3, <= 1 per agent, invalid -> hold
    env.platform.sandbox_clock.time_step += 1      # only meaningful for non-reddit recsys
await env.close()
```

---

## 4. Q3: ManualAction and every action

### 4.1 Signature (oasis/environment/env_action.py:20-45)

```python
@dataclass
class ManualAction:
    action_type: ActionType
    action_args: Dict[str, Any]
    def init(self, action_type, action_args): ...   # dead code (not __init__)

@dataclass
class LLMAction:                                     # empty marker
    def init(self): pass
```

- Usage: `await env.step({agent: ManualAction(...)} | {agent: [ManualAction(...), LLMAction(), ...]})` (env.py:136-198).
- Non-interview ManualActions call `agent.perform_action_by_data(action_type, **action_args)` (env.py:169-173, 185-188;
  agent.py:278-294). That looks up the method by name in the **full 29-tool list**, ignoring `available_actions`
  (probe: a comment succeeded for an agent restricted to the twitter defaults).
- `ActionType.INTERVIEW` goes to `perform_interview(prompt)` instead, which is an LLM call (env.py:161-168, 178-184).

### 4.2 Several actions per agent per step

Yes. Pass a list (env.py:158-175; examples/custom_platform_simulation.py:78-86; probe: two `create_post` in one step, and
also like + repost, quote + comment).

### 4.3 Results and new ids

- `env.step` returns `None` (probe) and drops the `gather` results (env.py:193). Results appear only in the `social.agent`
  log (agent.py:292), in the agent's memory (agent.py:286-291) and in the DB.
- Ways to get ids:
  - **direct calls** (`await agent.env.action.<method>(...)` or `await agent.perform_action_by_data(...)`), which return the
    dict (probe);
  - the `trace.info` JSON (for example `create_post` stores `{"content", "post_id"}` at platform.py:417-419);
  - `SELECT MAX(post_id)`.

### 4.4 Every ActionType

Enum at typing.py:17-49. `ManualAction.action_args` keys must equal the parameter names below. Methods are in
agent_action.py; implementations are in platform.py.

| ActionType value | action_args | Returns (success case) | Notes |
|---|---|---|---|
| `create_post` | `content: str` | `{success, post_id}` | platform.py:400-428 |
| `like_post` | `post_id: int` | `{success, like_id}` | a like on a repost goes to the root post; duplicate like gives error dict (563-616) |
| `unlike_post` | `post_id` | `{success, like_id}` | 618-665 |
| `dislike_post` / `undo_dislike_post` | `post_id` | `{success, dislike_id}` | 667-771 |
| `repost` | `post_id: int` | `{success, post_id}` (new repost id) | new post row: content `''`, original_post_id set, quote_content NULL; one repost per user per post (430-502) |
| `quote_post` | `post_id: int, quote_content: str` | `{success, post_id}` | new row copies original `content`, stores `quote_content` (504-561) |
| `create_comment` | `post_id: int, content: str` | `{success, comment_id}` | a comment on a repost goes to the root post (1079-1111) |
| `like_comment` / `unlike_comment` | `comment_id` | `{success, comment_like_id}` | 1113-1219 |
| `dislike_comment` / `undo_dislike_comment` | `comment_id` | `{success, comment_dislike_id}` | 1221-1330 |
| `follow` / `unfollow` | `followee_id: int` | `{success, follow_id}` | updates user counters; no FK check (859-964) |
| `mute` / `unmute` | `mutee_id: int` | `{success, mute_id}` | mute does **not** filter feeds: grep shows only platform.py:966-1028 touch the `mute` table, with no reader in refresh or recsys |
| `do_nothing` | `{}` | `{success: True}` | records trace `{}` (1332-1346) |
| `refresh` | `{}` | `{success, posts:[...]}` | see §5.3 |
| `search_posts` / `search_user` | `query: str` | `{success, posts}` / `{success, users}` | LIKE on content, ids (773-857) |
| `trend` | `{}` | `{success, posts}` | top `trend_top_k=1` by likes in the last 7 days (1030-1077; platform.py:112-113) |
| `report_post` | `post_id, report_reason` | `{success, report_id}` | after 2 reports a warning prefix is shown (1394-1446; platform_utils.py:156-160) |
| `purchase_product` | `product_name, purchase_num` | `{success, product_id}` | needs `sign_up_product` (208-256) |
| `interview` | `prompt: str` | `{success, interview_id}` | via env.step this is an LLM call (§4.1) (1348-1392) |
| `create_group` / `join_group` / `leave_group` | `group_name` / `group_id` | `{success, group_id}` / `{success}` | 1497-1602 |
| `send_to_group` | `group_id, message` | `{success, message_id, to}` | 1448-1495 |
| `listen_from_group` | `{}` | `{success, all_groups, joined_groups, messages}` | 1604-1642 |
| `sign_up` | (not a tool) | `{success, user_id}` | only via `agent.env.action.sign_up(user_name, name, bio)`; `user_id = agent_id` (178-206) |
| `exit`, `update_rec_table` | platform-internal | | `env.close()` sends EXIT (env.py:200-208); UPDATE_REC_TABLE can go via the channel (test/infra/recsys/test_update_rec_table.py:95-96) |

Failure results are dicts `{success: False, error|message}`, not exceptions (probe: `like_post(999)` gave
`"'NoneType' object is not subscriptable"`). The exceptions are wrong kwargs (`TypeError`, §3c) and unknown
`ActionType` values.

---

## 5. Q4: feeds, DB reading, recsys

### 5.1 SQLite schema

Files in oasis/social_platform/schema/*.sql, executed by `create_db` (oasis/social_platform/database.py:84-201).

```sql
-- user.sql:2-11
CREATE TABLE user (user_id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER, user_name TEXT, name TEXT, bio TEXT,
  created_at DATETIME, num_followings INTEGER DEFAULT 0, num_followers INTEGER DEFAULT 0);
-- post.sql:3-16
CREATE TABLE post (post_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
  original_post_id INTEGER,          -- NULL for an original post
  content TEXT DEFAULT '',           -- repost: '' ; quote: copy of the original content
  quote_content TEXT,                -- NULL for original or repost
  created_at DATETIME, num_likes INTEGER DEFAULT 0, num_dislikes INTEGER DEFAULT 0,
  num_shares INTEGER DEFAULT 0,      -- reposts + quotes
  num_reports INTEGER DEFAULT 0, FOREIGN KEY(user_id) REFERENCES user(user_id),
  FOREIGN KEY(original_post_id) REFERENCES post(post_id));
-- comment.sql:2-12
CREATE TABLE comment (comment_id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, user_id INTEGER, content TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, num_likes INTEGER DEFAULT 0, num_dislikes INTEGER DEFAULT 0, ...FKs);
-- like.sql:2-9 / dislike.sql:2-9   ("like" is a keyword: quote it)
CREATE TABLE like (like_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, post_id INTEGER, created_at DATETIME, ...);
-- follow.sql:2-9
CREATE TABLE follow (follow_id INTEGER PRIMARY KEY AUTOINCREMENT, follower_id INTEGER, followee_id INTEGER, created_at DATETIME, ...);
-- mute.sql:2-9  (mute_id, muter_id, mutee_id, created_at)
-- report.sql:2-10 (report_id, user_id, post_id, report_reason, created_at)
-- comment_like.sql:2-9 / comment_dislike.sql:2-9 (…_id, user_id, comment_id, created_at)
-- rec.sql:2-8
CREATE TABLE rec (user_id INTEGER, post_id INTEGER, PRIMARY KEY(user_id, post_id), ...);
-- trace.sql:2-9
CREATE TABLE trace (user_id INTEGER, created_at DATETIME, action TEXT, info TEXT,
  PRIMARY KEY(user_id, created_at, action, info), ...);
-- product.sql:2-6 (product_id INTEGER PRIMARY KEY, product_name TEXT, sales INTEGER DEFAULT 0)
-- chat_group.sql:1-5, group_member.sql:1-7 (PK(group_id, agent_id)), group_message.sql:1-9   (IF NOT EXISTS)
```

**Notes**

- The core tables use plain `CREATE TABLE` (not `IF NOT EXISTS`). Reusing a DB file therefore fails at `user`.
  `create_db` only `print`s the error (database.py:198-199), so delete the file before every run. OASIS examples and
  MiroFish do this (examples/quick_start.py:80-82; backend/scripts/run_parallel_simulation.py:1151-1153).
- `PRAGMA synchronous = OFF` (platform.py:84). Every write commits immediately (`commit=True`; platform_utils.py:47-57), so a
  second `sqlite3` connection sees data at once. Foreign keys are never enabled (probe: following a nonexistent user
  succeeded).
- `user_id == agent_id` (platform.py:187-195). With `generate_twitter_agent_graph` / `generate_reddit_agent_graph`,
  `user.user_name` is NULL and `user.name` holds the profile's `username`, because the helpers build `UserInfo(name=...)`
  without `user_name` (agents_generator.py:591-596, 633-638, 557-560).
- **created_at depends on recsys type.**
  - Non-reddit ("twitter-mode"): the integer clock step from `Clock.get_time_step()` (a string, stored as INTEGER; probe
    showed 0,1,2,4).
  - Reddit: a datetime string, `start_time + k × (now − real_start)` (clock.py:25-30).
  - `trace.created_at` is always recomputed; the `current_time` argument of `_record_trace` is ignored
    (platform_utils.py:188-217).
- `trace.info` is `json.dumps(...)` with ASCII escaping (platform_utils.py:212). `post.content` keeps real Unicode (probe).
- Trace contents per action:
  - follow stores only `{"follow_id"}`; join `follow` to get the followee (platform.py:905-907);
  - create_comment stores `{"content", "comment_id"}` with no post id (1104-1107);
  - repost stores `{"reposted_id", "new_post_id"}`; quote stores `{"quoted_id", "new_post_id"}` (496-498, 555-557);
  - refresh stores the entire feed JSON (319-322), so it is heavy.

Useful queries for `run.json`:

```sql
SELECT p.post_id, p.user_id, u.name, p.original_post_id,
       CASE WHEN p.original_post_id IS NULL THEN 'post' WHEN p.quote_content IS NULL THEN 'repost' ELSE 'quote' END kind,
       COALESCE(p.quote_content, p.content) text, p.created_at, p.num_likes, p.num_dislikes, p.num_shares
FROM post p JOIN user u ON u.user_id = p.user_id ORDER BY p.post_id;
SELECT comment_id, post_id AS reply_to, user_id, content, created_at, num_likes FROM comment;
SELECT user_id, post_id, created_at FROM "like";   SELECT follower_id, followee_id, created_at FROM follow;
SELECT rowid, user_id, created_at, action, info FROM trace ORDER BY rowid;      -- full action log
SELECT post_id FROM rec WHERE user_id = ?;                                       -- feed candidates for agent ?
```

### 5.2 Rec table semantics

- `rec(user_id, post_id)` is a per-user candidate buffer. `update_rec_table()` rebuilds it with `DELETE FROM rec` and a
  batch insert (platform.py:328-398). `env.step` calls it directly at the start of every step (env.py:152).
- Row i of the rec matrix is assigned to `user_id = i` (platform.py:389-391). That assumes agent ids are 0..N-1.

### 5.3 What `refresh` returns, i.e. the agent's feed (platform.py:258-326)

1. Sample `refresh_rec_post_count` ids from the agent's `rec` rows (platform.py:268-278).
2. If recsys != reddit, also add the top `following_post_count` posts by followed users, ordered by likes
   (platform.py:280-304).
3. `SELECT ... WHERE post_id IN (...)` returns them in post_id order, not ranked (platform.py:306-313).
4. `_add_comments_to_posts` renders reposts as `"User X reposted a post from User Y. Repost content: ..."` and quotes as
   `"User X quoted ... Quote content: ... Original Content: ..."`. It attaches all comments, adds a report warning, and
   uses `score` instead of likes and dislikes when `show_score` is set (platform_utils.py:75-186).
5. Own posts are not filtered by random or reddit recsys (probe: agent 0 saw its own posts).

To reproduce a feed **without** side effects, read `rec` plus the follow query above directly from SQL. Calling `refresh`
writes a trace row and can collide (§5.5).

### 5.4 Recsys types (typing.py:81-85; dispatch at platform.py:336-381)

| `recsys_type` | Function | Behaviour | ML / network | Verdict |
|---|---|---|---|---|
| `"random"` | `rec_sys_random` (recsys.py:136-165) | random `max_rec_post_len` posts per user | none (probe: 0.01 s) | offline-safe |
| `"reddit"` (Platform default, platform.py:64) | `rec_sys_reddit` (recsys.py:213-259) | Reddit hot score (likes − dislikes, time decay); **same list for every user** | none (probe: 0.01 s) | offline-safe, cheapest realistic |
| `"twitter"` | `rec_sys_personalized_with_trace` (recsys.py:682-797) | meant to be bio↔post similarity plus like traces | the global `model` is never loaded on this path, so scores are random | **broken**, see below |
| `"twhin-bert"` (forced by `DefaultPlatformType.TWITTER`, env.py:76-85) | `rec_sys_personalized_twh` (recsys.py:419-606) | TwHIN-BERT embeddings of user profiles and recent posts, recency score | downloads `Twitter/twhin-bert-base` via transformers on the first update with ≥1 post (recsys.py:64-80, 431-434); torch inference on CPU | heavy; offline-unsafe |

**`"twitter"` is broken** (probe):

- `KeyError: 'post_id'` whenever posts > `max_rec_post_len`. `get_trace_contents` and the swap step read `trace['post_id']`,
  but the trace table has no such column (recsys.py:670, 786-789). `update_rec_table` does not catch it for this branch, so
  `env.step` crashes.
- When posts ≤ `max_rec_post_len`, there is an off-by-one: `[post_ids] * (len(rec_matrix) - 1)` (recsys.py:722). The last
  user gets no recommendations (probe: users 0 and 1 got rows, user 2 got none).

**`"twhin-bert"` offline** (probe): it retried huggingface.co for about **46 s**. The exception is swallowed
(platform.py:372-375) and the rec table stays **empty**. Because the globals stay `None`, every later step retries the
download (**inferred** from recsys.py:431-434).

**Other model paths**

- `use_openai_embedding=True` switches twhin to the OpenAI embeddings API, `text-embedding-3-small`, which needs network and
  `OPENAI_API_KEY` (platform.py:68, 109; recsys.py:529-531; process_recsys_posts.py:49-71).
- The sentence-transformers model `paraphrase-MiniLM-L6-v2` (cache `./models`, recsys.py:83-112) is reachable only through
  `rec_sys_personalized` (recsys.py:262-353). Only tests call it (test/infra/recsys/test_recsys.py:74, 228), so Platform
  never downloads it.
- torch is **imported** unconditionally (recsys.py:25-29; `torch.cuda.is_available()` at import, recsys.py:46, 116). It does
  compute work only for twhin-bert.

**Verdict.** For Hyvo use `"reddit"` (hot, global) or `"random"` with a custom `Platform(...)` instance (env.py:103-112).
Never use `DefaultPlatformType.TWITTER` on the laptop. Alternatively subclass `Platform` and override `update_rec_table`
with a Hyvo feed (recent + hot + following on integer rounds). It is a plain method that env.step calls (env.py:152), so
this is low effort (**inferred**).

### 5.5 Trace primary-key collisions

`PRIMARY KEY(user_id, created_at, action, info)` (trace.sql:7). In twitter-mode `created_at` is the step number, so the
same agent doing the *same* action with the *same* info twice in one step fails with
`UNIQUE constraint failed: trace.user_id, trace.created_at, trace.action, trace.info`. The platform method returns
`success: False`. Confirmed for:

- `do_nothing` twice;
- `refresh` twice with an identical result set. (probe) An LLM agent whose feed had already been fetched that step saw
  **"After refreshing, there are no existing posts."** For any other action in that branch the SQL write still happened
  before the trace insert failed (e.g. create_post inserts first; **inferred** from code order).

### 5.6 Other bugs and constraints relevant to reading feeds

- **Quote post first in a feed** (probe): `_add_comments_to_posts` never sets `num_reports` in the quote branch
  (platform_utils.py:103-110). The comparison at :157 raises `UnboundLocalError` when a quote is the first row, so the whole
  `refresh` returns `success: False`. If a quote follows another post, it inherits that post's report count.
- **Agent ids must be contiguous 0..N-1, added in order.**
  - `AgentGraph.get_agents()` maps igraph vertex *index* to `agent_mappings` (agent_graph.py:235-237).
  - The rec matrix assumes it too (database.py:257-275; platform.py:389-391).
  - The twhin globals assume it (recsys.py:52-58 comment).

---

## 6. Q5: clock and steps

- `Clock(k)` has `real_start_time`, magnification `k` and `time_step` (clock.py:17-33). Platform default is `Clock(60)`
  with `start_time = datetime.now()` (platform.py:76-81).
- `env.step(actions)` (env.py:136-198) runs in this order:
  1. `await platform.update_rec_table()` (direct call, synchronous SQL; :152);
  2. build tasks **only for agents in `actions`** (:157-190): not all agents act. MiroFish picks active agents per round
     (backend/scripts/run_parallel_simulation.py:1040-1060, 1253);
  3. `asyncio.gather(*tasks)` with no `return_exceptions` (:193);
  4. if platform type is TWITTER (i.e. recsys != reddit, :109-112), `time_step += 1` (:197-198).
- `env.step({})` is valid: it updates recs and advances the clock (probe).
- Time advance:
  - twitter-mode: one integer tick per `env.step`. Actions in step n are stamped `n-1`, because the increment comes after
    the actions; sign-ups are stamped 0 (probe).
  - reddit-mode: there is no per-step tick. Timestamps are wall-clock × k. Hyvo must track round boundaries itself, e.g. by
    `trace` rowid ranges as MiroFish does with `last_rowid` (backend/scripts/run_parallel_simulation.py:1169), or by post-id
    ranges.
  - The recsys choice fixes the clock mode, because each Platform method branches on `recsys_type == REDDIT`, and
    `rec_sys_reddit` parses datetime strings (recsys.py:238-243). You cannot have reddit recsys with integer rounds without
    subclassing (**inferred**).
- `env.reset()` starts `platform.running()` as a task and signs up every agent through the channel
  (env.py:118-122; agents_generator.py:547-564).
- `env.close()` sends EXIT and awaits the task. The DB is closed only then (env.py:200-208; platform.py:135-145).
- A `:memory:` DB is backed up to `mock.db` in the CWD on exit (platform.py:138-141).

---

## 7. Q6: model backends and token usage

### 7.1 Getting a model

`ModelFactory.create(model_platform, model_type, model_config_dict=None, token_counter=None, api_key=None, url=None,
timeout=None, max_retries=3, **kwargs)` (camel/models/model_factory.py:112-202). The platform-to-class map is at :69-110 and
includes OPENAI, OPENAI_COMPATIBLE_MODEL, DEEPSEEK, OPENROUTER, OLLAMA, VLLM, GROQ, etc. `model_type` can be any string; it
becomes a `UnifiedModelType` (:172-181).

| Platform | Key / URL env fallbacks | Notes |
|---|---|---|
| `ModelPlatformType.OPENAI` (MiroFish's choice) | `OPENAI_API_KEY`, `OPENAI_API_BASE_URL` (camel/models/openai_model.py:116-117) | `@api_keys_required` raises if the key is missing (openai_model.py:98-102; probe message below) |
| `ModelPlatformType.OPENAI_COMPATIBLE_MODEL` | `OPENAI_COMPATIBILITY_API_KEY`, `OPENAI_COMPATIBILITY_API_BASE_URL`, `MODEL_TIMEOUT` (openai_compatible_model.py:97-99) | builds `OpenAI` / `AsyncOpenAI(base_url, api_key)` (:129-142); `model_config_dict` is forwarded verbatim (:287-301) |

- Defaults: `ModelPlatformType.DEFAULT` = env `DEFAULT_MODEL_PLATFORM_TYPE` or `"openai"` (camel/types/enums.py:1679).
  `ModelType.DEFAULT` = env `DEFAULT_MODEL_TYPE` or `"gpt-4.1-mini-2025-04-14"` (enums.py:33).
- `model=None` in SocialAgent resolves to that default (chat_agent.py:595-600).
- Optional tracing: Langfuse only with `LANGFUSE_ENABLED=true` (model_factory.py:160-163); traceroot only with
  `TRACEROOT_ENABLED` (base_model.py:38-51). Request/response JSON logging via `CAMEL_MODEL_LOG_ENABLED` writes to
  `CAMEL_LOG_DIR` (base_model.py:119-123, 261-321).

Recommended way to point at any OpenAI-compatible endpoint:

```python
model = ModelFactory.create(
    model_platform=ModelPlatformType.OPENAI_COMPATIBLE_MODEL,
    model_type=os.environ["LLM_MODEL_NAME"],
    api_key=os.environ["LLM_API_KEY"], url=os.environ["LLM_BASE_URL"],
    model_config_dict={"temperature": 0.8},     # NOT max_tokens unless you accept it as the context limit (§2.7)
    token_counter=ApproxCounter(),              # BaseTokenCounter subclass, avoids the tiktoken download (§8.2)
    timeout=60, max_retries=1)
```

With option (c), Hyvo does not need camel for its own calls: `openai.AsyncOpenAI(base_url=..., api_key=...)` plus
`resp.usage` is simpler.

### 7.2 Where token usage is exposed

- **Per `astep`.** `response.info["usage"] = {"prompt_tokens", "completion_tokens", "total_tokens"}`, summed over all model
  iterations in the step (chat_agent.py:2021-2024, 2094-2102, 2125-2157; camel/agents/_utils.py:133-166). (probe)
  `{"prompt_tokens": 123, "completion_tokens": 45, "total_tokens": 168}`.
  - info keys: `id, usage, termination_reasons, num_tokens, tool_calls, external_tool_call_requests`.
  - `num_tokens` is camel's own context estimate, not billing.
- **Per raw model call.** `BaseModelBackend.arun()` returns the provider `ChatCompletion` with `.usage`
  (base_model.py:437-487). `_handle_batch_response` copies it into `ModelResponse.usage_dict` (chat_agent.py:2542-2544).
- **OASIS drops it.** `perform_action_by_llm` returns the response only when tool calls exist, `None` otherwise, or the
  exception (agent.py:139-155). `perform_interview` returns only content (agent.py:226-249). `env.step` returns `None`
  (env.py:193).

### 7.3 Budget hook if OASIS agents ever call the LLM (options a/b)

Every agent LLM path (`perform_action_by_llm`, `perform_interview`, `perform_test`) goes through
`ModelManager.arun` → `backend.arun` → `backend._arun` (model_manager.py:242-288; base_model.py:480).

Wrap or subclass the backend's `_arun` to:

1. check `maxLlmCalls` / `maxCostUsd` and raise when the budget is exhausted;
2. call the parent;
3. record `resp.usage` and the model id.

The probe used this pattern (`stub._arun = counting_arun`). A raised error inside `_arun` re-raises out of
`_aget_model_response` (chat_agent.py:2269-2274) and is swallowed by `perform_action_by_llm`. The agents then become no-ops,
so the runner must check the budget flag after each `env.step` and stop with status `partial` (**inferred** design).

---

## 8. Q7: zero LLM calls; what needs a model; network at init

### 8.1 Zero LLM calls

**Yes.** ManualAction (except INTERVIEW), direct `agent.env.action.*` calls, `env.reset()` (sign-ups), `env.step({})` and
`update_rec_table` (random/reddit) never touch the model (agent.py:278-294; env.py:118-122). (probe) 0 model calls over 2
manual steps plus direct calls.

### 8.2 Does construction need a model?

- **SocialAgent: effectively yes.**
  - `model=None` means camel's default OpenAI backend. Without `OPENAI_API_KEY` it raises
    `ValueError: Missing or empty required API keys in environment variables: OPENAI_API_KEY` (probe; camel/utils/commons.py:362-364).
  - With a dummy key it then needs tiktoken (below).
  - Use `ModelFactory.create(ModelPlatformType.OPENAI, ModelType.STUB)`. (probe) 3 agents built in 0.14 s with no network
    and no key. StubModel answers `"Lorem Ipsum"` with fake usage 10/10 and token_limit 4096 (stub_model.py:111-147;
    enums.py:1101-1116).
- **AgentGraph()** (igraph backend) needs no model and no network (agent_graph.py:178-190). The neo4j backend connects and
  calls `verify_connectivity()` at construction (agent_graph.py:27-32). Do not use it.
- **Platform and OasisEnv** need no model.

### 8.3 Network at init or first use

| Trigger | Network | Evidence |
|---|---|---|
| `import oasis` / `import camel` | none | probe (0 attempts) |
| Constructing a SocialAgent with an OPENAI or OPENAI_COMPATIBLE backend and the default token counter | **downloads `o200k_base.tiktoken`** from `openaipublic.blob.core.windows.net`. `ChatAgent.__init__` reads `token_counter` (chat_agent.py:478-481), which builds `OpenAITokenCounter(GPT_4O_MINI)` and calls `tiktoken.encoding_for_model` (openai_compatible_model.py:438-448; camel/utils/token_counting.py:51-74, 162). Cache: `TIKTOKEN_CACHE_DIR`, else `DATA_GYM_CACHE_DIR`, else `%TEMP%\data-gym-cache` (tiktoken/load.py:35-75). This laptop has **no** cache yet. | probe: offline construction **fails** with `ConnectionError ... o200k_base.tiktoken`; with a custom `token_counter`, 0 attempts |
| First `update_rec_table` with recsys `twhin-bert` and ≥1 post | huggingface.co `Twitter/twhin-bert-base` (tokenizer and model) | probe (about 46 s of retries offline, then rec table empty). Model size not verified. |
| `use_openai_embedding=True` | OpenAI embeddings API | process_recsys_posts.py:57-67 |
| LLM calls (`LLMAction`, INTERVIEW) | provider endpoint | |
| neo4j AgentGraph | bolt connection | agent_graph.py:27-32 |

---

## 9. Q8: import cost and Windows concerns

### 9.1 Import cost (probe on this laptop)

- `import camel.agents` takes about 2.7 s, and `import oasis` adds about **11.6 s** (about 14 s total, `-X importtime` in
  `probe_run\importtime.txt`).
- It eagerly loads **torch, sentence-transformers, transformers, sklearn, scipy, igraph, neo4j, pandas, openai,
  unstructured** (unstructured via `camel.loaders`). cairocffi and tiktoken stay lazy.
- Import chain: `oasis/__init__.py:16-25` → `oasis/social_platform/__init__.py:14-15` → `platform.py:31-33` →
  `recsys.py:25-31` (torch, sentence_transformers, sklearn) → `process_recsys_posts.py:16-19` (torch, transformers,
  camel.embeddings).
- Breakdown: `oasis.social_platform` 12.0 s, of which sentence_transformers is about 7.8 s and torch about 2.8 s.
- Importing any `oasis.*` submodule runs the package `__init__` first, so you cannot dodge torch by importing submodules.
- **Workaround (probe).** Insert a stub module as `sys.modules["oasis.social_platform.recsys"]` that defines
  `rec_sys_random`, `rec_sys_reddit`, `rec_sys_personalized_twh` and `rec_sys_personalized_with_trace` *before*
  `import oasis`. That cuts the import to **3.9 s** and never loads torch, sentence-transformers, transformers or sklearn.
  Platform with random/reddit-style functions then works (probes `probe_misc.py` and `probe_misc2.py` ran full envs this
  way). torch is still installed as a dependency of the camel-oasis pins.

### 9.2 Import side effects (CWD-relative)

- Importing creates `./log/` (platform.py:36-39; env.py:29-32) and opens **4 FileHandlers** for the process lifetime:
  `social.twitter-*.log` (platform.py:45), `social.agent-*.log` (agent.py:44-45), `oasis-*.log` (env.py:40-41) and
  `table-*.log` (testing/show_db.py:21-22). (probe: 4 files)
- There is already `C:\.hyvo\engine\log\` with such files from an earlier import run in that directory.
- Run the runner from a dedicated working directory, not the per-job directory. **Inferred:** on Windows, open handles
  block deleting that directory until the process exits.
- camel calls `logging.basicConfig(level=CAMEL_LOGGING_LEVEL or WARNING, stream=sys.stdout)` at import unless
  `CAMEL_LOGGING_DISABLED=true` (camel/logger.py:24-40, 173-174). OASIS loggers set DEBUG/INFO (agent.py:40;
  platform.py:43; env.py:36) and propagate, so **every observation and action is printed to stdout** (probe).
- More stdout noise: `print("db_path", ...)` (database.py:93) and the reddit prompt's `print(profile)` (user.py:93).

### 9.3 Encoding on Windows

- The probe process had `sys.stdout.encoding == 'cp1252'` and preferred encoding `cp1252`.
- Logging an emoji produced **2 `--- Logging error --- UnicodeEncodeError: 'charmap'`** tracebacks (probe). One is from the
  `social.agent` FileHandler, opened without `encoding` (agent.py:44-45; platform.py:45 likewise). The other is from camel's
  stdout handler. These errors are non-fatal and spammy.
- `agents_generator.py` opens reddit profile JSON with `open(path, "r")` and no encoding (agents_generator.py:449, 574), so
  non-ASCII profiles can fail or mis-decode (**inferred**). The schema `.sql` files are pure ASCII (checked), so
  `create_db`'s `open()` (database.py:100) is safe.
- **Fix:** run the engine with `PYTHONUTF8=1` (UTF-8 mode makes `open()` and stdio default to UTF-8), or reconfigure the
  handlers after import.

### 9.4 SQLite paths and the event loop

- **SQLite paths.** Windows absolute paths work (probe). `get_db_path()` reads `OASIS_DB_PATH`, otherwise
  `<site-packages>/oasis/data/social_media.db`, and it runs `os.makedirs` there (database.py:62-74).
  `SocialEnvironment.get_followers_env/get_follows_env` call it on **every observation** (agent_environment.py:71, 89), so
  without `OASIS_DB_PATH` the venv gets an `oasis/data/` folder and an empty DB file (**inferred** from code; avoided in
  probes).
  - Set `OASIS_DB_PATH` to the job DB, as the examples do (examples/quick_start.py:77-78).
  - It is process-global, so two platforms in one process share it. Harmless, because the values are unused (§2.3).
  - The DB stays open until `env.close()`. **Inferred:** Windows file locking means you cannot delete the DB before then.
- **asyncio.** Default Windows `ProactorEventLoop` works; all probes ran on it. OASIS uses no uvloop. Note that the
  Proactor loop's self-pipe uses a loopback `socketpair`, so sandboxing that blocks loopback breaks asyncio itself (probe
  hit this).
  - `Channel` polls every 0.1 s (channel.py:62-71), so each awaited action has about ≥0.1 s latency. A 4-action manual step
    took 0.27 s (probe).
  - `Platform` executes actions strictly sequentially in one task (platform.py:128-173).
  - `asyncio.Queue` and `asyncio.Lock` are created in `__init__`s (channel.py:22, 44; camel model_manager.py:77). That is
    fine on 3.10+, where they bind to the loop lazily.
- **multiprocessing / POSIX-only.** OASIS has no `multiprocessing`, `fork`, `signal`, `uvloop` or `/tmp` usage (grep over
  `oasis/`). torch imports `multiprocessing` but does not use it here.

---

## 10. Consolidated bug and pitfall list (OASIS 0.2.5 / camel 0.2.78)

1. Recsys `"twitter"` crashes `env.step` with `KeyError: 'post_id'` once posts > `max_rec_post_len`, and gives the last user
   no recs otherwise (recsys.py:670, 722, 786-789). Probe.
2. Recsys `"twhin-bert"` (and therefore `DefaultPlatformType.TWITTER`) downloads an HF model and runs torch on CPU. Offline
   it costs about 46 s per step and leaves the rec table empty (env.py:76-85; recsys.py:64-80, 431-434; platform.py:372-375).
   Probe.
3. Trace PK collisions on identical same-step actions (trace.sql:7). Probe (do_nothing; refresh, giving an empty feed to
   the LLM).
4. A quote post as the first feed row makes refresh fail with `UnboundLocalError` (platform_utils.py:103-110, 157). Probe.
5. `UserInfo` prompt raises `UnboundLocalError` when `other_info.user_profile` is missing or None (user.py:57-71). Probe.
6. `perform_action_by_llm` returns only on the first tool call, `None` with no tool calls, and swallows errors; `env.step`
   returns `None`. Usage is never surfaced (agent.py:139-155; env.py:193). Probe.
7. `max_tokens` in `model_config_dict` doubles as the memory context limit and can silently terminate steps with no call
   (base_model.py:529-542; chat_agent.py:2001-2007). Probe.
8. Memory has no window and token_limit is 999,999,999 for unknown model names, so prompt cost grows every round
   (chat_agent.py:478-487; unified_model_type.py:64-71).
9. `ChatAgent.add_external_tool(FunctionTool)` raises `KeyError: 'name'` (chat_agent.py:779-783). Probe.
10. FunctionTool always sends `strict: true` (function_tool.py:181).
11. A wrong ManualAction kwarg raises out of `env.step` after earlier actions ran, and the clock does not tick (env.py:193).
    Probe.
12. No FK enforcement: follow or other actions with nonexistent ids "succeed" (probe), so validate in Hyvo.
13. Observation JSON escapes non-ASCII (agent_environment.py:62); follower counts are computed but unused, and read from the
    wrong DB (agent_environment.py:49-53, 68-101). Probe.
14. Import costs about 14 s and pulls torch (§9.1); writes `./log` and 4 log files; prints everything to stdout (§9.2);
    cp1252 logging errors on Windows (§9.3). Probe.
15. tiktoken BPE download at agent construction for real backends; offline it fails (§8.3). Probe.
16. Examples pass `single_iteration=False` (examples/search_tools_simulation.py:69; examples/sympy_tools_simulation.py:69),
    a kwarg SocialAgent 0.2.5 does not accept (agent.py:58-70), so they raise `TypeError` (from the signature; not run).
17. igraph `get_agents()` requires contiguous 0..N-1 agent ids (agent_graph.py:235-237).
18. `mute` has no effect on feeds (grep: the table is written by platform.py:966-1028 and never read).
