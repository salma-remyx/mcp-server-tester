# QA Verification Report — 2026-02-24

Worktree: `/Users/steve.calvert/.config/superpowers/worktrees/mcp-server-tester/eval-enhancement`
Reviewer: QA Agent (Claude Code)

---

## Step 1: Quality Check Results

### Unit Tests (`npm test`)

**Result: PASS**

```
Test Files  23 passed (23)
     Tests  561 passed (561)
  Start at  07:49:07
  Duration  978ms
```

All 561 unit tests across 23 test files pass. Newly added test files all pass:

- `src/evals/llmHost/adapters/openai.test.ts` — 35 tests
- `src/evals/llmHost/adapters/anthropic.test.ts` — 41 tests
- `src/evals/llmHost/orchestrator.test.ts` — 26 tests
- `src/evals/llmHost/retry.test.ts` — 45 tests
- `src/assertions/matchers/matcherUnit.test.ts` — 51 tests

### TypeScript (`npm run typecheck`)

**Result: FAIL — 34 errors**

All 34 errors are in newly-created test files. They are all `TS2532: Object is possibly 'undefined'` — array element access (e.g. `arr[0].field`) without nullability guard:

```
src/evals/llmHost/adapters/anthropic.test.ts  — 15 errors (lines 144–435)
src/evals/llmHost/adapters/openai.test.ts     — 14 errors (lines 144–426)
src/evals/llmHost/orchestrator.test.ts        —  5 errors (lines 196–468)
```

These errors did not exist before the remediation work. They were introduced by the new test files.

### Lint (`npm run lint`)

**Result: FAIL — 1 error**

```
/src/evals/llmHost/adapters/openai.test.ts
  173:15  error  This assertion is unnecessary since it does not change the type
                 of the expression  @typescript-eslint/no-unnecessary-type-assertion
```

This is a new file, so this is a regression introduced by the remediation.

### Format Check (`npm run format:check`)

**Result: FAIL — 11 files**

Prettier reports formatting violations in:

```
CLAUDE.md
docs/api-reference.md
docs/llm-host.md
docs/repo-review-2026-02-24.md
README.md
src/assertions/matchers/matcherUnit.test.ts
src/evals/llmHost/adapters/anthropic.test.ts
src/evals/llmHost/adapters/openai.test.ts
src/evals/llmHost/orchestrator.test.ts
src/evals/llmHost/retry.test.ts
src/reporters/ui-src/types.ts
```

The majority of these are newly-created or modified files that were never run through `npm run format` before being committed. This is a blanket failure of the remediation work to follow the established code quality workflow.

### Build (`npm run build`)

**Result: FAIL**

The build fails during the main library `tsup` step. The new `src/evals/llmHost/adapters/vercel.ts` file uses dynamic `import()` calls for optional peer dependencies (`@ai-sdk/google`, `@ai-sdk/mistral`, `@ai-sdk/azure`, `@ai-sdk/ollama`, `@ai-sdk/deepseek`, `@openrouter/ai-sdk-provider`, `@ai-sdk/xai`). These packages are not installed in the project, and they are not listed as `external` in `tsup.config.ts`. The bundler (esbuild) cannot resolve them at build time and fails.

The tsup config has no `external` array entry for the `@ai-sdk/*` optional providers.

Error summary:

```
ERROR: Could not resolve "@ai-sdk/google"   (vercel.ts:37)
ERROR: Could not resolve "@ai-sdk/mistral"  (vercel.ts:44)
ERROR: Could not resolve "@ai-sdk/azure"    (vercel.ts:51)
ERROR: Could not resolve "@ai-sdk/ollama"   (vercel.ts:58)
ERROR: Could not resolve "@ai-sdk/deepseek" (vercel.ts:65)
ERROR: Could not resolve "@openrouter/ai-sdk-provider" (vercel.ts:72)
ERROR: Could not resolve "@ai-sdk/xai"      (vercel.ts:79)
```

This is a **blocking build regression** introduced by the remediation work.

---

## Step 2: Issue-by-Issue Verification

### P0-1: Broken Field Names in README / api-reference

**Verification method:** `grep` for `expectedSchemaName`, `expectedTextContains`, `expectedRegex`, `expectedExact`, `createSchemaExpectation` in both files.

- **README.md**: No matches. No broken field names present.
- **docs/api-reference.md**: `createSchemaExpectation` appears at lines 369 and 385. However, this is as a documented helper function (`### createSchemaExpectation(dataset)`) — it is part of the current API surface, not a stale/broken field name. The original broken field names (`expectedSchemaName`, `expectedTextContains`, `expectedRegex`, `expectedExact`) are entirely absent.

