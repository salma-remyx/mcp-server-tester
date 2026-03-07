# Docs Eval Checklist — mcp-server-tester

Generated: 2026-03-07 | Panel: docs-quality-audit-v1 | Mode: Discovery

## How to read this

- P0 = breaks copy-paste code / causes runtime errors; P1 = should fix before 1.0; P2 = nice to have
- Acceptance criteria must be verifiable by reading the named file
- Items are OPEN until acceptance criteria are verifiably met

---

## P0 — Breaks User Workflows

- [ ] **DOC-001** `createLLMJudgeClient` shown as importable in expectations.md — function does not exist, only `createJudge` is exported from `src/index.ts`
  - **File:** `docs/expectations.md:425,429,462,471`
  - **Acceptance:** All four occurrences replaced with `createJudge`; import statement references `createJudge` not `createLLMJudgeClient`
  - **Agents:** accuracy-reviewer, style-reviewer, user-journey-reviewer

- [ ] **DOC-002** `applySanitizers` and `BUILT_IN_PATTERNS` shown as importable from package root — neither is exported from `src/index.ts`
  - **File:** `docs/expectations.md:379-388`
  - **Acceptance:** Import example removed or replaced with note that these are internal; `grep -n "applySanitizers\|BUILT_IN_PATTERNS" src/index.ts` returns no results confirming they are not public
  - **Agents:** accuracy-reviewer, completeness-reviewer, user-journey-reviewer

- [ ] **DOC-003** `authentication.md` "Custom Login Flow" shows 7 internal OAuth functions as importable from package root (`discoverAuthServer`, `generatePKCE`, `generateState`, `buildAuthorizationUrl`, `exchangeCodeForTokens`, `saveOAuthState`, `loadOAuthState`) — none are exported from `src/index.ts`
  - **File:** `docs/authentication.md:269-279` (and surrounding sections)
  - **Acceptance:** Import examples removed or labelled "internal API — not exported"; entire custom login flow section either removed or redesigned around public API only
  - **Agents:** accuracy-reviewer, completeness-reviewer, user-journey-reviewer

- [ ] **DOC-004** `api-reference.md` shows `provider: 'claude'` as valid value for `createJudge` — removed in PR #91/v1.0; actual valid values are `'anthropic' | 'openai' | 'google'`
  - **File:** `docs/api-reference.md:473`
  - **Acceptance:** `'claude'` removed from provider type listing; default shown as `'anthropic'`; `grep "claude" docs/api-reference.md` returns only historical references (e.g., in migration examples), not current API docs
  - **Agents:** accuracy-reviewer, completeness-reviewer, style-reviewer, user-journey-reviewer

- [ ] **DOC-005** README links to `docs/llm-host.md` (two broken links) — file is named `docs/mcp-host.md`
  - **File:** `README.md:122,177`
  - **Acceptance:** Both links updated to `docs/mcp-host.md`; `curl -I` or GitHub preview shows no 404
  - **Agents:** accuracy-reviewer, completeness-reviewer, style-reviewer, user-journey-reviewer

- [ ] **DOC-006** `mcp-host.md` provider table splits providers into "Native adapters" vs "Via Vercel AI SDK" — post-unification (migration PR), all 9 providers use Vercel AI SDK; native adapters were deleted; install instructions are wrong for `anthropic` and `openai`
  - **File:** `docs/mcp-host.md:22-36`
  - **Acceptance:** "Native adapters" category removed; all providers listed uniformly; `anthropic` install shown as `npm install ai @ai-sdk/anthropic`; `openai` install shown as `npm install ai @ai-sdk/openai`
  - **Agents:** accuracy-reviewer, completeness-reviewer

---

## P1 — Should Fix Before 1.0 Release

- [ ] **DOC-007** `clientCredentials` OAuth grant mode completely undocumented — `MCPClientCredentialsConfig` is exported and wired into `MCPAuthConfig`, but zero mention in `docs/authentication.md`
  - **File:** `docs/authentication.md` (missing section)
  - **Acceptance:** authentication.md overview table includes third auth mode "Client Credentials"; dedicated section documents `auth.clientCredentials` config with `clientId`, `clientSecret`, `tokenEndpoint`, `scopes`; env var fallbacks (`MCP_CLIENT_ID`/`MCP_CLIENT_SECRET`) documented
  - **Agents:** completeness-reviewer, user-journey-reviewer

