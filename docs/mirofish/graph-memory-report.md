# MiroFish: knowledge graph (Zep), simulation memory, ReportAgent, deep interaction, LLM client

Notes for Hyvo (SPEC sections 1, 5, 6, 14). Area: graph building, Zep memory, ReportAgent, deep interaction, LLM client.

## 0. Sources, conventions, caveats

- MiroFish root: `C:\.hyvo\engine\mirofish`. It is vendored as a git subtree squashed from upstream commit `7657031` (from `git log`). License AGPL-3.0 (`backend/pyproject.toml:6`).
- Unless prefixed, paths are relative to the MiroFish root. Other prefixes:
  - `OASIS:` = the OASIS v0.2.5 source root (a local checkout, `oasis-src/oasis`).
  - `camel:` = `C:\.hyvo\engine\.venv\Lib\site-packages\camel` (camel-ai 0.2.78, now installed).
  - `zep_cloud:` = `...\site-packages\zep_cloud` (zep-cloud 3.25.0).
  - `openai:` = `...\site-packages\openai` (openai 1.109.1).
- Pinned deps: `zep-cloud==3.25.0`, `camel-oasis==0.2.5`, `camel-ai==0.2.78`, `openai>=1.0.0`, plus Flask, flask-cors and PyMuPDF (`backend/pyproject.toml:11-36`).
- Nothing was run against Zep or an LLM. Everything below comes from reading code. **"Inferred"** marks conclusions the code does not state directly.
- Most comments and all prompts are in Chinese. Translations below are mine.

---

## 1. Graph building: seed documents to Zep graph

### 1.1 Flow (two HTTP steps)

1. `POST /api/graph/ontology/generate` (`backend/app/api/graph.py:265-443`), multipart.
   - Takes `files` (pdf/md/txt, `backend/app/config.py:38`), a required `simulation_requirement`, and optional `additional_context`.
   - Text extraction: `FileParser.extract_text` (`backend/app/utils/file_parser.py:81-135`, PyMuPDF for PDF), then `TextProcessor.preprocess_text` (`backend/app/services/text_processor.py:37-61`).
   - The concatenated text, with `=== filename ===` headers, is saved per project (`graph.py:341-356`).
   - `OntologyGenerator().generate(...)` makes **1 LLM call** (`graph.py:361-366`). It saves `project.ontology` and sets status `ONTOLOGY_GENERATED` (`graph.py:373-379`).
2. `POST /api/graph/build` (`graph.py:448-839`) starts a daemon thread `build_task` (`graph.py:651-816`). Steps:
   - chunk → `create_graph` → `set_ontology` → Batch API ingest → wait → `get_graph_data`
   - Final status `GRAPH_COMPLETED` (`graph.py:782-799`).
   - Restart/resume support: `project.graph_id` is persisted *before* the create POST (`graph.py:705-712`), `zep_batch_id`/`zep_batch_operation_id` are persisted (`graph.py:737-740`), and a resume path exists (`graph.py:529-571, 679-696`).
   - `GraphBuilderService.build_graph_async` / `_build_graph_worker` (`backend/app/services/graph_builder.py:75-216`) are a legacy duplicate of these steps. The API route does not use them; only tests reference them.

### 1.2 Ontology generation by LLM (`backend/app/services/ontology_generator.py`)

- System prompt `ONTOLOGY_SYSTEM_PROMPT` (`:48-191`). It targets "social-media public-opinion simulation".
  - Entities must be real actors that can post: people, companies, organizations, government, media. Abstract concepts, topics and stances are excluded (`:59-73`).
  - **Exactly 10 entity types.** The last two must be the fallbacks `Person` and `Organization` (`:113-131`).
  - 6-10 edge types (`:140-142`), 1-3 attributes each, and the reserved attribute names are forbidden (`:144-148`).
  - The language instruction and an English naming rule are appended (`:227-228`).
- Call: `self.llm_client.chat_json(messages, temperature=0.3, max_tokens=None, max_attempts=2)` (`:235-243`).
- Input size:
  - Up to 50,000 chars are sent as-is (`MAX_TEXT_LENGTH_FOR_LLM`, `:250-251`).
  - Longer input is split into 8,000-char chunks; up to 60 are sampled evenly, each as a head+tail excerpt (`:252-255, 296-430`).
  - That is a single large call, roughly 12k-50k input tokens (inferred).
- Output shape: `{entity_types:[{name, description, attributes:[{name,type,description}], examples}], edge_types:[{name, description, source_targets:[{source,target}], attributes}], analysis_summary}` (`:79-106`).
- Post-processing `_validate_and_process` (`:432-625`):
  - Entity names become PascalCase and edge names UPPER_SNAKE.
  - Duplicates are removed and the Person/Organization fallbacks are added (`:500-545`).
  - Entities are capped at 10, then edge endpoints are resolved against the surviving types (`:550-623`).
- Limits and reserved names: `MAX_ONTOLOGY_TYPES = 10`, `MAX_ONTOLOGY_ATTRIBUTES = 10`, `MAX_ONTOLOGY_SOURCE_TARGETS = 10`, `RESERVED_ONTOLOGY_ATTRIBUTE_NAMES = {uuid, name, group_id, graph_id, name_embedding, summary, created_at}` (`backend/app/utils/ontology.py:6-17`).
- **Hyvo relevance:** Stage 1 does not need it. Its "entities = speaking actors" framing does not fit a Token/Narrative/Event graph, so Stage 3 should use a hand-written ontology (§7).

### 1.3 Chunking

- `split_text_into_chunks(text, chunk_size=500, overlap=50)` (`backend/app/utils/file_parser.py:161-202`) is character based.
  - It looks for separators in priority order `['。','！','？','.\n','!\n','?\n','\n\n','. ','! ','? ']`. It uses the first one that occurs beyond 30% of the chunk (`:189-193`).
  - The next chunk starts at `end - overlap` (`:200`).
- Defaults are `Config.DEFAULT_CHUNK_SIZE = 500` and `DEFAULT_CHUNK_OVERLAP = 50` (`config.py:41-42`). The API accepts overrides (`graph.py:587-599`).
- Before any Cloud mutation the code validates: at most 350 items per `batch.add`, at most 50,000 items per batch, at most 10,000 chars per item (`graph_builder.py:566-580`).
- Inferred chunk count: the stride is about 400-450 chars for English prose, so roughly `len(text)/430` chunks. A 4,000-char Hyvo scenario (SPEC §6.5 cap) gives about 10 chunks.

### 1.4 Zep API calls, in order (API route)

