# EvalV2 ↔ mcp-server-tester Feature Matrix

**Date:** 2026-02-25
**Purpose:** Cross-reference Glean's internal EvalV2/RunV2 system (reference implementation) against `@gleanwork/mcp-server-tester` (OSS implementation). Identify gaps, assess parity, and surface the highest-leverage improvements.

**Research method:** Three parallel agents — (1) deep local codebase audit, (2) Glean enterprise knowledge search for EvalV2 architecture, (3) MCP-specific eval requirements documents.

---

## Legend

| Symbol         | Meaning                                               |
| -------------- | ----------------------------------------------------- |
| ✅ **Full**    | Fully supported — semantics and behavior match        |
| 🟡 **Partial** | Feature exists but with meaningful limitations        |
| ❌ **Missing** | Not implemented                                       |
| ⚪ **N/A**     | Not applicable — different deployment model by design |
| 🔵 **Alt**     | Implemented differently but achieves same goal        |

**Priority tiers (for gaps):**

- **P0** — Blocks correctness or severely limits eval quality
- **P1** — High-value, directly improves MCP eval fidelity
- **P2** — Nice-to-have, aspirational EvalV2 parity

---

## Feature Matrix

### A. Dataset / EvalSet Management

| Feature                                  | Glean EvalV2                                                                         | mcp-server-tester                                | Gap                                                                              | Priority |
| ---------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------- | -------- |
| **Dataset format**                       | Protobuf + GCS blobs + SQL tables                                                    | JSON + Zod schemas, file-based                   | 🔵 Alt — JSON is more portable, proto more scalable                              | —        |
| **Schema validation**                    | Proto field types enforce structure                                                  | `EvalDatasetSchema` / `EvalCaseSchema` (Zod)     | ✅ Full — both validate at load time                                             | —        |
| **Dataset versioning**                   | Timestamp-based versions, centralized `EvalSetVersion` table, per-deployment tagging | ❌ No versioning concept                         | ❌ Missing                                                                       | P2       |
| **Dataset loading from file**            | Beam pipelines from GCS                                                              | `loadEvalDataset(filePath)`                      | ✅ Full for file-based                                                           | —        |
| **Programmatic dataset creation**        | SQL upload + API endpoint                                                            | `loadEvalDatasetFromObject(data)`                | ✅ Full                                                                          | —        |
| **Dataset validation on load**           | Proto deserialization                                                                | Zod validation (throws on error)                 | ✅ Full                                                                          | —        |
| **Multiple datasets per run**            | Single evalset per run (but multi-deployment)                                        | Single `EvalDataset` per `runEvalDataset()` call | 🔵 Alt — call `runEvalDataset()` multiple times; same semantic result            | —        |
| **Dataset generation tooling**           | Beam pipelines, oqagen, SQL-based generation, LLM-augmented                          | Interactive CLI (`mcp-server-tester generate`)   | 🟡 Partial — CLI exists but no LLM-assisted or production-query-based generation | P2       |
| **Evalset generation from real queries** | SessionStore beam pipelines extract real production queries                          | ❌ No production query pipeline                  | ❌ Missing (different deployment model; OSS alternative: synthetic TDD)          | ⚪ N/A   |

---

### B. Eval Case Structure