**Status: FIXED** — The original broken field names are gone. The `createSchemaExpectation` appearances are legitimate API documentation.

---

### P0-2: UI ExpectationType Missing 'size', 'toolsTriggered', 'toolCallCount'

**Verification method:** Read `src/reporters/ui-src/types.ts` (line 23–33) and `src/types/index.ts` (line 30–40).

`src/reporters/ui-src/types.ts` `ExpectationType`:

```typescript
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

`src/types/index.ts` `ExpectationType`: identical 10 values.

Both definitions match exactly. All 10 values are present.

**Status: FIXED**

---

### P0-3: LLM Host Simulation Invisible in Docs

**Verification method:** Check `docs/llm-host.md` existence/content; search README features list for explicit LLM host simulation mention.

- `docs/llm-host.md` EXISTS with 180 lines of substantial content covering usage, providers, scenarios, and configuration.
- README features list (lines 51–56) mentions: LLM-as-a-Judge, but does NOT mention LLM host simulation as a distinct feature. The phrase "LLM host simulation" does not appear anywhere in the README. The feature is not linked from the Documentation section (lines 193–199). The `docs/llm-host.md` file is unreachable from any README link.

**Status: PARTIAL** — The `llm-host.md` doc exists and is complete. However, the README still does not mention LLM host simulation in its features list, and `docs/llm-host.md` is not linked from the README's Documentation section. Users reading the README have no path to discover this feature.

---

### P0-4: New Phase 1-3 Features Undocumented

**Verification method:** Grep `CLAUDE.md` and `docs/api-reference.md` for all five terms.

`CLAUDE.md` (lines 105–149) contains a "Multi-Iteration Accuracy" section covering `iterations`, `accuracyThreshold`, and `toolsTriggered`, plus a "Concurrency" section with `concurrency`, and a "Tool Call Assertions" section with `toolsTriggered` and `toolCallCount`.

`docs/api-reference.md` (lines 289, 583–609): `concurrency` in `EvalRunnerOptions`, `iterations` and `accuracyThreshold` in `EvalCase`, `toolsTriggered` and `toolCallCount` in the expect block.

**Status: FIXED**

---

### P1-1: EvalCaseResult Defined in Two Places

**Verification method:** Read `src/evals/evalRunner.ts` (lines 1–44) and `src/types/reporter.ts`.

`evalRunner.ts` imports `EvalCaseResult` and `IterationResult` from `'../types/reporter.js'` (line 7) and re-exports them (line 44). It does not define its own `EvalCaseResult` interface.

`src/types/reporter.ts` (lines 116–200) defines both `IterationResult` and `EvalCaseResult`, with `accuracy?: number` (line 193) and `iterationResults?: Array<IterationResult>` (line 199).

**Status: FIXED** — Single source of truth, properly consolidated.

---

### P1-2: LLM Adapters / Orchestrator / Retry Have Zero Tests

**Verification method:** Check for file existence and inspect `npm test` output.

All four requested test files exist:

- `src/evals/llmHost/adapters/openai.test.ts` — 35 tests, PASS
- `src/evals/llmHost/adapters/anthropic.test.ts` — 41 tests, PASS
- `src/evals/llmHost/orchestrator.test.ts` — 26 tests, PASS
- `src/evals/llmHost/retry.test.ts` — 45 tests, PASS

**Status: FIXED** — Tests exist and pass. Note: these same files introduce TypeScript errors and formatting violations (see Step 3).

---

### P1-3: Playwright Matchers Have No Unit Tests

**Verification method:** Check `src/assertions/matchers/matcherUnit.test.ts` existence and `npm test` output.

`src/assertions/matchers/matcherUnit.test.ts` exists (434 lines) with 51 tests. All pass.

**Status: FIXED**

---

### P1-4: Too Much Internal API Exposed

**Verification method:** Search `src/index.ts` for internal symbols; check for `@internal` JSDoc.

`src/index.ts` line 192–196 exports `simulateLLMHost`, `isProviderAvailable`, `getMissingDependencyMessage`, `createToolCallValidator` from `./evals/llmHost/index.js`. The `llmHost/index.js` re-exports everything from `llmHostSimulation.ts`, which at lines 126–130 re-exports:

```typescript
export { registerAdapter, getAdapter, hasAdapter } from './adapter.js';
export { runSimulation } from './orchestrator.js';
export { withRetry, isRetryableError, type RetryOptions } from './retry.js';
export type { LLMAdapter, LLMChatResult } from './adapter.js';
```

These internal implementation symbols (`registerAdapter`, `getAdapter`, `hasAdapter`, `runSimulation`, `withRetry`, `isRetryableError`, `RetryOptions`, `LLMAdapter`, `LLMChatResult`) are now all public exports of the package through `src/index.ts`. None of them have `@internal` JSDoc in their source files (`adapter.ts`, `orchestrator.ts`, `retry.ts`).

This was the concern raised in the review. The remediation work did not add `@internal` markers and in fact wired these symbols more explicitly into the public API surface via the `llmHost/index.ts` barrel.

**Status: NOT FIXED** — `registerAdapter`, `runSimulation`, `withRetry`, `LLMAdapter`, and related types are publicly exported from the package without `@internal` markers.

---

### P2-1: ProviderKind Deprecated Values

**Verification method:** Read `src/judge/judgeTypes.ts` lines 41–48.

```typescript
/**
 * Valid LLM judge provider kinds.
 *
 * @deprecated 'openai' and 'custom-http' are no longer supported and will
 * throw a runtime error directing you to use 'claude' instead. Use 'claude'
 * (or 'anthropic', which is an alias for 'claude').
 */
