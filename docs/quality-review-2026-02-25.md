# Quality Review: @gleanwork/mcp-server-tester

**Date:** 2026-02-25
**Reviewers:** 5-agent swarm (API surface, docs, dead code, DX, architecture)
**Verdict:** Strong foundation — not production-ready at current polish level

---

## Overall Assessment

The library is architecturally sound, internally consistent, and accomplishes something genuinely novel: a statistical eval framework for MCP servers with LLM-in-the-loop testing. The core ideas are right.

The problems are in the last mile: the public API has too many exports, too many of them undocumented, several of them redundant. Docs have concrete broken examples. The DX score is 6.5/10 — a developer who reads the whole repo can be productive, but that's too much to ask. An AI coding agent can probably use this repo correctly, but only because CLAUDE.md is thorough; the user-facing docs wouldn't get them there.

**Ratings:**

| Dimension                       | Score | Notes                                                        |
| ------------------------------- | ----- | ------------------------------------------------------------ |
| Architecture & layer design     | A     | Clean, no violations, single responsibility throughout       |
| Type system soundness           | A−    | One naming drift between UI and backend                      |
| Pattern consistency             | B+    | Validator/matcher duality applied uniformly                  |
| Public API surface              | C+    | 90+ exports, redundancy, fragmentation                       |
| Documentation accuracy          | B     | One broken example, some field name confusion                |
| Documentation completeness      | B−    | Matchers undocumented for users, mental model buried         |
| Developer experience            | C+    | 6.5/10 — config hell, weak error messages, no dataset schema |
| LLM agent usability             | B+    | CLAUDE.md is excellent; user docs alone insufficient         |
| Dead code / duplication         | A−    | Clean except one alias and one unused re-export file         |
| Feature completeness (MCP spec) | C+    | Tools excellent; resources, prompts, notifications absent    |

---

## P0 — Fix Before Any User-Facing Release

### 1. `createExactExpectation` documented but not exported

**File:** `docs/api-reference.md:326`

The API reference shows:

```typescript
const expectations = { exact: createExactExpectation() };
```

This function does not exist in `src/index.ts`. Any developer following the API docs will get an import error. Either export the function or rewrite the example to use the actual `expect.response` field in the dataset JSON format.

---

### 2. `extractText` exported twice under two names

**File:** `src/index.ts`

```typescript
export {
  extractText,
  extractText as extractTextFromResponse, // ← alias of the same function
} from './mcp/response.js';
```

Pick one name and remove the other. This is a minor thing with a disproportionate cost to discoverability.

---

### 3. Error messages don't diagnose the cause

**Files:** `src/evals/evalRunner.ts`, `src/evals/llmHost/llmHostSimulation.ts`

When `simulateLLMHost()` fails, the user sees "LLM host simulation failed" or the raw SDK error string. This can mean: missing `ai` package, missing `@ai-sdk/anthropic`, wrong model name, invalid API key, rate limited, or network blocked. The user has no path to resolution.

Minimum fix: in `vercel.ts` catch blocks, detect common failure patterns and prepend actionable guidance:

```
Error: LLM host simulation failed — API key not found.
Hint: Set ANTHROPIC_API_KEY or check getMissingDependencyMessage('anthropic').
```

---

### 4. Custom Playwright matchers are invisible to users

**Files:** `docs/api-reference.md`, `README.md`

The library exports 11 custom Playwright matchers (`toContainToolText`, `toMatchToolSchema`, `toBeToolError`, etc.). These are documented in CLAUDE.md (the AI agent guide) but appear **nowhere in the user-facing docs**. A developer writing inline Playwright tests will use `expect(result).toContain(...)` — vanilla Playwright — because they don't know the MCP-specific matchers exist.

The fix is a single section in the API reference and a pointer in the README.

---

### 5. Direct vs llm_host mental model buried

**File:** `README.md`

The two testing modes — direct (you call the tool) and llm_host (an LLM calls the tool) — are the foundational concept of the library. They're not explained until page 3 of the evals guide. A developer starting from the README doesn't understand why there are two approaches or when to use each.

Add two sentences and a simple table to the README immediately after "Features":

> **Direct mode**: You call a tool with specific arguments and assert on the output. Deterministic, fast, 1 run.
> **LLM host mode**: A real LLM receives your tools as a natural language prompt and decides which to call. Non-deterministic, needs 10+ iterations, measures tool discoverability.