| Step | Zep call | Evidence |
|---|---|---|
| Create graph | `client.graph.create(graph_id="mirofish_<16hex>", name, description="MiroFish Social Simulation Graph")`. On a retryable error it reconciles with `graph.get` (up to 3 tries) and does not re-POST. | `graph_builder.py:218-261` |
| Set ontology | `client.graph.set_ontology(graph_ids=[id], entities={Name: EntityModel subclass}, edges={NAME: (EdgeModel subclass, [EntityEdgeSourceTarget])})`. Classes are built dynamically with `type()` and pydantic `Field(description=...)`. Reserved attribute names get an `entity_` prefix. | `graph_builder.py:313-405` |
| Create batch | `client.batch.create(metadata={mirofish_operation_id, graph_id, chunk_count})`, where `operation_id = sha256(graph_id + sha256(chunks))`. On an ambiguous failure it reconciles via `batch.list`. | `graph_builder.py:264-311, 428-455` |
| Add items | `client.batch.add(batch_id, items=[BatchAddItem(type="graph_episode", graph_id, data=chunk, data_type="text", source_description="MiroFish source document chunk", metadata={operation_id, chunk_index, chunk_sha256})])`, one call per 350 chunks. Reconciles via `batch.list_items`. | `graph_builder.py:457-543` |
| Process | `client.batch.process(batch_id)`. Reconciles via `batch.get`. | `graph_builder.py:545-557` |
| Wait | Polls `client.batch.get` **every 3 s** until status is one of `succeeded/partial/failed/invalid/canceled`, timeout 600 s. Then `batch.list_items` (100 per page) and checks that every item `succeeded` with an `episode_uuid`. | `graph_builder.py:631-718`; `backend/app/utils/zep.py:28` |
| Read back | `graph.node.with_raw_response.get_by_graph_id` and `graph.edge...get_by_graph_id`, `limit=100`, opaque cursor from the `zep-next-cursor` response header. | `graph_builder.py:777-875`; `backend/app/utils/zep_paging.py:15-160` |
| Delete | `client.graph.delete(graph_id)`, called on reset, delete and rebuild. | `graph_builder.py:877-879`; `graph.py:76-94` |

- **Mutations are never retried** because they are not idempotent (`graph_builder.py:415-421`). Reads retry 3 times on transport errors, 408, 429 and 5xx, honoring `Retry-After` (`utils/zep.py:92-162`).
- Client: Cloud only. Base URL `https://api.getzep.com/api/v2`, 60 s HTTP timeout, process-cached. `ZEP_API_URL` (self-hosted) is rejected (`utils/zep.py:21-25, 56-83`; `config.py:71-72`).
- Search caps: query at most 400 chars, limit at most 50 (`utils/zep.py:29-53`).
- Known SDK quirk: `graph.node.get_edges` returns only outgoing edges in 3.25. Full context therefore paginates every edge (`backend/app/services/zep_entity_reader.py:177-196`).

### 1.5 Other Zep reads per run (prepare stage)

- `ZepEntityReader.filter_defined_entities` paginates every node and every edge, and keeps nodes whose label is not just `Entity`/`Node` (`zep_entity_reader.py:221-337`). It is called during prepare and preview (`backend/app/services/simulation_manager.py:294-300`; `backend/app/api/simulation.py:102-103, 505-507, 1454-1455`).
- Persona generation runs **2 `graph.search` calls per entity**: edges with limit 30 and nodes with limit 20, both with reranker `rrf` (`backend/app/services/oasis_profile_generator.py:379-407`, called at `:519`).

### 1.6 Volume per run and Zep free tier

- Pricing evidence: `https://www.getzep.com/pricing`, fetched 2026-11-02. **Re-verify and record in OPEN_ITEMS #6.**
  - Free plan: "10,000 credits a month", no rollover or auto top-up.
  - "Each Episode you send uses credits based on its size": up to 350 bytes costs 1 credit, and each further 350 bytes (or part) costs 1 more.
  - "0 credits for retrieval, storage, threads, users, and graph storage".
  - Free plan has "variable rate limits, depending on service-wide load" and lower-priority episode processing.
  - The first paid plan is Flex at $125/month for 50,000 credits; extra credits cost $25 per 10,000.
- Seed ingestion = 1 episode per chunk (inferred estimates):
  - English 500-char chunk is about 2 credits, so a 4,000-char seed is about 10 episodes and about **20 credits**.
  - Chinese text is 3 bytes per char, so a 500-char chunk costs about 5 credits.
  - It is unknown whether metadata bytes count.
- Call count for seed ingestion:
  - About 6 mutating calls: create, set_ontology, batch.create, `ceil(chunks/350)` × add, process.
  - Plus polling every 3 s and the paging reads, which cost no credits but are subject to rate limits.

---

## 2. Memory during the simulation (`backend/app/services/zep_graph_memory_updater.py`)

### 2.1 Wiring

- The flag is `enable_graph_memory_update` on `POST /api/simulation/start` (`backend/app/api/simulation.py:1554-1560`). The MiroFish UI **always sends `true`** (`frontend/src/components/Step3Simulation.vue:398-403`).
- The target graph is the **same graph as the seed docs**: `project.graph_id` (`simulation.py:1680-1692`). Start is refused while a report holds a reader lease on that graph (`simulation.py:1732-1742`).
- The updater is created and started in `SimulationRunner.start_simulation` (`backend/app/services/simulation_runner.py:441-463`), through `ZepGraphMemoryManager.create_updater` (`zep_graph_memory_updater.py:653-679`). That starts a worker thread (`:295-311`).
- Feed path:
  1. The monitor thread tails `<sim_dir>/{twitter,reddit}/actions.jsonl` **every 2 s** (`simulation_runner.py:641-656`).
  2. Each non-event line goes to `graph_updater.add_activity_from_dict(action_data, platform)` (`simulation_runner.py:853-872`).
  3. The simulation script writes `actions.jsonl` after reading the OASIS SQLite `trace` table. It adds context such as the liked post's text and author, the original post for reposts and quotes, and target user names (`backend/scripts/run_parallel_simulation.py:749-855`).
- Filters: rows with `event_type` and rows with `success == False` are skipped (`zep_graph_memory_updater.py:391-396`), and so is `DO_NOTHING` (`:371-374`).

### 2.2 What is written

- One **text episode per batch**. Each line is `"[{timestamp}] [{platform} round {n}] {agent_name}: {description}"` (`:62-67`).
  - Descriptions are **Chinese templates** per action type, for example `发布了一条帖子：「…」` ("posted: …") or `点赞了{author}的帖子：「…」` ("liked {author}'s post: …").
  - Covered types: CREATE_POST, LIKE_POST and DISLIKE_POST (with the post text), REPOST and QUOTE_POST (original text plus quote), FOLLOW and MUTE (target name), CREATE_COMMENT, LIKE_COMMENT and DISLIKE_COMMENT, SEARCH_POSTS and SEARCH_USER, plus a generic fallback (`:43-204`).