- [ ] **DOC-008** `transports.md` HTTP config options table incomplete — missing `auth`, `proxy`, `tls`, `retryAttempts`, `callTimeoutMs`, `connectTimeoutMs`, `capabilities`
  - **File:** `docs/transports.md:170-179`
  - **Acceptance:** HTTP config options section lists all fields from `HttpMCPConfig` in `src/config/mcpConfig.ts`; `proxy`, `tls`, `retryAttempts` each have at least a one-line description
  - **Agents:** completeness-reviewer, user-journey-reviewer, accuracy-reviewer

- [ ] **DOC-009** `transports.md` stdio config options table missing `cwd` and `quiet`
  - **File:** `docs/transports.md:54-65`
  - **Acceptance:** `cwd?: string` and `quiet?: boolean` added to stdio config options table with descriptions
  - **Agents:** completeness-reviewer, user-journey-reviewer

- [ ] **DOC-010** `ui-reporter.md` primary tab names wrong — doc says "All Results / Eval Datasets / Test Suites", actual UI tabs are "Overview / Tests / Evals"
  - **File:** `docs/ui-reporter.md:10,97-101`
  - **Acceptance:** Tab names in feature bullet (line 10) and Tabs section (lines 97-101) updated to "Overview", "Tests", "Evals" matching `src/reporters/ui-src/App.tsx:86-91`
  - **Agents:** completeness-reviewer, user-journey-reviewer, accuracy-reviewer

- [ ] **DOC-011** `ui-reporter.md` features list contains 9 emojis (lines 9-18) — project style explicitly avoids emojis
  - **File:** `docs/ui-reporter.md:9-18`
  - **Acceptance:** All emoji bullet prefixes removed; plain dash bullets used; `grep -P "[\x{1F300}-\x{1F9FF}]" docs/ui-reporter.md` returns no results
  - **Agents:** style-reviewer

- [ ] **DOC-012** `ui-reporter.md` detail modal lists wrong expectation type names — shows "exact, schema, textContains, regex, snapshot, judge"; actual types differ
  - **File:** `docs/ui-reporter.md:144`
  - **Acceptance:** Expectation type names match the `ExpectationType` union in `src/types/index.ts`
  - **Agents:** user-journey-reviewer

- [ ] **DOC-013** `mcp-host.md` missing `vertex-anthropic` from provider table and `MCPHostConfig` interface listing — 9 providers in source, 8 in docs
  - **File:** `docs/mcp-host.md:22-36,126-141`
  - **Acceptance:** `vertex-anthropic` appears in provider table with correct install command (`npm install ai @ai-sdk/google-vertex`); appears in `MCPHostConfig.provider` type listing
  - **Agents:** completeness-reviewer, user-journey-reviewer, accuracy-reviewer

- [ ] **DOC-014** `mcp-host.md` cost section lists Ollama as "Ollama (local): Free" — Ollama was removed in v1.0 per `migration-1.0.md`
  - **File:** `docs/mcp-host.md:165` (approx)
  - **Acceptance:** Ollama entry removed from cost section; `grep -n "ollama\|Ollama" docs/mcp-host.md` returns no results outside of migration context
  - **Agents:** accuracy-reviewer, completeness-reviewer

- [ ] **DOC-015** `cli.md` generate command output example uses deprecated v0.10.x field names (`expectedTextContains`, `expectedRegex`, `expectedSnapshot`)
  - **File:** `docs/cli.md:137,267-268`
  - **Acceptance:** Output examples updated to use current `expect` block format (`expect.containsText`, `expect.matchesPattern`, `expect.snapshot`)
  - **Agents:** accuracy-reviewer, user-journey-reviewer

- [ ] **DOC-016** Emojis in `cli.md` and `quickstart.md` CLI output examples (📋), and `evals-guide.md` results output (✅ ❌)
  - **File:** `docs/cli.md:173`, `docs/quickstart.md:144`, `docs/evals-guide.md:314-316`
  - **Acceptance:** Emojis replaced with plain text equivalents ("Suggested expectations:", "PASS", "FAIL")
  - **Agents:** style-reviewer

- [ ] **DOC-017** `development.md` has 5+ stale file path references — `src/config/mcpConfigSchema.ts`, `src/evals/expectations/`, `src/evals/evalTypes.ts`, `src/mcp/createClient.ts`, `src/judge/index.ts`, `LLMProviderKind`, `LLMJudgeClient`
  - **File:** `docs/development.md:204,209,318,340-343,351`
  - **Acceptance:** Each stale path updated to actual path: `mcpConfigSchema.ts` → `mcpConfig.ts`; `expectations/` → `assertions/validators/`; `evalTypes.ts` → `datasetTypes.ts`; `createClient.ts` → `clientFactory.ts`; `judge/index.ts` → `judge/judgeClient.ts`; `LLMProviderKind` → `ProviderKind`; `LLMJudgeClient` → `Judge`
  - **Agents:** accuracy-reviewer, completeness-reviewer