---

## P1 — Fix Before Wider Adoption

### 6. 90+ public exports with no "primary path" signal

**File:** `src/index.ts`

The main entry point exports ~90 items across: config, auth (28 items), MCP fixtures, assertions, validators, eval runner, LLM host utilities, judge, conformance, reporter types, and iteration results. A developer typing `import { } from '@gleanwork/mcp-server-tester'` sees everything at once.

**Issues:**

- Reporter types (`MCPEvalRunData`, `MCPConformanceResultData`, etc.) belong in `./reporters/mcpReporter`, not the main export
- Auth has 28 exports across 5 subcategories with no grouping signal
- Low-level config internals (`validateMCPConfig`, `isStdioConfig`, `isHttpConfig`) exposed unnecessarily
- `isProviderAvailable`, `getMissingDependencyMessage` are utilities for checking optional dependencies — useful but need better placement

**Target:** Aim for ≤50 exports from the main entry point. Move reporter types to the reporter subpath. Audit auth for what users actually need vs what's internal.

---

### 7. No JSON Schema for eval datasets

**Files:** `data/glean-mcp-evals.json`, docs

Users writing eval datasets in JSON get no IDE autocomplete or validation. A schema file at `schema/eval-dataset.schema.json` would enable autocomplete in VS Code and other editors via `"$schema"` in the dataset JSON. Given how central the dataset format is to the library's value, this is a significant DX gap.

This is a single `zod-to-json-schema` call away.

---

### 8. Zero-to-test requires 7+ undocumented steps

**File:** `docs/quickstart.md`

The actual steps to get a first test running (install, create playwright config, write a test, run) are spread across the README and quickstart. An exact reproduction of "npm install → first passing test" isn't written down as a numbered sequence anywhere. The quickstart shows CLI usage and fixture patterns separately without showing how they connect.

---

### 9. `testInfo` omission causes silent reporter failure

**File:** `src/evals/evalRunner.ts`, `tests/glean-mcp-evals.spec.ts`

When `runEvalDataset` is called without `testInfo`:

```typescript
await runEvalDataset({ dataset }, { mcp }); // missing testInfo
```

The reporter silently receives no data and prints "No MCP eval results found." The user gets a passing test with an empty HTML report. This is confusing and hard to debug.

The fixture should either warn loudly when `testInfo` is missing in an eval context, or the docs should explain that `testInfo` is required for the reporter to work.

---

### 10. `src/auth/index.ts` exists but is never imported

**File:** `src/auth/index.ts`

This file re-exports auth utilities but is imported by nothing. `src/index.ts` imports directly from the source files. Safe to delete.

---

### 11. API type names vs JSON field names are inconsistent in docs

**Files:** `docs/api-reference.md`, `docs/expectations.md`

Some doc sections use the TypeScript type name (`schema`) while others use the old field name (`expectedSchemaName`). This has been fixed in most places but the expectations.md still has a stale reference at line 162. Verify all docs use the current field names (`expect.schema`, `expect.containsText`, `expect.matchesPattern`, etc.).

---

### 12. UI type naming drift: `MCPEvalExpectationResult` vs `EvalExpectationResult`

**Files:** `src/reporters/ui-src/types.ts`, `src/types/reporter.ts`

The backend uses `EvalExpectationResult` for the expectations field type. The UI copy uses `MCPEvalExpectationResult`. Same interface, different name. This won't cause a runtime bug because the data is serialized to JSON, but it will cause confusion when someone tries to sync the types. Standardize on `EvalExpectationResult`.

---

## P2 — Polish

### 13. `getMissingDependencyMessage` is a narrow utility exported prominently

The function that returns "install @ai-sdk/openai" is a useful guard but shouldn't be a primary export. Move to a helper or at least document it as "advanced/debugging only."

### 14. `createMCPFixture` is exported but undocumented

The factory function for creating MCP fixtures without Playwright's `test.extend` pattern is exported from the main entry but appears in zero examples and zero docs. Either document it (it's useful for custom setups) or remove it.

### 15. Conformance checks lack Playwright fixture integration