- The call:

```python
self.client.graph.add(graph_id=..., type="text", data=combined_text,
    created_at=RFC3339(last activity timestamp),
    source_description="MiroFish simulation activity batch",
    metadata={"source": "mirofish_simulation", "simulation_id", "platform", "activity_count",
              "first_round", "last_round", "agent_ids", "action_types"})   # :494-517
```

- `zep_cloud:` `graph.add` allows at most 10 metadata keys (`zep_cloud/graph/client.py:321-322`). MiroFish sends 8.

### 2.3 When it is written

- Each platform has its own buffer. When a buffer reaches **`BATCH_SIZE = 5`** activities (`:228, 427-435`), the worker sends it and sleeps 0.5 s (`SEND_INTERVAL`, `:237, 435`). A batch is split if it exceeds 9,500 chars (`MAX_EPISODE_CHARS`, `:241, 444-470`).
- Finalization barrier when the simulation process exits:
  - The monitor sets `STOPPING` and calls `stop_updater` (`simulation_runner.py:710-731`). `stop()` then:
    1. joins the worker,
    2. flushes the tail (fewer than 5 items),
    3. raises if any batch failed,
    4. polls `graph.episode.get` for **every** pending episode every 3 s until `processed` (`zep_graph_memory_updater.py:313-348, 560-621`).
  - All of this shares one 600 s deadline.
  - Only after that does the status become `COMPLETED`. Report generation is blocked while an updater exists (`backend/app/api/report.py:84-117`).
- Failure policy: a failed `graph.add` is never replayed (no idempotency key). It is recorded in `_failed_batches` (`:532-542`), `stop()` raises (`:335-339`), and the run becomes `FAILED` (`simulation_runner.py:727-730`).

### 2.4 What it is not

- **Agents never read Zep during the run.** Only `scripts/validate_zep_cloud_integration.py` mentions Zep; the `run_*_simulation.py` scripts do not.
- Agent "memory" is the CAMEL `ChatAgent` in-context history: `self.memory.get_context()` (OASIS: `oasis/social_agent/agent.py:55-111, 209`).
- Zep memory is therefore write-only during the run and is consumed afterwards by the ReportAgent. This matches the docstring that the graph "remembers" the simulation "for later analysis or AI dialogue" (`simulation.py:1521-1525`).

### 2.5 Volume (inferred)

- Episodes are about `ceil(activities_per_platform / 5)`, plus splits.
- Each activity line is about 150-400 bytes: the Chinese wrapper costs 3 bytes per char, and likes and reposts **duplicate the target post's text**. That averages about 1 credit per activity.
- For 50 agents × 10 rounds × about 1 social action, that is about 500 activities, about 100 episodes, and **about 300-600 credits per run**. The 10,000 free credits would then cover only about 15-30 runs per month. A seed-only run costs about 20 credits.
- The free plan processes episodes at lower priority, while MiroFish allows a 600 s drain. A slow Zep could therefore turn a finished simulation into `FAILED` (risk, inferred).

---

## 3. ReportAgent (`backend/app/services/report_agent.py`, tools in `backend/app/services/zep_tools.py`)

### 3.1 Architecture

- Entry point: `POST /api/report/generate` (`api/report.py:32-319`).
  - It requires the run status `COMPLETED` or `STOPPED` with no active updater (`:84-117`) and a `GRAPH_COMPLETED` project (`:127-131`).
  - It registers a graph reader lease (`:163-243`), then runs a thread with `ReportAgent(graph_id, simulation_id, simulation_requirement).generate_report(progress_callback, report_id)` (`:255-271`).
  - The frontend always passes `force_regenerate: true` (`Step3Simulation.vue:660-663`).
- Phases in `generate_report` (`report_agent.py:1576-1808`):
  1. **Plan** with `plan_outline` (`:1176-1258`): `zep_tools.get_simulation_context(...)` (`:1197-1200`), then **1 `chat_json`** returning `{title, summary, sections:[{title, description}]}`.
     - The prompt asks for 2-5 sections (`:571-575, 589`) but the code does not enforce it (`:1228-1233`).
     - On *any* exception it silently falls back to 3 fixed section titles (`:1247-1258`).
  2. **Sections**, one at a time, with `_generate_section_react` (`:1260-1574`). Each section receives the previous sections, each truncated to 4,000 chars, to avoid repetition (`:1303-1317`). Each section is saved as soon as it is done (`:1716-1730`).
  3. **Assemble** the Markdown: `ReportManager.assemble_full_report` (`:2317-2345`) and `_post_process_report` for heading cleanup (`:2347-2471`).
- **No reflection phase exists in code.** The docstring promises plan, generate, reflect (`:871-879`), and `MAX_REFLECTION_ROUNDS = 3` exists (`:885`), as does `Config.REPORT_AGENT_MAX_REFLECTION_ROUNDS = 2` (`config.py:60`). Neither is read anywhere (grep).
- `Config.REPORT_AGENT_MAX_TOOL_CALLS` and `REPORT_AGENT_TEMPERATURE` (`config.py:59, 61`) are also unused. The values are hard-coded instead.

### 3.2 ReACT loop: text protocol, not native function calling

- In each reply the model must either emit one `<tool_call>{"name": "...", "parameters": {...}}</tool_call>` or start with `Final Answer:` (prompt `:727-742`).
- Parsing (`:1073-1131`): first a regex for the `<tool_call>` tag; failing that, a bare-JSON fallback checked against `VALID_TOOL_NAMES` (`:1071`).
- Rules enforced in code:
  - `max_iterations = 5` (`:1326`).
  - `min_tool_calls = 3`: a Final Answer before 3 tool calls is rejected and the model is re-prompted (`:1415-1430`).
  - `MAX_TOOL_CALLS_PER_SECTION = 5` (`:882, 1447-1458`).
  - Only the first tool call in a reply is executed (`:1460-1463`).
  - If a reply contains both a tool call and a Final Answer, it is re-prompted twice; the third time it is truncated to the first tool call (`:1368-1401`).
  - Fabricated `<tool_result>` blocks are stripped before the reply is appended to history (`_strip_fake_tool_results`, `:1143-1174`; tests in `backend/tests/test_report_tool_result_sanitizer.py`).
  - "Unused tools" hints are added (`:829, 1492-1496`).
  - After 3 or more tools, a reply without the `Final Answer:` prefix is accepted as the answer (`:1532-1544`).
  - A forced final call follows if the loop runs out (`:1546-1574`).
