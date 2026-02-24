# @gleanwork/mcp-server-tester — Comprehensive Repo Review

**Date:** 2026-02-24
**Branch reviewed:** `feat/eval-enhancement`
**Scope:** Code quality, test coverage, dead code, architecture, documentation

---

## Executive Summary

The library has a solid foundation: good TypeScript discipline, a well-designed validator/matcher duality, sensible Playwright integration, and clear separation of concerns in most places. The architecture shows real thought.

The most urgent problems are all in **documentation** — multiple code examples in README/api-reference use field names that don't exist anymore (they'll fail at runtime), and the entire LLM host simulation feature (a major value proposition) is essentially invisible to a developer reading the official docs.

After that, the significant issues are: an emerging dual-architecture problem in the LLM host layer, a confirmed bug in the UI reporter types (missing `'size'` expectation), zero test coverage on the LLM adapters and OAuth flow (both security-critical paths), and a large volume of exported API surface that users shouldn't need to touch.

---

## 🔴 P0 — Fix Before Next Release

### 1. README/API reference examples are broken

**Files:** `README.md`, `docs/api-reference.md`

The examples use the old expectation field names from before v0.11.0:

| In docs                     | Actual field            | Broken?          |
| --------------------------- | ----------------------- | ---------------- |
| `expectedSchemaName`        | `expect.schema`         | ✅ broken        |
| `expectedTextContains`      | `expect.containsText`   | ✅ broken        |
| `expectedRegex`             | `expect.matchesPattern` | ✅ broken        |
| `expectedExact`             | `expect.response`       | ✅ broken        |
| `createSchemaExpectation()` | doesn't exist           | ✅ runtime error |

A developer who copy-pastes any eval dataset example from the README will get a runtime error or silent no-op. Fix the field names throughout.

**Effort:** 1 hour

---

### 2. `ExpectationType` diverged in UI — confirmed bug

**Files:** `src/reporters/ui-src/types.ts:23-30`, `src/types/index.ts:30-38`

The UI type copy is missing `'size'`:

```typescript
// src/reporters/ui-src/types.ts — MISSING 'size' and 'toolsTriggered' and 'toolCallCount'
export type ExpectationType =
  | 'exact'
  | 'schema'
  | 'textContains'
  | 'regex'
  | 'snapshot'
  | 'judge'
  | 'error';

// src/types/index.ts — CORRECT (10 types)
export type ExpectationType =
  | 'exact'
  | 'schema'
  | 'textContains'
  | 'regex'
  | 'snapshot'
  | 'judge'
  | 'error'
  | 'size'
  | 'toolsTriggered'
  | 'toolCallCount';
```

The reporter UI will silently ignore size, toolsTriggered, and toolCallCount expectations. This is a bug, not just tech debt.

**Effort:** 15 minutes to fix, then add a build-time check to prevent recurrence.

---

### 3. LLM host simulation is invisible in docs

The entire `simulateLLMHost()` feature — arguably the library's most unique capability — does not appear in:

- `README.md` (feature bullet points)
- `docs/api-reference.md`
- `docs/quickstart.md`

It only exists in `examples/README.md` and the JSDoc. A developer reading the official docs will never discover it.

**What needs to happen:**

- Add "LLM Host Simulation" to README feature list
- Create `docs/llm-host.md` covering: what it is, when to use it, supported providers, env variables, example, cost implications
- Update API reference with `LLMHostConfig`, `LLMHostSimulationResult`, `simulateLLMHost()` signatures

**Effort:** 2.5 hours

---

### 4. New Phase 1-3 features have no documentation at all

The eval enhancement work added:

- `iterations` + `accuracyThreshold` on `EvalCase`
- `accuracy` + `iterationResults` on `EvalCaseResult`
- `concurrency` on `EvalRunnerOptions`
- `toolsTriggered` and `toolCallCount` expectations
- `toHaveToolCalls` and `toHaveToolCallCount` matchers
- `validateToolCalls` and `validateToolCallCount` validators
- Vercel AI SDK support (9 new providers: google, azure, mistral, ollama, deepseek, openrouter, xai)
- Streamable HTTP with SSE fallback

None of these are in any docs file. CLAUDE.md is also not updated.

**Effort:** 2 hours to add to existing docs + CLAUDE.md

---

## 🟠 P1 — Address in Next Sprint

### 5. Dual LLM host architecture is confusing