| Feature                               | Glean EvalV2                                                               | mcp-server-tester                                          | Gap                                                                                               | Priority                                                                |
| ------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Case identifier**                   | UUID (`id`)                                                                | `id: string`                                               | ✅ Full                                                                                           | —                                                                       |
| **Human-readable description**        | `name` + `description` on EvalSetEntry                                     | `description?: string`                                     | ✅ Full                                                                                           | —                                                                       |
| **Input query**                       | `query: string` (required)                                                 | `scenario: string` (llm_host) / `toolName + args` (direct) | ✅ Full — different names, same semantics                                                         | —                                                                       |
| **Expected output / canonical**       | `canonical_answer: string`                                                 | `expect.response` (exact match)                            | 🟡 Partial — EvalV2 stores canonical answer as string; mcp-server-tester uses structured response | P1 — add `canonicalAnswer` string field to EvalCase for judge reference |
| **Conversation history (multi-turn)** | `previous_messages[]`, `session_tracking_token`                            | ❌ Single-turn only                                        | ❌ Missing                                                                                        | P1                                                                      |
| **User context**                      | `user_id` for impersonation during execution                               | ❌ Not applicable (OSS, no deployment users)               | ⚪ N/A                                                                                            | —                                                                       |
| **Deployment context**                | `deploymentId` scopes execution to a Glean instance                        | Single MCP server per run                                  | ⚪ N/A                                                                                            | —                                                                       |
| **Arbitrary metadata**                | `metadata: JSON`                                                           | `metadata: Record<string, unknown>`                        | ✅ Full                                                                                           | —                                                                       |
| **Query classification labels**       | `query_classification_results[]` for slicing evals                         | ❌ No classification / tagging system                      | 🟡 Partial — `metadata` can hold tags but no slicing support in runner or UI                      | P2                                                                      |
| **Workflow / agent inputs**           | `workflow_id`, `workflow_inputs` for agent traces                          | ❌ Not applicable                                          | ⚪ N/A                                                                                            | —                                                                       |
| **Eval execution mode**               | Runner type selected at run time (GLEAN_CHAT, AGENTS, NON_EXECUTION, etc.) | `mode: 'direct' \| 'llm_host'` per case                    | 🔵 Alt — per-case mode vs. per-run runner type; mcp-server-tester approach is more flexible       | —                                                                       |

---

### C. Execution / Runner

| Feature                               | Glean EvalV2                                                                      | mcp-server-tester                                    | Gap                                                                  | Priority |
| ------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------- | -------- |
| **Direct tool call execution**        | ❌ Not directly (GLEAN_CHAT runs full chat pipeline)                              | ✅ `mode: 'direct'` — `mcp.callTool(toolName, args)` | 🔵 Alt — mcp-server-tester has more granular tool-level testing      | —        |
| **LLM-driven execution**              | `GLEAN_CHAT` runner routes through full chat pipeline                             | `mode: 'llm_host'` — real LLM via Vercel AI SDK      | ✅ Full — both drive real LLM through tools                          | —        |
| **Non-execution (replay historical)** | `NON_EXECUTION` runner — uses stored historical response                          | ❌ No replay mode                                    | ❌ Missing                                                           | P2       |
| **Concurrency**                       | Cloud Tasks queues, 100s of parallel tasks across deployments                     | `concurrency: N` in `runEvalDataset()`               | ✅ Full for single-machine scale                                     | —        |
| **Multi-iteration accuracy**          | "Judge reps" (N judge runs per entry, median taken) + Eval reps (N eval runs)     | `iterations: N` + `accuracyThreshold: 0–1`           | ✅ Full — conceptually equivalent, different naming                  | —        |
| **Accuracy threshold**                | Implicit (median score > 0.75 threshold per judge config)                         | `accuracyThreshold: number` per case                 | ✅ Full                                                              | —        |
| **Stop on failure**                   | ❌ Not applicable (async, all entries queued)                                     | `stopOnFailure: boolean`                             | 🔵 Alt — mcp-server-tester supports early exit                       | —        |
| **Per-case result callbacks**         | Not exposed                                                                       | `onCaseComplete` callback                            | 🔵 Alt — mcp-server-tester more event-driven                         | —        |
| **Cross-deployment comparison**       | `deploymentIds[]` runs same evalset across multiple deployments, results compared | ❌ Single MCP server per run                         | ❌ Missing (relevant: A/B between servers)                           | P1       |
| **Baseline comparison**               | `baselineEvalId` — compare test eval against reference run                        | ❌ No baseline concept                               | ❌ Missing                                                           | P1       |
| **Retry logic**                       | Cloud Tasks retry with exponential backoff, max retries                           | ❌ No retry on failure                               | ❌ Missing                                                           | P2       |
| **CI/pre-release gating**             | Eval runs gate deployment; Slack alerts on regression                             | ❌ No built-in CI gate                               | 🟡 Partial — Playwright CI runs work; no regression threshold alerts | P2       |
| **Scheduled / automated runs**        | Cron-based daily/weekly regression evals                                          | ❌ Ad-hoc only                                       | ❌ Missing                                                           | P2       |

---

### D. Assertion / Judge Types