export type ProviderKind = 'claude' | 'anthropic' | 'openai' | 'custom-http';
```

The `@deprecated` JSDoc is present on the type, documenting which values are deprecated and why.

**Status: FIXED**

---

### P2-2: Fire-and-Forget Silencing Errors

**Verification method:** Read `src/mcp/fixtures/mcpFixture.ts` lines 267–269.

```typescript
.catch((err) => {
  console.error('[MCPFixture] Failed to attach server info:', err);
});
```

The `.catch(() => {})` silent swallow has been replaced with a logging catch that surfaces the error to `console.error`.

**Status: FIXED**

---

### P2-3: Migration Guide Unlinked

**Verification method:** Grep `CHANGELOG.md` for v0.11.0 and migration link; grep `README.md` for Upgrading section.

`CHANGELOG.md` line 24: `See [Migration Guide (v0.11)](docs/migration-0.11.md) for upgrade instructions.`

`README.md` lines 398–404:

```markdown
## Upgrading

### v0.12.x from v0.11.x

No breaking changes.

### v0.11.x from v0.10.x

The assertion API changed significantly. See the [v0.11 Migration Guide](docs/migration-0.11.md).
```

**Status: FIXED**

---

### P2-4: CLAUDE.md Matcher List Incomplete

**Verification method:** Read `CLAUDE.md` lines 73–85 (the Available Matchers table).

The table lists all 11 matchers:

- `toMatchToolResponse`
- `toContainToolText`
- `toMatchToolPattern`
- `toMatchToolSchema`
- `toMatchToolSnapshot`
- `toBeToolError`
- `toPassToolJudge`
- `toHaveToolResponseSize`
- `toSatisfyToolPredicate`
- `toHaveToolCalls`
- `toHaveToolCallCount`

All 11 are present.

**Status: FIXED**

---

### P2-5: UI EvalCaseResult Missing accuracy/iterationResults

**Verification method:** Read `src/reporters/ui-src/types.ts` lines 85–102.

```typescript
export interface EvalCaseResult {
  // ... other fields ...
  // Multi-iteration accuracy fields
  accuracy?: number;
  iterationResults?: Array<{
    pass: boolean;
    durationMs: number;
    error?: string;
  }>;
}
```

Both `accuracy?` and `iterationResults?` are present.

**Status: FIXED**

---

## Step 3: New Issues Introduced by Remediation

### BLOCKER: Build Fails

`vercel.ts` uses dynamic `import()` for 7 optional peer dependency packages that are not installed. The tsup config does not mark them as `external`. This breaks the entire library build. The package cannot be published or consumed in this state.

**Root cause:** `tsup.config.ts` missing `external: ['@ai-sdk/google', '@ai-sdk/mistral', '@ai-sdk/azure', '@ai-sdk/ollama', '@ai-sdk/deepseek', '@openrouter/ai-sdk-provider', '@ai-sdk/xai']` (or similar) in the library entry config.

### TypeScript: 34 Errors in New Test Files

All in files created during remediation. Pattern: `arr[0].property` accessing arrays returned from mock calls without null guards. The fix in each case is either `arr[0]!.property` (with a justification comment) or a non-null assertion with a prior `expect(arr).toHaveLength(1)` guard.

Files affected:

- `src/evals/llmHost/adapters/anthropic.test.ts` — 15 errors
- `src/evals/llmHost/adapters/openai.test.ts` — 14 errors
- `src/evals/llmHost/orchestrator.test.ts` — 5 errors

### Lint: 1 Error in New Test File

`src/evals/llmHost/adapters/openai.test.ts` line 173: unnecessary type assertion flagged by `@typescript-eslint/no-unnecessary-type-assertion`.

### Format: 11 Files Not Prettier-Formatted

All newly created/modified files were committed without running `npm run format`. Affected: `CLAUDE.md`, `docs/api-reference.md`, `docs/llm-host.md`, `README.md`, four new test files, and `src/reporters/ui-src/types.ts`.

---

## Step 4: Final Assessment

| Issue                                 | Status    | Notes                                                                                                                                                                 |
| ------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 Broken field names               | FIXED     | `expectedSchemaName` etc. absent from README and api-reference                                                                                                        |
| P0-2 UI type sync bug                 | FIXED     | All 10 ExpectationType values present and matching                                                                                                                    |
| P0-3 LLM host in docs                 | PARTIAL   | `docs/llm-host.md` exists (180 lines) but is NOT linked from README features or docs section                                                                          |
| P0-4 New features documented          | FIXED     | `iterations`, `accuracyThreshold`, `concurrency`, `toolsTriggered`, `toolCallCount` all in CLAUDE.md and api-reference.md                                             |
| P1-1 EvalCaseResult consolidated      | FIXED     | Single source in `types/reporter.ts`; evalRunner imports from there                                                                                                   |
| P1-2 Adapter/orchestrator/retry tests | FIXED     | All 4 test files exist; 147 tests total, all pass                                                                                                                     |
| P1-3 Matcher unit tests               | FIXED     | `matcherUnit.test.ts` exists with 51 passing tests                                                                                                                    |
| P1-4 Internal API marked @internal    | NOT FIXED | `registerAdapter`, `runSimulation`, `withRetry`, `LLMAdapter`, `getAdapter`, `hasAdapter`, `isRetryableError`, `RetryOptions` all exported publicly without @internal |
| P2-1 ProviderKind deprecated          | FIXED     | `@deprecated` JSDoc present on `ProviderKind` type                                                                                                                    |
| P2-2 Fire-and-forget fixed            | FIXED     | `.catch((err) => { console.error(...) })` replaces silent swallow                                                                                                     |
| P2-3 Migration guide linked           | FIXED     | CHANGELOG and README both link to migration-0.11.md                                                                                                                   |
| P2-4 CLAUDE.md complete               | FIXED     | All 11 matchers listed in table                                                                                                                                       |
| P2-5 UI accuracy fields               | FIXED     | `accuracy?` and `iterationResults?` present in UI EvalCaseResult                                                                                                      |

### Regressions Introduced

| Regression        | Severity | Description                                                                                          |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| Build broken      | BLOCKER  | `vercel.ts` dynamic imports for 7 optional @ai-sdk/\* packages not marked external in tsup.config.ts |
| TypeScript errors | HIGH     | 34 new TS2532 errors in new test files (openai, anthropic, orchestrator)                             |
| Lint error        | MEDIUM   | 1 unnecessary type assertion in openai.test.ts                                                       |
| Format violations | LOW      | 11 files not run through Prettier before commit                                                      |

### Summary

10 of 13 original issues are fixed. 1 is partially fixed (P0-3). 1 is not fixed (P1-4). The remediation introduced a blocking build regression (vercel.ts + tsup config mismatch) plus 34 TypeScript errors and formatting violations in newly created files.

**The branch is not in a shippable state.** The build failure alone blocks any release. The TypeScript errors also block `npm run typecheck` which is a CI requirement. These must be resolved before the remediation can be considered complete.

### Required Fixes Before Closure

1. **BLOCKER**: Add optional package externals to `tsup.config.ts` for the 7 `@ai-sdk/*` providers used in `vercel.ts`.
2. **HIGH**: Fix 34 `Object is possibly 'undefined'` TypeScript errors in the three new adapter/orchestrator test files.
3. **MEDIUM**: Remove unnecessary type assertion at `openai.test.ts:173`.
4. **LOW**: Run `npm run format` on all modified/new files.
5. **LOW (P1-4)**: Add `@internal` JSDoc to `registerAdapter`, `runSimulation`, `withRetry`, `LLMAdapter`, and related types, or remove them from the public export surface.
6. **LOW (P0-3)**: Add LLM host simulation to the README features list and add a link to `docs/llm-host.md` in the Documentation section.