**Files:** `src/evals/llmHost/adapter.ts`, `src/evals/llmHost/orchestrator.ts`, `src/evals/llmHost/llmHostSimulation.ts`, `src/evals/llmHost/adapters/vercel.ts`

There are now **two incompatible runtime paths**:

- **Old path**: `simulateLLMHost` → `getAdapter()` → `runSimulation()` (adapter/orchestrator pattern)
- **New path**: `simulateLLMHost` → `simulatorRegistry.get()` → `simulator.simulate()` (direct simulation pattern for Vercel providers)

Plus the public API exposes both `LLMAdapter` and `LLMHostSimulator` interfaces, `registerAdapter()` and `getAdapter()`, plus `runSimulation()` from the orchestrator. Users don't know which to use.

The orchestrator also has hard-coded provider logic that violates the adapter pattern:

```typescript
// orchestrator.ts — should NOT know about provider differences
if (adapter.provider === 'anthropic') {
  messages.push({ role: 'user', content: toolResultMessages });
} else {
  for (const msg of toolResultMessages) {
    messages.push(msg);
  }
}
```

**Recommendation:** Decide on one public API (`simulateLLMHost` + the Vercel path), hide or deprecate the low-level adapter primitives, and move provider-specific formatting into each adapter.

**Effort:** Medium refactor (~1 day)

---

### 6. `EvalCaseResult` is defined in two places

**Files:** `src/evals/evalRunner.ts:50-130`, `src/types/reporter.ts:116-220`

The CLAUDE.md says `src/types/reporter.ts` is canonical. But `evalRunner.ts` defines its own `EvalCaseResult` which is the one `runEvalCase()` actually returns. The `src/index.ts` re-exports from `types/reporter.ts`. So the exported type and the runtime type are from different files.

This compounds the UI sync problem — any field added to `evalRunner.ts`'s `EvalCaseResult` must be manually added to `types/reporter.ts` AND `ui-src/types.ts`.

**Fix:** Make `evalRunner.ts` import and extend from `types/reporter.ts`, not define its own.

**Effort:** 1–2 hours

---

### 7. LLM adapters and orchestrator have zero tests

**Files:** `src/evals/llmHost/adapters/openai.ts`, `src/evals/llmHost/adapters/anthropic.ts`, `src/evals/llmHost/orchestrator.ts`, `src/evals/llmHost/retry.ts`

The core LLM simulation logic has **no unit tests whatsoever**:

- `createOpenAIAdapter()` — not tested
- `createAnthropicAdapter()` — not tested
- `runSimulation()` (the agentic loop) — not tested; `llmHostSimulation.test.ts` mocks it entirely
- `withRetry()`, `isRetryableError()` — not tested; retry logic is pure business logic that's easy to unit test

The `llmHostSimulation.test.ts` mocks out `runSimulation` which means the entire actual simulation flow is untested. A bug in `orchestrator.ts` would pass all tests.

**Effort:** 1 day to write meaningful unit tests for adapters + orchestrator

---

### 8. OAuth flow has zero tests

**Files:** `src/auth/oauthFlow.ts`, `src/auth/setupOAuth.ts`, `src/auth/tokenAuth.ts`, `src/auth/oauthClientProvider.ts`

The entire OAuth 2.1 + PKCE implementation is untested. This includes:

- PKCE code verifier/challenge generation
- Authorization URL construction
- Token exchange
- Token storage/retrieval
- Error handling (redirect_uri mismatch, invalid_grant, etc.)

For a security-critical component, this is a significant gap.

**Effort:** 1 day

---

### 9. Too much low-level API surface exposed publicly

**File:** `src/index.ts`

The package exports for advanced users:

```typescript
export {
  registerAdapter,
  getAdapter,
  hasAdapter,
} from './evals/llmHost/index.js';
export { runSimulation } from './evals/llmHost/index.js';
export {
  withRetry,
  isRetryableError,
  type RetryOptions,
} from './evals/llmHost/index.js';
export type { LLMAdapter, LLMChatResult } from './evals/llmHost/index.js';
```

These are infrastructure internals. `registerAdapter`, `runSimulation`, `withRetry` have no use case for the typical user of this library. They bloat the public API and create hidden coupling.

Also: `ExpectedToolCall` and `ToolCallValidationResult` from `llmHostTypes.ts` appear to be used nowhere in the codebase (confirmed by dead code agent).

**Recommendation:** Move internal exports to `@internal` JSDoc or behind a `unstable_*` prefix. Clean up the public surface to: `simulateLLMHost`, `isProviderAvailable`, `getMissingDependencyMessage`, `LLMHostConfig`, `LLMHostSimulationResult`.