- [ ] **DOC-018** `runServerComparison()` exported from `src/index.ts:203` with zero documentation — allows A/B comparison of two MCP server configs
  - **File:** missing (no docs page covers this)
  - **Acceptance:** Either a section in `docs/evals-guide.md` or a standalone doc covers `runServerComparison()` with config example and result structure description
  - **Agents:** completeness-reviewer, user-journey-reviewer

- [ ] **DOC-019** Baseline regression detection (`saveResultsTo`, `baselineResultsFrom`, `saveBaseline()`, `loadBaseline()`) undocumented
  - **File:** missing (no docs page covers this)
  - **Acceptance:** `docs/evals-guide.md` includes a section on baseline comparison workflow covering `saveResultsTo`, `baselineResultsFrom`, and the exported `saveBaseline`/`loadBaseline` functions with example
  - **Agents:** completeness-reviewer, user-journey-reviewer

---

## P2 — Nice to Have

- [ ] **DOC-020** `quickstart.md` table uses "LLM host" display label — should say "MCP host" to match actual mode value `"mcp_host"`
  - **File:** `docs/quickstart.md:12`
  - **Acceptance:** Table cell updated to "MCP host" or "MCP host (`mcp_host`)"
  - **Agents:** user-journey-reviewer, accuracy-reviewer (Medium)

- [ ] **DOC-021** Broken link in `migration-0.11.md:377` — links to `./assertions.md` which does not exist; should be `./expectations.md`
  - **File:** `docs/migration-0.11.md:377`
  - **Acceptance:** Link updated to `./expectations.md` and that file exists
  - **Agents:** style-reviewer, completeness-reviewer

- [ ] **DOC-022** `architecture.md` stale — `ProviderKind` listed as including `'claude'`; factory shown as `createJudgeClient()` not `createJudge()`; UI types described as needing manual sync when they're actually re-exported
  - **File:** `docs/architecture.md:40,72`
  - **Acceptance:** ProviderKind shows `'anthropic' | 'openai' | 'google'`; factory shown as `createJudge()`; UI types section notes they are re-exported, not manually synced
  - **Agents:** accuracy-reviewer, style-reviewer

- [ ] **DOC-023** `migration-0.11.md` "After (v0.11.0)" code block still uses `provider: 'claude'` — should use `'anthropic'`
  - **File:** `docs/migration-0.11.md:237`
  - **Acceptance:** "After" block uses `provider: 'anthropic'`
  - **Agents:** accuracy-reviewer, style-reviewer

- [ ] **DOC-024** No migration note for `llm_host` → `mcp_host` rename from PR #123 — existing users upgrading need to update their dataset JSON files
  - **File:** `docs/migrations/` (missing entry)
  - **Acceptance:** Migration note exists explaining that `"mode": "llm_host"` must be changed to `"mode": "mcp_host"` in dataset JSON files
  - **Agents:** completeness-reviewer

- [ ] **DOC-025** Precision and recall metrics (`toolPrecision`, `toolRecall`) undocumented for `mcp_host` mode — these appear in `EvalCaseResult` and the reporter's ByToolTable
  - **File:** `docs/evals-guide.md` (missing section)
  - **Acceptance:** evals-guide.md explains precision (fraction of called tools that were expected) and recall (fraction of required tools actually called) in the context of `toolsTriggered` expectations
  - **Agents:** completeness-reviewer

- [ ] **DOC-026** `troubleshooting.md` provider install table missing `vertex-anthropic`
  - **File:** `docs/troubleshooting.md:130-139`
  - **Acceptance:** `vertex-anthropic` added to provider install table with correct install command
  - **Agents:** user-journey-reviewer, completeness-reviewer

- [ ] **DOC-027** `ui-reporter.md` CI example uses `actions/checkout@v3`, `actions/setup-node@v3`, `actions/upload-artifact@v3` — current versions are v4
  - **File:** `docs/ui-reporter.md:297-302`
  - **Acceptance:** All three Actions updated to v4
  - **Agents:** user-journey-reviewer

- [ ] **DOC-028** `EvalExpectation` type in `api-reference.md` shows stale factory callback shape `(context, evalCase, response) => Promise<{pass, details}>` from pre-0.11 API
  - **File:** `docs/api-reference.md:644-650`
  - **Acceptance:** `EvalExpectation` type documentation removed or updated to reflect current validator-based architecture
  - **Agents:** accuracy-reviewer

---

## Closed

(none yet — first documentation panel run)