| Feature                              | Glean EvalV2                                                                                | mcp-server-tester                                                               | Gap                                                                                                                              | Priority |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **Exact response match**             | Not native (judge-based)                                                                    | `toMatchToolResponse()` / `expect.response`                                     | 🔵 Alt — mcp-server-tester has deterministic exact match                                                                         | —        |
| **Text contains**                    | `STRING_CONTAINS` (heuristic judge)                                                         | `toContainToolText()` / `expect.containsText`                                   | ✅ Full                                                                                                                          | —        |
| **Pattern / regex match**            | Not native                                                                                  | `toMatchToolPattern()` / `expect.matchesPattern`                                | 🔵 Alt — mcp-server-tester has regex; EvalV2 uses LLM instead                                                                    | —        |
| **Schema validation (Zod)**          | Not native                                                                                  | `toMatchToolSchema()` / `expect.schema`                                         | 🔵 Alt — mcp-server-tester has structural validation; EvalV2 relies on judges                                                    | —        |
| **Snapshot testing**                 | Not native                                                                                  | `toMatchToolSnapshot()` with sanitizers                                         | 🔵 Alt — mcp-server-tester unique capability                                                                                     | —        |
| **Error assertion**                  | Not native                                                                                  | `toBeToolError()` / `expect.isError`                                            | 🔵 Alt — mcp-server-tester unique                                                                                                | —        |
| **LLM-as-judge (correctness)**       | `CORRECTNESS` judge (LLM, label A–E)                                                        | `toPassToolJudge()` / `expect.passesJudge`                                      | ✅ Full — both evaluate semantic quality with LLM                                                                                | —        |
| **LLM-as-judge (completeness)**      | `COMPLETENESS` judge (dedicated)                                                            | `passesJudge.rubric` — completeness rubric manually specified                   | 🟡 Partial — mcp-server-tester uses freeform rubric; no named judge type                                                         | P1       |
| **LLM-as-judge (groundedness)**      | `GROUNDEDNESS` judge (dedicated)                                                            | `passesJudge.rubric` — must be manually specified                               | 🟡 Partial — same as above                                                                                                       | P1       |
| **Pairwise comparison judge**        | `PAIRWISE_COMPLETENESS`, `PAIRWISE_COMMENT_ALIGNMENT`, `PAIRWISE_WRITING_PREFERENCE`        | ❌ Not implemented                                                              | ❌ Missing                                                                                                                       | P1       |
| **Heuristic / deterministic judges** | `STRING_CONTAINS`, `SNIPPET_COUNTER`, `LOOP_COUNTER`, `TOOL_PRECISION`, `TOOL_RECALL`, etc. | Validators: text, pattern, size, schema, toolCalls                              | ✅ Full — semantically equivalent via validator architecture                                                                     | —        |
| **Tool precision / recall**          | `TOOL_PRECISION` + `TOOL_RECALL` (heuristic)                                                | `validateToolCalls()` — evaluates required/optional calls with partial matching | 🟡 Partial — mcp-server-tester validates presence/order/exclusivity but no explicit precision/recall metrics computed separately | P1       |
| **Response size**                    | Not native                                                                                  | `toHaveToolResponseSize()` / `expect.responseSize`                              | 🔵 Alt — mcp-server-tester unique                                                                                                | —        |
| **Custom predicate**                 | Not native                                                                                  | `toSatisfyToolPredicate()`                                                      | 🔵 Alt — mcp-server-tester unique                                                                                                | —        |
| **Citation quality judges**          | `CITATIONS_PRECISION`, `CITATIONS_RECALL`                                                   | ❌ Not implemented                                                              | ❌ Missing                                                                                                                       | P2       |
| **Formatting / UX judge**            | `UX_FORMATTING`                                                                             | ❌ Not implemented (achievable via rubric)                                      | 🟡 Partial — `passesJudge.rubric` can cover this                                                                                 | P2       |
| **Multiple named judge types**       | Named judge types (CORRECTNESS, COMPLETENESS, etc.) registered in system                    | ❌ No named judge registry — judge configured inline per case                   | ❌ Missing                                                                                                                       | P1       |
| **Judge configuration registry**     | Global judge configs per deployment                                                         | `judgeConfigs: Record<string, JudgeConfig>` passed to `runEvalDataset()`        | ✅ Full — mcp-server-tester supports named configs                                                                               | —        |
| **Autonomous agent as judge**        | `EVAL_AUTONOMOUS_AGENT` judge type (in design)                                              | ❌ Not implemented                                                              | ❌ Missing                                                                                                                       | P2       |
| **Multiple judge providers**         | GPT-4/5, Claude Opus, Gemini                                                                | Claude only (Anthropic)                                                         | ❌ Missing — only Claude as judge                                                                                                | P1       |