**Effort:** 2 hours

---

### 10. Playwright matchers have no dedicated unit tests

**Files:** `src/assertions/matchers/toBeToolError.ts`, `toContainToolText.ts`, `toHaveToolResponseSize.ts`, etc.

The individual matcher files have no tests. Coverage only comes indirectly from integration tests. If a matcher's `message()` function is wrong (wrong error message on failure), no test catches it.

The validator tests in `validators.test.ts` are good. The matchers need their own tests verifying: pass case, fail case, negation (`not.toX()`), and the failure message text.

**Effort:** 0.5 days

---

## 🟡 P2 — Meaningful Improvements

### 11. `response` extraction logic in `evalRunner.ts` is implicit and fragile

**File:** `src/evals/evalRunner.ts:256-263`

```typescript
if (evalCase.expect?.isError !== undefined) {
  return { response: result }; // Full result for error checking
}
return { response: result.structuredContent ?? result.content }; // Partial for everything else
```

This is undocumented branching behavior. The choice of what becomes `response` depends on whether `isError` is in the expect block — which is invisible to the validator functions downstream. This caused actual confusion in E2E tests (structuredContent returned instead of text content).

**Better:** Always return the full result. Let each validator extract what it needs.

**Effort:** Medium — requires updating validators to handle full result

---

### 12. `ProviderKind` type includes deprecated/broken values

**File:** `src/judge/judgeTypes.ts:44`

```typescript
export type ProviderKind = 'claude-agent' | 'openai' | 'custom-http';
```

`openai` and `custom-http` throw at runtime with migration messages in `judgeClient.ts`. The type says they're valid, but using them crashes. Add `@deprecated` JSDoc or remove them from the union and handle with a union + unknown pattern.

**Effort:** 30 minutes

---

### 13. `fire-and-forget` attachment in fixture

**File:** `src/mcp/fixtures/mcpFixture.ts:254-269`

```typescript
testInfo.attach('mcp-server-info', { ... }).catch(() => {
  // Ignore attachment errors for sync methods
});
```

This silently swallows errors from Playwright's reporter attachment. If the reporter is broken, no one knows. Make the method async or document that attachment failures are expected/acceptable.

**Effort:** 30 minutes

---

### 14. `claudeAgentJudge.ts` JSON parsing has no test coverage

**File:** `src/judge/claudeAgentJudge.ts:199-237`

The markdown code block stripping logic (lines 207-216) and regex extraction fallback (line 227) parse LLM JSON responses. Multiple failure modes here, none tested:

- LLM returns markdown-wrapped JSON
- LLM returns malformed JSON
- LLM returns explanatory text before JSON
- Regex extraction finds multiple matches

**Effort:** 0.5 days for robust tests

---

### 15. CLI commands have no tests

**File:** `src/cli/commands/*/index.ts`

The `init`, `login`, `token`, and `generate` CLI commands have no tests. This is less critical than the LLM/auth gaps, but a regression here would only be caught manually.

**Effort:** 1 day

---

### 16. Migration guide exists but is unlinked

**File:** `docs/migration-0.11.md`

The v0.11.0 migration guide for the breaking assertion API change exists but is referenced from nowhere — not README, not CHANGELOG, not api-reference. Developers who upgrade and hit breaking changes have no path to the migration guide.

**Fix:** Add a link in CHANGELOG.md under v0.11.0 and in README under a "Upgrading" section.

**Effort:** 15 minutes

---

### 17. CLAUDE.md matcher list is incomplete

**File:** `CLAUDE.md`

CLAUDE.md documents 3 matchers but the library has 11:

- Documented: `toContainToolText`, `toMatchToolSchema`, `toBeToolError`
- Undocumented: `toMatchToolResponse`, `toMatchToolPattern`, `toMatchToolSnapshot`, `toPassToolJudge`, `toHaveToolResponseSize`, `toSatisfyToolPredicate`, `toHaveToolCalls`, `toHaveToolCallCount`

**Effort:** 45 minutes

---

## 🟢 Things Done Well (preserve these)

1. **Validator/matcher duality** — Pure `ValidationResult`-returning validators decoupled from Playwright matchers. Validators power both inline tests and the eval runner without Playwright dependency. This is the right architecture.

2. **Zod-based configuration** — `MCPConfig` with `z.discriminatedUnion('transport', [...])` is type-safe, validates at the boundary, and derives type guards from the schema. Use this pattern everywhere config is read.