- Observations carry the **full, untruncated tool text** (`REACT_OBSERVATION_TEMPLATE` `:802-812`; `:1498-1510`). The tool result is also logged in full (`:189-210`).
- Dead check: `if response is None` (`:1351, 1557`) can never trigger, because `LLMClient.chat` always returns a `str`.

### 3.3 Tools: names and what each queries

| Tool (LLM-visible) | Implementation | Zep / LLM work |
|---|---|---|
| `insight_forge(query, report_context)` | `ZepToolsService.insight_forge` (`zep_tools.py:943-1088`) | 1 LLM call splits the query into up to 5 sub-queries (`:1090-1141`, temp 0.3). Then `graph.search(scope="edges", limit=15, reranker="cross_encoder")` per sub-query plus a main search with limit 20 (`:994-1019, 486-492`). Then `graph.node.get` for **every** unique source/target UUID in the returned edges (`:1024-1066`), and relationship chains (`:1069-1085`). Text output: `InsightForgeResult.to_text` (`:176-216`). |
| `panorama_search(query, include_expired)` | `zep_tools.py:1143-1233` | Paginates every node and every edge. Splits facts into active vs historical (edges with `expired_at`/`invalid_at`). Sorts by keyword relevance and caps each list at 50. The **node list in the text is not capped** (`:255-286`). |
| `quick_search(query, limit=10)` | `zep_tools.py:1235-1268` | 1 `graph.search` on edges. |
| `interview_agents(interview_topic, max_agents≤10)` | `zep_tools.py:1270-1480` | 2 `chat_json` calls (pick agents, write questions), a batch interview over IPC on both platforms, and 1 `chat` for the summary. See §4. |

- Legacy names are still dispatched if they appear inside `<tool_call>` tags (`report_agent.py:1029-1061`): `search_graph` (mapped to quick_search), `get_graph_statistics`, `get_entity_summary`, `get_simulation_context` (mapped to insight_forge) and `get_entities_by_type`.
- Plan context `get_simulation_context` (`zep_tools.py:888-939`): 1 search on the requirement (limit 30), plus `get_graph_statistics` (all nodes and edges), plus `get_all_nodes` again.
- Errors:
  - Search errors propagate (`zep_tools.py:536-540`). `_execute_tool` turns them into a string, `"工具执行失败: …"` ("tool execution failed"), which goes back to the LLM (`report_agent.py:1066-1068`).
  - `_local_search` (`zep_tools.py:542-644`) is a keyword fallback that is **never called** (dead code).
- **The report never reads local run data.** There is no use of `actions.jsonl`, the OASIS SQLite, or `SimulationRunner.get_timeline` (`simulation_runner.py:1251-1319`). Rounds appear only as text inside episodes ("[twitter round 3]"). The report is therefore not indexed by round.

### 3.4 Prompts (Chinese; `get_language_instruction()` appended)

- Tool descriptions `TOOL_DESC_*`: `report_agent.py:476-548`.
- Plan: `PLAN_SYSTEM_PROMPT` and `PLAN_USER_PROMPT_TEMPLATE` (`:552-611`), formatted at `:1205-1213`. The user prompt carries graph statistics and up to 10 sample facts.
- Section: `SECTION_SYSTEM_PROMPT_TEMPLATE` (`:615-773`) and `SECTION_USER_PROMPT_TEMPLATE` (`:775-798`). They contain:
  - "call tools at least 3 times (max 5)" (`:647`);
  - "quote agents' original words" (`:649-653`);
  - "translate quotes into the report language" (`:655-660`);
  - "faithful to results; don't add info; if insufficient say so" (`:662-666`);
  - "don't fabricate usernames, quotes, statistics; no `<tool_result>` blocks; only cite what appears in tool results" (`:667-671`);
  - "no Markdown headings inside a section" (`:677-709`);
  - the one-tool-or-final protocol (`:727-742`).
- ReACT nudges: `:802-831`. Chat: `CHAT_SYSTEM_PROMPT_TEMPLATE` (`:835-863`).
- Prompts inside tools (`zep_tools.py`): sub-queries `:1102-1118`, interview prefix `:1350-1360`, agent selection `:1578-1601`, questions `:1642-1660`, interview summary `:1697-1718`.
- Locale:
  - `get_language_instruction()` reads `locales/languages.json`; for `en` it returns "Please respond in English."
  - **Outside a Flask request the locale defaults to `'zh'`** unless `set_locale()` was called on that thread (`backend/app/utils/locale.py:23-32, 66-69`).
- **Compliance conflict:** the prompts frame the report as a **"future prediction report" written from a "god's-eye view"**, and they say the simulated agents' behavior *is* a prediction of the future (`report_agent.py:553-569, 625-637`). Tool output headings repeat this (`zep_tools.py:179` "未来预测深度分析" = "future prediction deep analysis"; `:258` "未来全景视图" = "future panorama view"). This contradicts SPEC §2 and §13 ("synthetic crowd reaction", no predictions stated as facts). **Do not copy this framing.**

### 3.5 Model, temperatures, number of calls, output format

- Model: `LLMClient()` defaults to `Config.LLM_MODEL_NAME` (`config.py:28-30`), the same model as everything else. There is no separate report model, but `llm_client` can be injected (`report_agent.py:890-913`).
- Temperatures and limits:

| Call | Settings | Evidence |
|---|---|---|
| plan | 0.3 | `:1221` |
| section | 0.5, `max_tokens=4096` | `:1344-1348, 1550-1554` |
| chat | 0.5 | `:1872-1875, 1914-1917` |
| sub-queries | 0.3 | `zep_tools.py:1126` |
| agent selection | 0.3 | `zep_tools.py:1609` |
| interview questions | 0.5 | `zep_tools.py:1668` |
| interview summary | 0.3, `max_tokens=800` | `zep_tools.py:1726-1727` |

- **LLM calls per report** (inferred arithmetic from the code):
  - Plan: 1 call, plus 1 extra HTTP request only if the provider rejects `response_format`.
  - Each section: 4-6 ReACT calls (3 tool turns plus a final, up to 5 iterations plus a forced final). Add 1 per `insight_forge` and 3 per `interview_agents`. `panorama_search` and `quick_search` add none.
  - With 3-5 sections the total is **about 19-51 calls typically**, with bounds of about 9 and about 106. That excludes interviews of the simulated agents themselves: 2 platforms × up to 10 agents per tool call, made by the simulation process's camel model.