---

### E. Tool Call Tracing (MCP-Specific)

| Feature                           | Glean EvalV2                                                      | mcp-server-tester                                        | Gap                                                                                 | Priority |
| --------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------- |
| **Tool call trace capture**       | `AgentTrace` — full span tree (in GLEAN_CHAT runner output)       | `LLMHostSimulationResult.toolCalls[]`                    | ✅ Full — both capture full call trace                                              | —        |
| **Required tool call assertion**  | `TOOL_RECALL` judge                                               | `toolsTriggered.calls[].required: true`                  | ✅ Full                                                                             | —        |
| **Tool call order assertion**     | Not native (TOOL_RECALL ignores order)                            | `toolsTriggered.order: 'strict' \| 'any'`                | 🔵 Alt — mcp-server-tester has richer ordering semantics                            | —        |
| **Exclusive tool call assertion** | Not native                                                        | `toolsTriggered.exclusive: boolean`                      | 🔵 Alt — mcp-server-tester unique                                                   | —        |
| **Argument partial matching**     | Not native                                                        | `toolsTriggered.calls[].arguments` (partial match)       | 🔵 Alt — mcp-server-tester unique                                                   | —        |
| **Tool call count assertion**     | `LOOP_COUNTER` heuristic judge                                    | `toolCallCount: { min, max, exact }`                     | ✅ Full                                                                             | —        |
| **Tool precision/recall metrics** | `TOOL_PRECISION`, `TOOL_RECALL` — computes separate float metrics | Binary pass/fail only (no precision/recall float output) | 🟡 Partial — EvalV2 outputs actionable metrics; mcp-server-tester outputs pass/fail | P1       |
| **Latency decomposition**         | Not native                                                        | `llmDurationMs` + `mcpDurationMs` per simulation         | 🔵 Alt — mcp-server-tester unique                                                   | —        |

---

### F. Statistical Rigor

| Feature                       | Glean EvalV2                                  | mcp-server-tester                              | Gap                                                                    | Priority |
| ----------------------------- | --------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| **Multi-iteration eval runs** | Eval reps (N independent runs per entry)      | `iterations: N` per case                       | ✅ Full                                                                | —        |
| **Accuracy / win-rate**       | Accuracy = (pass count / N) across reps       | `accuracy = passCount / iterations`            | ✅ Full                                                                | —        |
| **Accuracy threshold gating** | Median score > threshold (0.75 default)       | `accuracyThreshold: number` (0–1, default 1.0) | ✅ Full                                                                | —        |
| **Judge reps**                | N judge runs per entry → median taken         | ❌ Single judge run per case                   | ❌ Missing                                                             | P0       |
| **Hypothesis testing**        | p-value, effect size (r), CIs via Colab       | ❌ Not implemented                             | ❌ Missing                                                             | P1       |
| **Per-query-class slicing**   | Query classification → slice metrics by class | ❌ No label-based slicing in runner or UI      | ❌ Missing                                                             | P2       |
| **Cost tracking**             | Not built into eval infrastructure            | `JudgeResult.usage` (tokens, cost, timing)     | 🔵 Alt — mcp-server-tester has per-case cost tracking                  | —        |
| **Token usage**               | Not built in (tracked in LLM infra)           | `LLMHostSimulationResult.llmDurationMs`        | 🟡 Partial — timing tracked; token counts not surfaced in final report | P2       |

---

### G. Reporting & UI