`runConformanceChecks()` is useful but disconnected — it's not wired into the test framework as a first-class concept. The most common usage pattern (run conformance once in CI) should be a documented pattern, and ideally should also auto-attach to the reporter via the fixture.

### 16. Examples lack individual README files

`examples/filesystem-server/` and `examples/sqlite-server/` each contain a full working example but no README explaining what pattern they demonstrate, how to run them, or what makes each unique.

### 17. LLM host cost warning missing from README

`docs/llm-host.md` mentions API costs but it's not visible from the README. A developer who doesn't read that doc may spin up 10 llm_host cases in CI without realizing each runs 10 LLM calls.

### 18. Judge validator pattern inconsistency

Every assertion type has a `validateX()` function in `src/assertions/validators/` — except judge (`passesJudge`). The judge logic is embedded directly in `evalRunner.ts`. For consistency, a `validateJudge()` function should exist in validators, making the pattern complete and allowing judge assertions outside the eval runner context.

---

## What Is Well-Designed — Preserve These

**Architecture is genuinely clean.** Eight layers (Config → Auth → MCP Connection → Assertions → Eval Pipeline → LLM Host → Judge → Reporter) with zero layer violations. Each module has a single clear responsibility.

**Validator/matcher duality works.** Every assertion has a pure `validateX()` function and a Playwright `toX()` matcher. This enables the same assertion logic in inline tests, eval datasets, and programmatic use. The pattern is applied consistently across all 11 matchers.

**Statistical eval infrastructure.** Multi-iteration accuracy, `defaultLlmIterations`, `accuracyThreshold`, Wilson CI in the reporter — this is the right model for non-deterministic LLM testing. Very few open-source tools do this.

**Type system is sound.** `EvalCaseResult` has a single canonical definition in `src/types/reporter.ts`. No meaningful type drift between layers. TypeScript strict mode throughout.

**LLM host unification.** Routing all 10 providers through a single Vercel AI SDK path was the right architectural move. The previous dual-path (native adapters + Vercel) was actively confusing.

**CLAUDE.md is excellent.** The AI agent guide accurately describes the architecture, patterns, and extension points. An AI coding agent can understand the codebase structure and extend it correctly from CLAUDE.md alone.

**Eval dataset format is well-designed.** JSON-driven, validated with Zod, supports both direct and llm_host modes in the same file, assertions compose naturally.

---

## Capability Gaps (Scope Decisions, Not Bugs)

The library is a **complete implementation of a narrowed scope**: testing MCP server tools and LLM tool discoverability. It cannot test:

| MCP capability                   | Status             |
| -------------------------------- | ------------------ |
| `listTools` / `callTool`         | ✅ Full support    |
| LLM-driven tool triggering       | ✅ Full support    |
| Protocol conformance             | ✅ Basic checks    |
| `listResources` / `readResource` | ❌ Not supported   |
| `listPrompts` / `getPrompt`      | ❌ Not supported   |
| Server-initiated notifications   | ❌ Not supported   |
| Streaming tool responses         | ❌ Not supported   |
| Structured error code validation | ❌ Text-match only |

These gaps should be **explicitly documented** as "Known Limitations" rather than left for users to discover. Whether they belong in scope is a product decision, but the absence should be acknowledged.

---

## Recommended Immediate Actions

In order of impact:

1. **Fix the `createExactExpectation` broken example** — P0, 15 minutes
2. **Add a matchers section to API reference** — P0, 1 hour
3. **Remove the `extractTextFromResponse` alias** — P0, 5 minutes
4. **Add two-sentence mental model to README** — P0, 15 minutes
5. **Improve LLM host error messages with remediation hints** — P0, 2 hours
6. **Generate `schema/eval-dataset.schema.json`** — P1, 2 hours
7. **Move reporter types out of main index.ts** — P1, 1 hour
8. **Delete `src/auth/index.ts`** — P1, 5 minutes
9. **Fix `MCPEvalExpectationResult` → `EvalExpectationResult` in UI types** — P1, 15 minutes
10. **Document `createMCPFixture` or remove it** — P1, 30 minutes
11. **Add Known Limitations section to README** — P2, 30 minutes
12. **Extract judge validator for pattern consistency** — P2, 2 hours

**Total estimated effort for P0:** ~4 hours
**Total estimated effort for P0+P1:** ~12 hours