- Token growth (inferred): every iteration re-sends the system prompt (about 6k chars) plus previous sections (up to 4k chars each) plus every untruncated observation. That is tens of thousands of input tokens per section. Nothing is counted (§5).
- Output: **free-form Markdown**: `# title`, `> summary`, then `## section` and body.
  - Files go under `backend/uploads/reports/<report_id>/`: `meta.json` (`Report.to_dict`, `:455-467`), `outline.json`, `progress.json`, `section_NN.md`, `full_report.md`, `agent_log.jsonl`, `console_log.txt` (`ReportManager` `:1931-2003, 2127-2176, 2473-2491`).
  - There are no structured fields: no sentiment, no turning point, no metrics.

### 3.6 Logging

- `agent_log.jsonl` (`ReportLogger`, `:36-305`) writes JSON lines `{timestamp, elapsed_seconds, report_id, action, stage, section_title, section_index, details}`.
  - Actions emitted: `report_start`, `planning_start`, `planning_complete`, `section_start`, `llm_response` (full text), `tool_call` (params), `tool_result` (full text), `section_content`, `section_complete`, `report_complete`, `error` (call sites `:1292-1791`).
  - `log_planning_context` and `log_react_thought` are defined but **never called**.
- `console_log.txt` (`ReportConsoleLogger`, `:307-387`) attaches a FileHandler to the loggers `mirofish.report_agent` and `mirofish.zep_tools`.
- Neither log records **model, token usage, latency or cost**.
- HTTP exposure: `/api/report/<id>/agent-log`, `/console-log`, `/progress` and `/sections` (`api/report.py:686-1049`).

### 3.7 How tightly it depends on Zep, and whether the tool layer can be swapped

- The default constructor calls `ZepToolsService()`, which **raises without `ZEP_API_KEY`** (`zep_tools.py:430-438`). But `zep_tools` can be injected (`report_agent.py:896, 913`) and is used by duck typing. The duck-typed contract the agent calls:

```python
get_simulation_context(graph_id=..., simulation_requirement=...) -> {
    "related_facts": [str], "total_entities": int,
    "graph_statistics": {"total_nodes": int, "total_edges": int, "entity_types": {label: count}}}   # used :1197-1213
insight_forge(graph_id, query, simulation_requirement, report_context) -> obj with .to_text()        # :980-986
panorama_search(graph_id, query, include_expired) -> obj with .to_text()                             # :994-999
quick_search(graph_id, query, limit) -> obj with .to_text()                                          # :1007-1012
interview_agents(simulation_id, interview_requirement, simulation_requirement, max_agents) -> .to_text()  # :1021-1027
# legacy (JSON-serialisable): get_graph_statistics, get_entity_summary, get_entities_by_type          # :1036-1061
```

- Hard-coded parts:
  - the tool registry `_define_tools` (`:925-960`) and the if/elif dispatch `_execute_tool` (`:962-1068`);
  - `VALID_TOOL_NAMES` (`:1071`) and the local `all_tools` set (`:1330`);
  - the section prompt text that names the four tools (`:717-721`) and the `"Final Answer:"` literal.
- Other coupling (inferred impact: CLI use without monkeypatching would write into the vendored tree):
  - `Config.UPLOAD_FOLDER` is used directly by `ReportLogger` (`:52-54`) and `ReportConsoleLogger` (`:323-325`), while `ReportManager.REPORTS_DIR` is computed at import (`:1950`). Both point into `backend/uploads`.
  - Importing `app.services.report_agent` runs `app/__init__.py` (imports Flask and flask_cors, `:12-16`) and `app/services/__init__.py`, which imports simulation_runner, profile generator, IPC and more (`:5-38`).
  - `config.py` runs `load_dotenv(<mirofish>/.env, override=True)` (`:8-14`), so a MiroFish `.env` would override Hyvo env vars.
  - `utils/logger.py` creates `backend/logs/` at import (`:27, 42, 108`).
- **Verdict:** retrieval can be swapped for a local data source with a duck-typed object over `run.json`, with no fork needed. Adding tools, changing prompts (to drop the prediction framing or go English-first) or changing the output format needs a subclass. It would override `_define_tools`, `_execute_tool`, `VALID_TOOL_NAMES`, `plan_outline` and `_generate_section_react` (about 400 lines), which is effectively a fork. The output would still be Markdown, not Hyvo's JSON fields.

### 3.8 Extending with market data (if ReportAgent were reused)

- **Option A: new tools.**
  - `market_timeline(from_round, to_round)`: per-round price, Δ%, reserves, holders, net ETH flow, buy and sell counts.
  - `price_drivers(round)`: largest swaps by price impact, with persona and the stated reason.
  - `posts_by_round(n, persona?)`, `swaps_by_persona(persona)`, and `sentiment_by_round()`.
  - Wiring: add to `_define_tools`, `_execute_tool`, `VALID_TOOL_NAMES`, the `all_tools` hint set, and the section prompt.
- **Option B: precomputed stats in the prompt.** Inject a compact round table and the turning-point candidates into the plan user prompt (override `plan_outline` `:1205-1213`) and the section system prompt (`:1294-1301`).
  - Hack variant: return market facts as strings in `get_simulation_context()["related_facts"]` so they land in the plan prompt (`:1212`). Their label there would be "sample of future facts", which is wrong.
- Recommendation: numbers come from code (Option B), and at most 1-2 evidence tools are added.

---

## 4. Deep interaction

### 4.1 Chat with the ReportAgent

- `POST /api/report/chat` with `{simulation_id, message, chat_history}` (`api/report.py:591-683`) creates a **new ReportAgent per request**, then calls `ReportAgent.chat` (`report_agent.py:1810-1928`).
- Context:
  - The report comes from `ReportManager.get_report_by_simulation`, which returns the **first** matching folder in `os.listdir` order, not necessarily the latest (`:2546-2565`; inferred minor bug, since regenerations create new folders).
  - The Markdown is truncated to 15,000 chars (`:1836-1845`).
  - The last 10 history messages are used (`:1857-1859`); the client also trims to 10 (`frontend/src/components/Step5Interaction.vue:685-692`).
- Loop:
  - At most 2 iterations (`:1869`), at most 1 tool per iteration, `MAX_TOOL_CALLS_PER_CHAT = 2` (`:888, 1893-1902`).
  - Tool results are truncated to **1,500 chars** (`:1900`).
  - A final call is made if the loop is exhausted (`:1913-1917`).
  - That is **1-3 LLM calls per message**, plus the tools' own calls.
  - It returns `{response, tool_calls, sources}` (`:1886-1890, 1924-1928`).
- It is stateless on the server side (the client sends the history).
- `interview_unlocked` becomes true once the report is `COMPLETED` (`api/report.py:826-872`).

### 4.2 Interviewing simulated agents