| Feature                          | Glean EvalV2                                         | mcp-server-tester                             | Gap                                | Priority |
| -------------------------------- | ---------------------------------------------------- | --------------------------------------------- | ---------------------------------- | -------- |
| **HTML dashboard**               | Web app at go/cde (RunV2 tab)                        | React-based HTML reporter                     | ✅ Full — both have interactive UI | —        |
| **Per-case results view**        | Per-entry results with judge scores, explanations    | Per-case results with expectation breakdown   | ✅ Full                            | —        |
| **Historical trend chart**       | Historical runs on same evalset version              | `historyLimit` JSON + trend chart             | ✅ Full                            | —        |
| **Accuracy / iteration display** | Judge rep median, per-rep breakdown                  | Accuracy %, per-iteration breakdown           | ✅ Full                            | —        |
| **Cross-run comparison**         | Select base eval + test eval, diff side-by-side      | ❌ No side-by-side comparison                 | ❌ Missing                         | P1       |
| **Label slicing / filtering**    | Filter by query class, judge score range, datasource | ❌ No filtering in UI                         | ❌ Missing                         | P2       |
| **CSV export**                   | Export results from Analyze tab                      | ❌ JSON only                                  | ❌ Missing                         | P2       |
| **Colab / notebook integration** | Pre-built Colab for hypothesis testing + metrics     | ❌ No notebook integration                    | ❌ Missing                         | P2       |
| **Conformance view**             | ❌ Not applicable                                    | Protocol conformance checks in reporter       | 🔵 Alt — mcp-server-tester unique  | —        |
| **Server capabilities view**     | ❌ Not applicable                                    | `MCPServerCapabilitiesData` shown in reporter | 🔵 Alt — mcp-server-tester unique  | —        |

---

### H. Authentication & Transport

| Feature                 | Glean EvalV2                               | mcp-server-tester                                       | Gap                               | Priority |
| ----------------------- | ------------------------------------------ | ------------------------------------------------------- | --------------------------------- | -------- |
| **OAuth 2.0 / PKCE**    | Internal Glean OAuth for deployment access | `PlaywrightOAuthClientProvider` (full OAuth 2.1 + PKCE) | ✅ Full                           | —        |
| **API token auth**      | Not applicable (internal OAuth)            | Static `accessToken` config                             | ✅ Full                           | —        |
| **Token storage / CLI** | Internal session management                | `~/.mcp/tokens.json` + `login`/`token` commands         | ✅ Full                           | —        |
| **User impersonation**  | `globalActAs` — runs as specific user      | ❌ Not applicable (OSS, no Glean deployment users)      | ⚪ N/A                            | —        |
| **Stdio transport**     | ❌ Not applicable                          | `type: 'stdio'` — local server processes                | 🔵 Alt — mcp-server-tester unique | —        |
| **HTTP transport**      | All servers accessed via HTTP              | `type: 'http'`                                          | ✅ Full                           | —        |

---

### I. EvalSet Generation

| Feature                              | Glean EvalV2                                            | mcp-server-tester                     | Gap                                                                | Priority |
| ------------------------------------ | ------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------ | -------- |
| **Interactive CLI scaffolding**      | ❌ Not applicable                                       | `mcp-server-tester generate` (Ink UI) | 🔵 Alt — mcp-server-tester unique                                  | —        |
| **Real production query extraction** | Beam pipelines from SessionStore                        | ❌ No access to production queries    | ⚪ N/A — OSS lib has no Glean deployment access                    | —        |
| **Synthetic TDD generation**         | oqagen, LLM-augmented variants                          | CLI generator (manual / guided)       | 🟡 Partial — CLI exists but no LLM-assisted generation in the tool | P1       |
| **LLM-assisted case generation**     | LLM generates query variants from real docs             | ❌ Not implemented                    | ❌ Missing                                                         | P1       |
| **Upvote/downvote-based datasets**   | Beam pipeline extracts upvoted/downvoted sessions       | ❌ Not applicable                     | ⚪ N/A                                                             | —        |
| **Query classification tagging**     | Auto-tags entries with `query_classification_results[]` | ❌ Not implemented                    | ❌ Missing                                                         | P2       |

---

### J. Multi-Deployment / A/B Testing