3. **Playwright fixture pattern** — `test('...', async ({ mcp }, testInfo) => {...})` is clean. The auto-attach for reporter, optional `testInfo`, and `test.step()` integration are all well-executed.

4. **Custom reporter architecture** — Collects via Playwright attachments (decoupled from test logic), supports multiple data sources, clean HTML generation. The "copy UI template + inject data" approach is pragmatic.

5. **JSDoc quality in source code** — Function-level JSDoc in `llmHostSimulation.ts`, `mcpConfig.ts`, `mcpFixture.ts` is clear with examples. Good habit to maintain.

6. **`expectations.md`** — Comprehensive, accurate, includes comparison table and sanitizer examples. Best doc in the repo.

7. **`examples/README.md` testing pyramid** — The 4-layer testing model (direct → inline evals → dataset evals → LLM host E2E) is a genuinely good mental model. It belongs in the main README too.

8. **Auth storage and discovery tests** — `src/auth/storage.test.ts` (42 tests) and `src/auth/discovery.test.ts` (14 tests) are thorough.

---

## Summary Table

| #   | Issue                                                                | Severity | Category     | Effort |
| --- | -------------------------------------------------------------------- | -------- | ------------ | ------ |
| 1   | README/API examples use broken field names                           | 🔴 P0    | Docs         | 1h     |
| 2   | UI ExpectationType missing 'size', 'toolsTriggered', 'toolCallCount' | 🔴 P0    | Bug          | 15m    |
| 3   | LLM host simulation invisible in docs                                | 🔴 P0    | Docs         | 2.5h   |
| 4   | New Phase 1-3 features undocumented                                  | 🔴 P0    | Docs         | 2h     |
| 5   | Dual LLM host architecture (adapter vs simulator)                    | 🟠 P1    | Architecture | 1d     |
| 6   | EvalCaseResult defined in two places                                 | 🟠 P1    | Architecture | 2h     |
| 7   | LLM adapters + orchestrator have zero tests                          | 🟠 P1    | Tests        | 1d     |
| 8   | OAuth flow has zero tests                                            | 🟠 P1    | Tests        | 1d     |
| 9   | Too much internal API exposed publicly                               | 🟠 P1    | API          | 2h     |
| 10  | Playwright matchers have no unit tests                               | 🟠 P1    | Tests        | 0.5d   |
| 11  | Response extraction logic is fragile/implicit                        | 🟡 P2    | Code quality | Med    |
| 12  | ProviderKind includes deprecated/breaking values                     | 🟡 P2    | Code quality | 30m    |
| 13  | Fire-and-forget attachment silences errors                           | 🟡 P2    | Code quality | 30m    |
| 14  | Judge JSON parsing untested                                          | 🟡 P2    | Tests        | 0.5d   |
| 15  | CLI commands untested                                                | 🟡 P2    | Tests        | 1d     |
| 16  | Migration guide unlinked                                             | 🟡 P2    | Docs         | 15m    |
| 17  | CLAUDE.md matcher list incomplete                                    | 🟡 P2    | Docs         | 45m    |

**Total P0 effort: ~6 hours**
**Total P1 effort: ~3-4 days**
**Total P2 effort: ~2 days**

---

## Suggested Remediation Order

**Week 1 (P0 — before next release):**

- Fix broken field names in README + api-reference [1h]
- Fix UI type sync bug — add 'size', 'toolsTriggered', 'toolCallCount' to ui-src/types.ts [15m]
- Create `docs/llm-host.md` [2h]
- Document Phase 1-3 features in README, CLAUDE.md, api-reference [2h]
- Link migration guide [15m]
- Complete CLAUDE.md matcher list [45m]

**Week 2 (P1 — test coverage):**

- Unit tests for OpenAI adapter, Anthropic adapter, orchestrator [1d]
- Unit tests for retry logic [0.5d]
- Unit tests for OAuth flow [1d]
- Unit tests for all 11 Playwright matchers [0.5d]

**Week 3 (P1 — architecture):**

- Consolidate `EvalCaseResult` to single canonical source [2h]
- Clean up public API surface (hide internal LLM host primitives) [2h]
- Document or deprecate dual LLM host architecture [discussion needed]

**Week 4 (P2 — cleanup):**

- Fix response extraction ambiguity in evalRunner [med]
- Deprecate broken ProviderKind values properly [30m]
- Fix fire-and-forget attachment [30m]
- Write judge JSON parsing tests [0.5d]
- Write CLI command tests [1d]