- Endpoints (`backend/app/api/simulation.py`): `/interview` (`:2304`), `/interview/batch` (`:2433`), `/interview/all` (`:2571`), `/interview/history` (`:2674`), `/env-status` (`:2746`), `/close-env` (`:2811`).
  - The API prepends `INTERVIEW_PROMPT_PREFIX` = "Using your persona and all your past memories and actions, reply to me directly in text without calling any tool:" (`:53-73`).
- Transport: **file-based IPC** in the simulation dir (`backend/app/services/simulation_ipc.py`).
  - The client writes `ipc_commands/<uuid>.json` and polls `ipc_responses/<uuid>.json` every 0.5 s until the timeout (`:117-187`).
  - The environment counts as alive when `env_status.json` contains `{"status":"alive"}` (`:270-285`).
- Simulation side:
  - After the rounds finish, the script stays in **wait-for-commands mode** unless `--no-wait` is passed (`backend/scripts/run_parallel_simulation.py:1516-1535, 1596-1633`). It polls commands every 0.5 s.
  - `SimulationRunner` never passes `--no-wait` (`simulation_runner.py:517-525`).
- Execution chain:
  1. `ManualAction(action_type=ActionType.INTERVIEW, action_args={"prompt": ...})` per agent, then `await env.step(actions)`, per platform and in parallel (`run_parallel_simulation.py:317-343, 416-515`).
  2. OASIS `env.step` routes INTERVIEW to `_perform_interview_action` under the LLM semaphore (OASIS: `oasis/environment/env.py:130-134, 156-193`).
  3. `SocialAgent.perform_interview` builds messages from the persona system message (cut before `# RESPONSE FORMAT`), plus the **CAMEL memory context**, plus the prompt. No tools are passed, so the answer is plain text (OASIS: `oasis/social_agent/agent.py:197-249`).
  4. The answer is recorded in the `trace` table with `action='interview'` and `info={prompt, response, interview_id}` (OASIS: `oasis/social_platform/platform.py:1348-1392`).
  5. MiroFish reads back the latest trace row for each agent (`run_parallel_simulation.py:517-558`).
- Memory: `interview_record=False` by default (OASIS `agent.py:70, 113`), so interviews are not written into the agent's memory. The UI fakes multi-turn chat by prepending the last 6 messages to the prompt with a Chinese wrapper (`Step5Interaction.vue:719-728`).
- Side effects: `env.step` refreshes the recommendation table and increments the Twitter clock (OASIS `env.py:151-153, 196-198`).
- Token usage: camel puts usage into `ModelResponse.usage_dict` (`camel/agents/chat_agent.py:2542-2563`), but `perform_interview` discards it (OASIS `agent.py:226-249`). **Interview tokens are not counted anywhere.**
- The ReportAgent tool `interview_agents` (`zep_tools.py:1270-1480`):
  1. loads profiles from `backend/uploads/simulations/<id>/reddit_profiles.json` or `twitter_profiles.csv` (`:1503-1547`);
  2. has the LLM pick agents for diverse viewpoints (`:1549-1630`) and write 3-5 questions (`:1632-1679`);
  3. sends one batch over IPC to both platforms with `timeout=180.0` (`:1363-1382`);
  4. extracts key quotes with regexes (`:1420-1446`);
  5. has the LLM summarize consensus and disagreement (`:1681-1734`).
- **Conflict (inferred, not executed):**
  - A report requires a terminal `COMPLETED` or `STOPPED` status (`api/report.py:103-117`). That status is only published after the simulation **process exits** (`simulation_runner.py:641, 674-744`); no other code path sets it (grep).
  - The process exits only after leaving wait mode, which writes `env_status "stopped"` (`run_parallel_simulation.py:1632-1633`).
  - So during report generation `check_env_alive()` is false, and `interview_agents` returns a failure summary (`zep_tools.py:1460-1464`). Step-5 interviews likewise need a live environment.
  - If the process is hard-killed (the Windows `taskkill /F` path, `simulation_runner.py:918-946`), `env_status.json` can stay "alive". Each interview command would then wait its full timeout (up to 180 s) before failing.

---

## 5. `llm_client.py` and `openai_chat_compat.py`

- **Token usage is not recorded.** `chat()` returns only text (`backend/app/utils/llm_client.py:131-157`), `chat_json()` returns only the parsed dict (`:159-232`), and nothing in the backend reads `response.usage` (grep).
- JSON mode (`chat_json`):
  - Sends `response_format={"type": "json_object"}` (`:181`).
  - If the provider **explicitly** rejects `response_format` (HTTP 400/422 whose `param` or `message` names `response_format` with an unsupported code or phrase, `:27-64`), it retries once without it, and that retry does not use up a content attempt (`:189-209`).
  - Content attempts default to 1 (`:164`). Ontology generation passes 2. On an `LLMResponseError` it retries with **`max_tokens` removed** (`:211-228`).
- Parsing (`_parse_json_response`, `:234-290`):
  - `finish_reason == "length"` raises; any other non-`stop` reason raises (`:240-251`); empty content raises.
  - It tries strict `json.loads` first. Otherwise `raw_decode` the first object; trailing prose is tolerated, but a second JSON object or array is rejected (`:260-282`).
  - The top level must be an object (`:284-288`).
  - Error messages never echo model output (`backend/tests/test_llm_json_responses.py:134-149`).
- `<think>` handling (`_clean_chat_text`, `:67-74`):
  - `re.sub(r'<think>[\s\S]*?</think>', '', content)`, then strips a BOM and an outer ```` ```json ```` fence plus a trailing ```` ``` ````. This runs for **both** `chat()` and `chat_json()`.
  - An unclosed `<think>` (truncated reasoning) is not removed.
  - Only `message.content` is read (`openai_chat_compat.py:60-101`), so provider-specific reasoning fields are ignored.
- `chat()` ignores `finish_reason`. A report section cut off at `max_tokens=4096` is accepted silently.
- Retries and timeouts:
  - `LLMClient` has no transport retry of its own. `OpenAI(api_key, base_url)` uses SDK defaults (`llm_client.py:107-110`).
  - openai 1.109.1 defaults: `DEFAULT_MAX_RETRIES = 2` and `DEFAULT_TIMEOUT = 600 s` (connect 5 s) (`openai/_constants.py:9-10`). It retries 408, 409, 429 and 5xx (`openai/_base_client.py` around `:752-779`).
  - One logical "call" can therefore be up to 3 HTTP requests.
  - `backend/app/utils/retry.py` (`:15-237`) defines backoff decorators and a client that are **unused** (grep).