| Feature                         | Glean EvalV2                                          | mcp-server-tester                      | Gap        | Priority |
| ------------------------------- | ----------------------------------------------------- | -------------------------------------- | ---------- | -------- |
| **Multiple deployment targets** | `deploymentIds[]` — run same evalset on N deployments | ❌ Single MCP server per run           | ❌ Missing | P1       |
| **A/B server comparison**       | Cross-deployment metrics, per-deployment results      | ❌ Must run twice and compare manually | ❌ Missing | P1       |
| **Baseline eval reference**     | `baselineEvalId` for pairwise judge comparison        | ❌ No baseline concept                 | ❌ Missing | P1       |
| **Pairwise host comparison**    | PAIRWISE_COMPLETENESS, etc. against base response     | ❌ Not implemented                     | ❌ Missing | P1       |

---

### K. Infrastructure & Operations

| Feature                            | Glean EvalV2                          | mcp-server-tester                           | Gap                                                     | Priority |
| ---------------------------------- | ------------------------------------- | ------------------------------------------- | ------------------------------------------------------- | -------- |
| **Scheduled / automated runs**     | Cron-based daily/weekly AAQM          | ❌ Manual only                              | ❌ Missing                                              | P2       |
| **CI/pre-release regression gate** | Eval runs gate deploy; Slack alerts   | ❌ No built-in gate                         | 🟡 Partial — Playwright CI runs; manual pass/fail       | P2       |
| **Retry with backoff**             | Cloud Tasks retry, max 9 days         | ❌ No retry                                 | ❌ Missing                                              | P2       |
| **Scale (1000s of entries)**       | Cloud Tasks + parallel queues         | `concurrency: N` (limited by local machine) | 🟡 Partial — limited to single-machine scale            | P2       |
| **Eval result storage**            | SQL + GCS (queryable, long-lived)     | JSON files in `.mcp-test-results/`          | 🟡 Partial — file-based; not queryable; ephemeral in CI | P2       |
| **Monitoring / alerting**          | Slack channel alerts, AAQM dashboards | ❌ Not implemented                          | ❌ Missing                                              | P2       |

---

## Gap Summary by Priority

### P0 — Fix Before Serious Eval Use

| Gap            | Description                                                                                                                                                                 | Complexity                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Judge reps** | Single judge run per case introduces noise. EvalV2 runs N judge reps and takes the median. Without this, accuracy measurements are unreliable for non-deterministic judges. | Medium — add `judgeReps: number` to `EvalCase` and loop judge evaluation |

### P1 — High Value, Directly Improves MCP Eval Fidelity

| Gap                                        | Description                                                                                                                                                                                                           | Complexity                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Named judge types**                      | EvalV2 has named judges (CORRECTNESS, COMPLETENESS, GROUNDEDNESS) with consistent semantics. mcp-server-tester uses freeform rubric strings. Standardizing named rubrics improves consistency across teams and evals. | Low — add `BuiltInRubric` enum and pre-written rubric strings             |
| **Canonical answer field**                 | `EvalCase` lacks a top-level `canonicalAnswer: string` field. EvalV2's CORRECTNESS judge uses `canonical_answer` as input. Without it, judge must be given the reference inline in the rubric.                        | Low — add `canonicalAnswer?: string` to `EvalCase`, pass to judge         |
| **Multi-turn conversation history**        | `EvalCase` only supports single-turn interactions. EvalV2 supports `previous_messages[]` for multi-turn sessions. Needed for conversational MCP scenarios.                                                            | High — requires MCP client session management                             |
| **Pairwise comparison**                    | No way to compare two MCP server responses against each other in one eval. EvalV2 has `PAIRWISE_COMPLETENESS` and `PAIRWISE_COMMENT_ALIGNMENT`. Critical for A/B testing Glean MCP vs. native MCP vs. GleanChat.      | High — requires dual-run architecture + pairwise judge                    |
| **A/B server comparison**                  | Running the same eval case against two MCP servers and comparing results. Currently requires two manual runs.                                                                                                         | Medium — add `compareServers` runner mode                                 |
| **Baseline eval reference**                | No concept of a baseline eval run for regression. EvalV2's `baselineEvalId` enables comparing current run against historical baseline.                                                                                | Medium — store results with run ID, add `baselineRunId` to runner options |
| **Tool precision/recall as float metrics** | `toolsTriggered` assertions produce binary pass/fail. EvalV2 computes separate float precision/recall scores per case. Actionable for optimizing tool descriptions.                                                   | Low — add precision/recall float fields to `EvalCaseResult`               |
| **Multiple judge providers**               | Only Claude evaluates. EvalV2 supports GPT-4/5, Gemini, Claude. Different judges have different biases; multi-judge consensus improves reliability.                                                                   | Medium — extend `JudgeConfig.provider` to support OpenAI/Gemini judges    |
| **LLM-assisted eval generation**           | No way to generate eval cases from tool descriptions + example outputs. EvalV2 uses LLM-augmented query generation. Dramatically reduces manual effort for new MCP tools.                                             | Medium — add `generate --assist` flag using Claude to suggest cases       |

### P2 — Aspirational EvalV2 Parity

| Gap                                            | Description                                                                                                                                                 | Complexity                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Dataset versioning**                         | No version tracking for eval datasets. EvalV2 tags versions with timestamps, enables "eval this dataset version" reproducibility.                           | Medium — add `version` field, store with run metadata                      |
| **Query classification / label-based slicing** | No way to tag cases (e.g., "tool-finding", "multi-hop") and slice eval results by tag. EvalV2 slices by `query_classification_results`.                     | Medium — add `tags: string[]` to `EvalCase`, filter in runner and reporter |
| **Hypothesis testing (p-value, effect size)**  | No statistical significance testing. EvalV2 provides p-values and effect sizes via Colab. Critical for making confident "this improved quality" statements. | High — would require external statistical library or Colab integration     |
| **Cross-run comparison UI**                    | UI shows single run. EvalV2 shows base vs. test side-by-side. Needed for regression analysis.                                                               | Medium — add comparison view to React reporter                             |
| **CSV export**                                 | No export from reporter. EvalV2 has CSV export from Analyze tab.                                                                                            | Low — add export button to reporter UI                                     |
| **Scheduled regression evals**                 | No cron-based automation. EvalV2 runs daily AAQM evals automatically.                                                                                       | High — requires CI/CD integration or external scheduler                    |
| **Retry logic**                                | No retry on transient failures. EvalV2 has Cloud Tasks retry with backoff.                                                                                  | Medium — add configurable `maxRetries` to runner                           |
| **Citation quality judges**                    | No built-in citation precision/recall judge. EvalV2 has `CITATIONS_PRECISION`, `CITATIONS_RECALL`.                                                          | Medium — add citation-focused rubric templates                             |
| **Non-execution (replay) mode**                | No way to re-run judges on stored historical responses. EvalV2's `NON_EXECUTION` runner enables fast judge-only runs.                                       | High — requires response storage and replay infrastructure                 |

---

## Features Where mcp-server-tester Exceeds EvalV2

These are capabilities in mcp-server-tester that don't exist in EvalV2. They represent the unique value of a code-first MCP testing framework:

| Feature                              | Value                                                                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deterministic direct mode**        | Call tool with exact args, assert exact response. EvalV2 has no equivalent — it always runs through the full Glean chat pipeline. Critical for unit-testing individual MCP tools. |
| **Tool call order assertion**        | Assert that tools were called in strict order. EvalV2's `TOOL_RECALL` is unordered.                                                                                               |
| **Exclusive tool call assertion**    | Assert no unexpected tool calls. Detects over-eager tool use by LLMs. EvalV2 has no equivalent.                                                                                   |
| **Tool argument partial matching**   | Assert that the LLM's tool arguments include required keys. EvalV2 doesn't validate tool arguments.                                                                               |
| **Snapshot testing with sanitizers** | Regression snapshots with timestamp/UUID scrubbing. No equivalent in EvalV2.                                                                                                      |
| **Error assertion**                  | Assert that a tool returns an error (with optional message matching). No equivalent in EvalV2.                                                                                    |
| **Schema validation (Zod)**          | Structural type checking on tool responses. No equivalent in EvalV2.                                                                                                              |
| **Regex pattern matching**           | Assert response text matches regex pattern. EvalV2 uses LLM judge instead.                                                                                                        |
| **Response size bounds**             | Assert response is within byte limits. No equivalent in EvalV2.                                                                                                                   |
| **Custom predicate**                 | Arbitrary JS function as assertion. No equivalent in EvalV2.                                                                                                                      |
| **Per-case cost tracking**           | Track LLM token cost per eval case. EvalV2 doesn't expose this.                                                                                                                   |
| **Latency decomposition**            | Separate LLM vs. MCP tool execution time per case. No equivalent in EvalV2.                                                                                                       |
| **Stdio transport support**          | Test local MCP servers directly. EvalV2 is HTTP-only.                                                                                                                             |
| **MCP conformance checks**           | Protocol compliance validation (server info, tool schemas, capabilities). No equivalent in EvalV2.                                                                                |
| **Multi-provider LLM host**          | 10 LLM providers for host simulation. EvalV2 uses Glean's internal LLM infrastructure.                                                                                            |