- GPT-5 compatibility: if the model starts with `gpt-5`, temperature is omitted and `max_completion_tokens` replaces `max_tokens`. Other providers keep the legacy request shape (`backend/app/utils/openai_chat_compat.py:13-57`; tests in `backend/tests/test_openai_chat_compat.py`).
- The simulation agents do **not** use `LLMClient`. They use camel `ModelFactory` (`run_parallel_simulation.py:984-1040`), and their usage is available in camel responses (`camel/agents/chat_agent.py:1766-1804, 2542-2563`).

### 5.1 Upstream tests in this area (worth porting as patterns)

All under `backend/tests/`, all using fakes (no network).

- `test_llm_json_responses.py`: truncation retry without the token cap (`:49-64`), empty-content retry (`:78-91`), trailing prose accepted (`:94-102`), a second JSON document rejected (`:105-120`), top-level array rejected (`:123-131`), no leak of partial output (`:134-149`), `response_format` fallback only on an explicit rejection (`:152-203`), no retry on unrelated 400/401/429/500 (`:221-243`), missing choices (`:246-259`).
- `test_openai_chat_compat.py`: GPT-5 request shape, the legacy request shape, errors propagated unchanged, content-shape extraction (`:29-123`).
- `test_report_tool_result_sanitizer.py`: nested, unclosed and malformed `<tool_result>` stripping (`:6-28`).
- `test_zep_report_barrier.py`: the report waits for ingestion, no stale cached report, failed ingestion blocks reports after a restart, the reader lease blocks graph start and delete (`:26-297`).
- `test_zep_simulation_barrier.py`: platform completion does not publish success before the barrier (`:58-79`), stop/timeout/retry semantics (`:18-484`).
- `test_zep_graph_memory_updater.py`: tail drain, no network I/O under the lock, episode provenance and size cap, failed writes surfaced, failed actions not ingested, drain deadline (`:50-237`).
- `test_zep_cloud_contracts.py`:
  - query caps, incoming edges, auth and read errors not turned into empty data;
  - the Batch API contract and its reconciliation paths, including terminal states and an opaque zero cursor;
  - the installed-SDK serialization check (`:16-501`).
- Smaller files: `test_zep_retry_and_client.py`, `test_zep_edge_paging.py`, `test_zep_entity_reader_edges.py`, `test_zep_graph_lifecycle.py`, `test_ontology_generator.py`, `test_ontology_attributes.py`, `test_ontology_api_errors.py`.

---

## 6. Recommendation for Hyvo Stage 1 report generation

**Recommendation: build a light Hyvo report agent (`engine/hyvo/report/`) modeled on ReportAgent's patterns. Do not run `ReportAgent` itself in Stage 1.** SPEC §6.7 says "Uses MiroFish's ReportAgent", so this deviation needs sign-off (see open questions).

Why:

1. **Zep:** ReportAgent's retrieval assumes a Zep graph and its default constructor needs `ZEP_API_KEY` (`zep_tools.py:430-438`). Stage 1 has no Zep key, and Hyvo's facts (posts, swaps, reserves) are already local and exact.
2. **Output mismatch:** MiroFish produces free-form Markdown that is not indexed by round (§3.3, §3.5). Hyvo needs fixed JSON fields with numeric arrays that are reproducible from logs and included in the hash.
3. **Cost and budget:** about 19-51 or more LLM calls per report, with growing uncounted context, forced use of at least 3 tools per section (`report_agent.py:647, 1327`), and no budget stop. SPEC §6.6 needs per-call token counting and a clean stop at `maxCostUsd`/`maxLlmCalls`.
4. **Compliance:** the "future prediction report" framing (§3.4) and Chinese-first prompts with a `zh` default locale.
5. **Plumbing:** import side effects (Flask, `.env` override, `logs/` and `uploads/` written into the vendored tree), plus an interview tool that cannot reach a live environment (§4.2).

Proposed pipeline (each LLM call goes through a budget-aware client):

1. **Deterministic stats from `run.json` and logs:**
   - Per round: price, `priceChangePct`, reserves, holders, `netFlowEth` (swap_buy ETH in minus swap_sell ETH out), buy and sell counts, post count, likes, `sentiment`, injected event.
   - Per persona: net flow and actions per round.
   - **`sentimentByRound` is computed by code, not by the LLM.** Cheapest source: a `sentiment` field in each agent's batched decision JSON (zero extra calls). Fallback: a lexicon or one batched classification call per round.
2. **Turning-point candidates in code:** for example, the top 3 rounds scored on |Δprice|, |Δsentiment|, a sign flip in net flow, and injected-event rounds.
3. **Price drivers in code:** the top N swaps by price impact (from reserves before and after each swap), each with agentId, persona, and the stated `reason` from the decision JSON.
4. **One structured LLM call** (report model, `chat_json` semantics, `max_attempts=2`). Inputs: scenario (quoted), round table, candidates, drivers, and at most about 60 selected posts with IDs. Output:
   - `{summary, turningPoint:{round, why, evidencePostIds}, objections:[{text, evidencePostIds}], whatMovedPrice:{text, evidenceRounds}}`
   - Validate: the round must be one of the candidates, cited IDs must exist, and lengths are capped. If validation fails, fall back to a deterministic template.
   - Inferred size: about 5-8k input tokens and about 0.5k output tokens.
5. **Banned-words post-check** on every prose field:
   - On a hit, make one rewrite call for the offending fields, then re-scan.
   - If hits remain, redact the sentence deterministically and add `report.flags += ["policy_redaction"]`.
   - Log every hit.
6. The **disclaimer is set by code** to the exact string "Synthetic crowd reaction. Not a trading signal."; the LLM never writes it.
7. Write `run.json.report` and a `report_log.jsonl` modeled on `agent_log.jsonl`, adding model, tokens, cost and latency per call. All of this happens **before hashing** (SPEC §5.2).
8. **Budget:** reserve a report slice up front (for example 3 calls and a fixed cost cap). A run stopped as `partial` on budget then still gets a report, or a stats-only report if the reserve is gone.

Total: **1-3 report LLM calls**, compared with about 19-51 in MiroFish.

Banned-words guard (proposed). Use word boundaries and ignore case. Descriptive past tense such as "bought" and "sold", the action names `swap_buy`/`swap_sell`, and words like "buyers" or "selling pressure" do not match.

```python
BANNED = {
  "guaranteed":        r"\bguarantee(d|s)?\b",
  "will_pump":         r"\bwill\s+(pump|moon|explode|\d+x)\b",
  "good_token":        r"\bgood\s+token\b",
  "bad_token":         r"\bbad\s+token\b",
  "advice_modal":      r"\b(you|we|traders?|investors?|holders?|users?|everyone|people)\s+(should|must|need\s+to|ought\s+to|have\s+to|might\s+want\s+to)\s+(buy|sell)\b",
  "advice_imperative": r"(^|[.!?:;]\s+|\n\s*[-*]?\s*)(buy|sell)\b",
  "advice_noun":       r"\b(strong\s+|good\s+|great\s+)?(buy|sell)\s+(signal|now|rating|recommendation|opportunity|zone|call)\b",
  "time_to":           r"\btime\s+to\s+(buy|sell)\b",
  # optional, SPEC §2 "never predict a price as fact":
  "price_prediction":  r"\b(price|token|it)\s+will\s+(rise|fall|go\s+up|go\s+down|crash|dump|double|recover)\b",
}
```

Prompt patterns worth copying, translated and stripped of the prediction framing:

- The anti-fabrication rules: use only entities, quotes and numbers present in the data; if the data is insufficient, say so (`report_agent.py:662-671`).
- "Untrusted input as quoted data" fits SPEC §6.5. MiroFish does not do this; add it.
- `LLMClient.chat_json` robustness and its tests (`llm_client.py:27-290`; `backend/tests/test_llm_json_responses.py`), plus the GPT-5 parameter mapping (`openai_chat_compat.py:20-57`). Add usage capture (`response.usage.prompt_tokens/completion_tokens`), a `finish_reason` check in plain chat, an explicit timeout and `max_retries`, and a pre-call budget check.
- The `ReportLogger` JSONL step-log schema (`report_agent.py:36-305`). This directly supports "replayable from logs" (SPEC §5.2).
- Later stages:
  - the bounded chat pattern (`report_agent.py:1810-1928`): at most 2 tool calls, results capped at 1,500 chars, report context capped at 15,000 chars;
  - `_strip_fake_tool_results` and the one-tool-or-final protocol (`:1143-1174, 1368-1458`) if any tool loop is used;
  - the interview answer-format rules (`zep_tools.py:1350-1360`), the diverse agent selection (`:1578-1590`) and the consensus-vs-disagreement summary (`:1697-1711`);
  - InsightForge sub-query decomposition (`:1102-1118`) for Stage 3 retrieval.

Do **not** copy:

- the prediction framing (`report_agent.py:553-569, 625-637`; `zep_tools.py:179, 258`);
- forced tool minimums and uncapped observations;
- silent fallbacks (outline fallback `:1247-1258`, tool errors fed to the LLM as text `:1066-1068`);
- the first-match report lookup (`:2546-2565`);
- the Chinese event templates (`zep_graph_memory_updater.py:69-204`).

If literal reuse of ReportAgent is mandated anyway:

- Inject `llm_client=LLMClient(model=REPORT_MODEL_NAME)` and a duck-typed `zep_tools` adapter over `run.json` (contract in §3.7).
- Call `set_locale('en')` on the worker thread.
- Patch `Config.UPLOAD_FOLDER` and `ReportManager.REPORTS_DIR`.
- Override the plan and section prompts.
- Then add one more LLM call to extract the Hyvo JSON fields from the Markdown, and run the same guard.
- Expect about 20-50 calls per report.

AGPL note (not legal advice): code and prompts adapted from MiroFish are derivative work. SPEC §6.1 already plans to publish modifications.

---

## 7. What the Stage 3 Narrative Engine could reuse

Reuse:

- `utils/zep.py`: client factory, read-only retry policy, query and limit caps (`:21-162`).
- `utils/zep_paging.py`: full node and edge pagination with the `zep-next-cursor` cursor, with cursor-loop detection (`:55-160`).
- `GraphBuilderService` (`graph_builder.py`):
  - `create_graph` with a caller-persisted ID plus reconciliation (`:218-261`);
  - `set_ontology` with the dynamic Pydantic classes (`:313-405`), fed by a **hand-written** Hyvo ontology, for example Token, Narrative, Event, Actor/Wallet, Pool, Source and edges like MENTIONS, LAUNCHED, MOVED, AMPLIFIES, CONTRADICTS;
  - the Batch API ingest with operation-id idempotency, reconciliation and terminal validation (`:407-718`), for daily seed ingestion;
  - `get_graph_data` (`:800-875`).
- `utils/ontology.py` normalizers and the reserved-name guard (`:6-103`).
- The `ZepGraphMemoryUpdater` *pattern* for streaming sources (`zep_graph_memory_updater.py:213-640`): queue, worker, batching, a cap of 9,500 chars per episode, provenance `metadata`, **`created_at` = event time** (`:498`) for temporal facts, no replay of non-idempotent writes, and a deadline-bounded drain. Replace the Chinese `to_episode_text` templates with English renderers for on-chain swaps, launches, casts and news.
- Retrieval for seed packs:
  - `ZepToolsService.search_graph` (`zep_tools.py:457-540`);
  - `panorama_search`'s split of active vs historical facts (`:1143-1233`), which suits a "what changed in the last 24h" view;
  - `insight_forge` decomposition (`:943-1141`);
  - `ZepEntityReader.filter_defined_entities` (`zep_entity_reader.py:221-337`) to list typed entities.

Gaps MiroFish does not cover:

- **No pruning or TTL.** The pinned SDK offers what is needed:
  - `graph.episode.get_by_graph_id(graph_id, lastn=)` (`zep_cloud/graph/episode/client.py:32-71`);
  - `graph.episode.delete(uuid)` (`:145`), `graph.edge.delete` (`zep_cloud/graph/edge/client.py:206`) and `graph.node.delete` (`zep_cloud/graph/node/client.py:274`);
  - `search_filters` with `created_at`, `valid_at`, `invalid_at` and `expired_at` date ranges, `node_labels`, `edge_types` and `episode_metadata_filters` (`zep_cloud/types/search_filters.py:13-77`).
  - Inferred options: (a) one graph per window (for example per day or week), deleting graphs older than N days with `graph.delete`; or (b) one rolling graph, deleting old episodes by UUID and querying with `created_at` filters.
- **Cost.** One episode per source item at 1-2 credits means 500 items per day is about 15k-30k credits per month. That exceeds the free 10k, so Stage 3 likely needs Flex ($125/month) or a self-hosted graph (inferred). MiroFish's client is **Cloud-only** and rejects `ZEP_API_URL` (`utils/zep.py:68-72`), so self-hosting would need a different client. Gate B's fixed-cost ceiling is 50% of $500, which would cover Flex if pricing holds.
- **Ontology generator:** `OntologyGenerator` targets speaking social actors, is in Chinese and capped at 10 types. Do not reuse it for tokens and narratives.
- **Flask coupling:** the lifecycle locks (`backend/app/utils/zep_lifecycle.py`) are process-local and Flask-oriented. A cron worker needs a different coordination mechanism.