---

## Structural Pattern Differences

| Dimension               | Glean EvalV2                                        | mcp-server-tester                                 |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------- |
| **Execution model**     | Server-side: Cloud Tasks queue, async distributed   | Client-side: Playwright process, in-process async |
| **Storage**             | SQL + GCS (durable, queryable)                      | JSON files (ephemeral, file-based)                |
| **Judge semantics**     | Named judge types with fixed input/output contracts | Freeform rubric strings per case                  |
| **Dataset format**      | Binary protobuf in GCS                              | Plain JSON on disk                                |
| **Entry granularity**   | One evalset entry = one query + deployment context  | One eval case = one tool call or scenario         |
| **Scale**               | Enterprise (1000s of entries, many deployments)     | Local / CI (10s–100s of cases, one MCP server)    |
| **Judge repeatability** | Judge reps (median of N) + eval reps (accuracy)     | Iterations (accuracy) only — single judge run     |
| **Comparison model**    | Cross-deployment, pairwise judges, baseline eval ID | Single-run, no native comparison                  |
| **Scheduling**          | Automated AAQM, cron-based, CI-gated                | Manual only                                       |

---

## Recommendations

### Immediate (P0)

1. **Add `judgeReps` to `EvalCase`** — Run the judge N times per iteration and aggregate (median score, or majority vote on pass/fail). This is the most critical gap: without it, judge-based eval accuracy is noisy and unreliable for production use.

### Near-term (P1)

2. **Add `canonicalAnswer?: string` to `EvalCase`** — Referenced by judge when evaluating correctness. Stop requiring teams to embed the reference inline in rubric strings.

3. **Add named built-in rubrics** — Provide `BuiltInRubric` enum: `'correctness'`, `'completeness'`, `'groundedness'`, `'instruction-following'`. Each maps to a pre-written rubric string, matching EvalV2's named judge convention.

4. **Add tool precision/recall float metrics to `EvalCaseResult`** — Compute and surface `toolPrecision: number` and `toolRecall: number` alongside the binary `pass` for `toolsTriggered` assertions.

5. **Add `tags: string[]` to `EvalCase` + tag-based filtering in runner/reporter** — Enables slicing eval results by query type (e.g., "show me all tool-finding cases"). Low effort, high value for managing growing eval sets.

6. **Add `baselineRunId` concept + cross-run comparison in reporter** — Store run metadata with a stable ID, enable selecting a previous run as baseline. Add a comparison column to reporter UI showing Δ vs. baseline.

### Medium-term (P1)

7. **Multi-server comparison mode** — Run a single dataset against two MCP server configs and compare results case-by-case. This is the OSS equivalent of EvalV2's cross-deployment comparison and essential for Glean MCP vs. native MCP A/B testing.

8. **Multiple judge providers** — Extend judge to support OpenAI (GPT-4o) and Google (Gemini) alongside Claude. Multi-judge consensus reduces provider-specific bias.

9. **LLM-assisted eval generation** — Add `--assist` mode to `mcp-server-tester generate` that uses Claude to suggest eval cases from tool descriptions and example outputs.

### Long-term (P2)

10. **Dataset versioning** — Add `version: string` field, store version with run metadata for reproducible eval history.

11. **Hypothesis testing integration** — Surface effect size and p-value for accuracy comparisons between runs. Could be implemented as a separate CLI analysis command.

12. **Scheduled eval runner** — Document (and possibly provide) a GitHub Actions workflow template for running evals on a schedule.

---

_Report generated 2026-02-25 via parallel agent research (agents: local codebase audit + Glean EvalV2 enterprise search + MCP eval requirements document search)._
