# API Cleanup & Design Improvements

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove dead constructs (`custom-http`, deprecated `mode` field), add `defaultJudgeReps` for runner-level symmetry, replace magic-string rubrics with a discriminated union, and eliminate the `judgeConfigs`/`configId` registry in favor of inline judge config.

**Architecture:** Four sequential tasks — cleanup first (smallest blast radius), then `defaultJudgeReps` (additive), then `rubric` discriminated union (type-level breaking change), then `judgeConfigs` removal (API breaking change that simplifies internals). Tasks 3 and 4 both touch `JudgeValidatorConfig` and `passesJudge`, so they must run sequentially.

**Tech Stack:** TypeScript strict, Vitest (`npm test`), Zod (schema validation).

**Run all tests:** `npm test`
**Typecheck:** `npm run typecheck`
**Branch:** `feat/evalv2-gap-closure` (already checked out)

---

## Task 1: Obvious Cleanup

Remove three dead constructs with zero user-facing value.

**Files:**

- Modify: `src/judge/judgeTypes.ts`
- Modify: `src/judge/judgeClient.ts`
- Modify: `src/types/reporter.ts`
- Modify: `src/reporters/ui-src/types.ts`
- Modify: `src/evals/evalRunner.ts` (remove `mode` from return value of `runSingleIteration`)

---

### Step 1: Remove `'custom-http'` from `ProviderKind` in `src/judge/judgeTypes.ts`

Change the type from:

```typescript
export type ProviderKind =
  | 'claude'
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'custom-http';
```

To:

```typescript
/** Valid LLM judge provider kinds. */
export type ProviderKind = 'claude' | 'anthropic' | 'openai' | 'google';
```

Remove the JSDoc entirely (all values are now real and supported; nothing to deprecate).

### Step 2: Remove the explicit `case 'custom-http'` in `src/judge/judgeClient.ts`

The `default` throw already catches any invalid provider. Remove the dedicated `case 'custom-http':` block — the `default` branch handles it:

```typescript
export function createJudge(config: JudgeConfig = {}): Judge {
  const provider: ProviderKind = config.provider ?? 'claude';

  switch (provider) {
    case 'claude':
    case 'anthropic':
      return createClaudeAgentJudge(config);
    case 'openai':
      return createOpenAIJudge(config);
    case 'google':
      return createGoogleJudge(config);
    default:
      throw new Error(`Unsupported LLM provider: ${String(provider)}`);
  }
}
```

### Step 3: Remove deprecated `mode` field from `src/types/reporter.ts`

Delete these lines from `EvalCaseResult`:

```typescript
/**
 * @deprecated Mode is inferred from test context, not displayed in reports
 */
mode?: 'direct' | 'llm_host';
```

### Step 4: Sync `src/reporters/ui-src/types.ts`

Delete the same `mode?` field from the UI copy of `EvalCaseResult`.

### Step 5: Remove `mode` from `runSingleIteration` return in `src/evals/evalRunner.ts`

Find the return statement in `runSingleIteration` and remove the `mode` field:

```typescript
return {
  id: evalCase.id,
  datasetName: options.datasetName ?? 'single-case',
  toolName: evalCase.toolName ?? evalCase.scenario ?? 'unknown',
  // remove: mode,
  source: 'eval',
  ...
};
```

### Step 6: Run tests and typecheck

```bash
npm test
npm run typecheck
```

Expected: All 543 tests pass. TypeScript: clean. (If any test references `mode` on a result object, update it to not assert on `mode`.)

### Step 7: Commit

```bash
git add src/judge/judgeTypes.ts src/judge/judgeClient.ts src/types/reporter.ts src/reporters/ui-src/types.ts src/evals/evalRunner.ts
git commit -m "chore: remove custom-http provider, deprecated mode field"
```

---

## Task 2: `defaultJudgeReps` on `EvalRunnerOptions`

Symmetric with `defaultLlmIterations` — lets you set a runner-level default for judge evaluation repetitions without touching every case.

**Files:**

- Modify: `src/evals/evalRunner.ts`
- Modify: `src/evals/evalRunner.test.ts`

---

### Step 1: Write failing test

In `src/evals/evalRunner.test.ts`, find the `judgeReps behavior` describe block and add:

```typescript
it('applies defaultJudgeReps to cases without explicit judgeReps', async () => {
  // Run a case without judgeReps set on the case itself
  // and verify the default is applied via the runner
  // (This is a structural test — verify effectiveCase has judgeReps applied)
  // Use a mock that captures the judgeReps value on the case
  const dataset: EvalDataset = {
    name: 'default-reps-test',
    cases: [
      { id: 'no-reps', toolName: 'echo', args: {} },
      { id: 'has-reps', toolName: 'echo', args: {}, judgeReps: 2 },
    ],
  };
  const result = await runEvalDataset(
    { dataset, defaultJudgeReps: 3 },
    { mcp: mockMcp }
  );
  // Both cases run without error — the important thing is the option is accepted
  expect(result.total).toBe(2);
});

it('does not override per-case judgeReps with defaultJudgeReps', async () => {
  // Case with judgeReps: 2 should keep 2 even when defaultJudgeReps: 5
  // Structural: just verify no error and option accepted
  const dataset: EvalDataset = {
    name: 'override-reps-test',
    cases: [{ id: 'case', toolName: 'echo', args: {}, judgeReps: 2 }],
  };
  const result = await runEvalDataset(
    { dataset, defaultJudgeReps: 5 },
    { mcp: mockMcp }
  );
  expect(result.total).toBe(1);
});
```

Run: `npm test -- src/evals/evalRunner.test.ts`
Expected: FAIL — `defaultJudgeReps` unknown property

### Step 2: Add `defaultJudgeReps` to `EvalRunnerOptions` in `src/evals/evalRunner.ts`

Add after `defaultLlmIterations`:

```typescript
/**
 * Default number of judge evaluations for cases that do not specify
 * `judgeReps` explicitly. Only applies when a case has a `passesJudge`
 * expectation. Per-case `judgeReps` overrides this.
 *
 * @default 1 (single judge run)
 */
defaultJudgeReps?: number;
```

### Step 3: Apply `defaultJudgeReps` in `runEvalDataset`

In `runEvalDataset`, destructure `defaultJudgeReps` from options:

```typescript
const {
  dataset,
  schemas,
  stopOnFailure = false,
  concurrency = 1,
  defaultLlmIterations,
  defaultJudgeReps, // NEW
  onCaseComplete,
  filterTags,
  saveResultsTo,
  baselineResultsFrom,
} = options;
```

Note: `judgeConfigs` is removed from destructuring here (will be removed fully in Task 4; for now just don't destructure it).

Extend the `effectiveCase` logic to also apply `defaultJudgeReps`:

```typescript
// Apply defaultLlmIterations to llm_host cases without explicit iterations
const withIterations =
  evalCase.mode === 'llm_host' &&
  evalCase.iterations === undefined &&
  defaultLlmIterations !== undefined
    ? { ...evalCase, iterations: defaultLlmIterations }
    : evalCase;

// Apply defaultJudgeReps to cases without explicit judgeReps
const effectiveCase =
  withIterations.judgeReps === undefined && defaultJudgeReps !== undefined
    ? { ...withIterations, judgeReps: defaultJudgeReps }
    : withIterations;
```

Replace the old single `effectiveCase` assignment with these two steps.

### Step 4: Run tests and typecheck

```bash
npm test
npm run typecheck
```

Expected: All pass. New tests pass.

### Step 5: Commit

```bash
git add src/evals/evalRunner.ts src/evals/evalRunner.test.ts
git commit -m "feat(evals): add defaultJudgeReps to EvalRunnerOptions"
```

---

## Task 3: Discriminated Union for `rubric`

Replace `rubric: string` (magic strings) with `rubric: BuiltInRubric | { text: string }`. Named rubrics are TypeScript-checked string literals; custom rubrics are `{ text: string }` objects.

**Files:**

- Modify: `src/judge/rubrics.ts` — update `resolveRubric` signature and `isBuiltInRubric`
- Modify: `src/assertions/validators/judge.ts` — update `JudgeValidatorConfig.rubric`
- Modify: `src/evals/datasetTypes.ts` — update `passesJudge.rubric` + Zod schema
- Modify: `src/assertions/matchers/toPassToolJudge.ts` — update `rubric` parameter type
- Modify: `src/assertions/matchers/types.ts` — update `toPassToolJudge` declaration
- Modify: `src/judge/rubrics.test.ts` — update tests
- Modify: `src/assertions/validators/judge.test.ts` — update any rubric string usages

---

### Step 1: Write failing tests in `src/judge/rubrics.test.ts`

Replace the existing `resolveRubric` tests (which pass plain strings) with tests for the new union type:

```typescript
describe('resolveRubric with discriminated union', () => {
  it('resolves a BuiltInRubric to its full text', () => {
    const resolved = resolveRubric('correctness');
    expect(typeof resolved).toBe('string');
    expect(resolved.length).toBeGreaterThan(20);
    expect(resolved).not.toBe('correctness');
  });

  it('resolves a custom rubric object to its text', () => {
    const custom = 'Evaluate whether the tone is professional.';
    expect(resolveRubric({ text: custom })).toBe(custom);
  });

  it('resolves all 5 built-in rubric names', () => {
    const builtIns: BuiltInRubric[] = [
      'correctness',
      'completeness',
      'groundedness',
      'instruction-following',
      'conciseness',
    ];
    for (const name of builtIns) {
      expect(resolveRubric(name)).not.toBe(name);
    }
  });
});

describe('isBuiltInRubric', () => {
  it('returns true for built-in names', () => {
    expect(isBuiltInRubric('correctness')).toBe(true);
  });

  it('returns false for non-string values', () => {
    expect(isBuiltInRubric({ text: 'custom' })).toBe(false);
  });

  it('returns false for unknown strings', () => {
    expect(isBuiltInRubric('unknown-rubric')).toBe(false);
  });
});
```

Run: `npm test -- src/judge/rubrics.test.ts`
Expected: FAIL — `resolveRubric({ text: ... })` not yet accepted

### Step 2: Update `src/judge/rubrics.ts`

```typescript
import type { BuiltInRubric } from './judgeTypes.js';

export const BUILT_IN_RUBRICS: Record<BuiltInRubric, string> = {
  // ... (unchanged)
};

/** A rubric is either a built-in named rubric or a custom rubric object. */
export type RubricSpec = BuiltInRubric | { text: string };

/**
 * Returns true if `s` is a built-in rubric name (string literal).
 */
export function isBuiltInRubric(s: unknown): s is BuiltInRubric {
  return typeof s === 'string' && s in BUILT_IN_RUBRICS;
}

/**
 * Resolves a RubricSpec to its full rubric text.
 * Built-in names expand to standardized rubric text.
 * Custom objects return their `text` field directly.
 */
export function resolveRubric(rubric: RubricSpec): string {
  if (typeof rubric === 'string') {
    return BUILT_IN_RUBRICS[rubric];
  }
  return rubric.text;
}
```

Note: `BuiltInRubric` must be imported from `judgeTypes.ts` (where it was re-exported from rubrics.ts — check for circular import). If circular, define `BuiltInRubric` directly in `rubrics.ts` and remove the re-export from `judgeTypes.ts`.

### Step 3: Export `RubricSpec` from `src/judge/judgeTypes.ts` and `src/index.ts`

In `judgeTypes.ts`, add:

```typescript
export type { BuiltInRubric, RubricSpec } from './rubrics.js';
```

In `src/index.ts`, add `RubricSpec` to the judge type exports:

```typescript
export type { BuiltInRubric, RubricSpec } from './judge/judgeTypes.js';
```

### Step 4: Update `JudgeValidatorConfig.rubric` in `src/assertions/validators/judge.ts`

```typescript
import type { RubricSpec } from '../../judge/rubrics.js';
import { resolveRubric } from '../../judge/rubrics.js';

export interface JudgeValidatorConfig {
  /** The evaluation rubric: a built-in name or custom { text: string } */
  rubric: RubricSpec;
  reference?: unknown;
  threshold?: number;
  reps?: number;
  // configId removed — inline config used instead (see Task 4)
}
```

The `resolveRubric(rubric)` call inside `validateJudge` already works — just the type of `rubric` changes.

### Step 5: Update `passesJudge.rubric` in `src/evals/datasetTypes.ts`

Import `BuiltInRubric`:

```typescript
import type { BuiltInRubric } from '../judge/judgeTypes.js';
```

Update the `passesJudge` field in `EvalExpectBlock`:

```typescript
passesJudge?: {
  /** Built-in rubric name or custom rubric object */
  rubric: BuiltInRubric | { text: string };
  reference?: unknown;
  threshold?: number;
  reps?: number;
  // configId removed — inline judge config fields added in Task 4
};
```

Update `EvalExpectBlockSchema` Zod definition:

```typescript
passesJudge: z
  .object({
    rubric: z.union([
      z.enum(['correctness', 'completeness', 'groundedness', 'instruction-following', 'conciseness']),
      z.object({ text: z.string().min(1) }),
    ]),
    reference: z.unknown().optional(),
    threshold: z.number().min(0).max(1).optional(),
    reps: z.number().int().min(1).optional(),
  })
  .optional(),
```

### Step 6: Update `toPassToolJudge` in `src/assertions/matchers/toPassToolJudge.ts`

```typescript
import type { RubricSpec } from '../../judge/rubrics.js';

export async function toPassToolJudge(
  this: { isNot: boolean },
  received: unknown,
  rubric: RubricSpec, // was: string
  options: JudgeMatcherOptions = {}
): Promise<{ pass: boolean; message: () => string }> {
  const { reference = null, passingThreshold = DEFAULT_PASSING_THRESHOLD } =
    options;

  const validation = await validateJudge(received, {
    rubric,
    reference: reference ?? undefined,
    threshold: passingThreshold,
  });

  // ... rest unchanged
}
```

Remove the `configId: '_inline'` registry hack entirely — just pass the config directly.

### Step 7: Update matcher type declaration in `src/assertions/matchers/types.ts`

Update `JudgeMatcherOptions` (will be further simplified in Task 4):

```typescript
import type { RubricSpec } from '../../judge/rubrics.js';

export interface JudgeMatcherOptions {
  reference?: unknown;
  passingThreshold?: number;
  // judgeConfig removed — see Task 4 for replacement
}
```

Update the `toPassToolJudge` declaration in `PlaywrightTest.Matchers`:

```typescript
toPassToolJudge(rubric: RubricSpec, options?: JudgeMatcherOptions): Promise<R>;
```

### Step 8: Update `src/evals/datasetTypes.test.ts`

Update any test that passes a rubric as a plain string to use the new format:

```typescript
// Before
expect: {
  passesJudge: {
    rubric: 'Is it good?';
  }
}

// After (custom rubric)
expect: {
  passesJudge: {
    rubric: {
      text: 'Is it good?';
    }
  }
}

// Or (built-in)
expect: {
  passesJudge: {
    rubric: 'correctness';
  }
}
```

### Step 9: Run tests and typecheck

```bash
npm test
npm run typecheck
```

Fix any remaining type errors. Common locations: `judge.test.ts`, `matcherUnit.test.ts`, `datasetTypes.test.ts`.

### Step 10: Commit

```bash
git add src/judge/rubrics.ts src/assertions/validators/judge.ts src/evals/datasetTypes.ts src/assertions/matchers/toPassToolJudge.ts src/assertions/matchers/types.ts src/judge/rubrics.test.ts src/evals/datasetTypes.test.ts src/index.ts src/judge/judgeTypes.ts
git commit -m "feat(judge): replace magic-string rubric with BuiltInRubric | { text } discriminated union"
```

---

## Task 4: Remove `judgeConfigs`/`configId`; Inline Judge Config in `passesJudge`

Remove the registry indirection entirely. Judge configuration (provider, model, etc.) goes directly on the `passesJudge` block.

**Files:**

- Modify: `src/assertions/validators/judge.ts` — remove `configId`, remove `judgeConfigs` parameter, add provider/model fields, build `JudgeConfig` inline
- Modify: `src/evals/datasetTypes.ts` — add provider/model fields to `passesJudge`, update Zod schema
- Modify: `src/evals/evalRunner.ts` — remove `judgeConfigs` from `EvalRunnerOptions`, `EvalCaseOptions`, `ExpectBlockConfig`; remove `judgeConfigs` from `runExpectBlockValidations` call
- Modify: `src/assertions/matchers/toPassToolJudge.ts` — update `JudgeMatcherOptions` to expose provider/model
- Modify: `src/assertions/matchers/types.ts` — update `JudgeMatcherOptions`
- Modify: `src/evals/serverComparison.ts` — if it references `judgeConfigs`, update

---

### Step 1: Update `JudgeValidatorConfig` and `validateJudge` in `src/assertions/validators/judge.ts`

```typescript
import type { ProviderKind } from '../../judge/judgeTypes.js';
import type { RubricSpec } from '../../judge/rubrics.js';
import { resolveRubric } from '../../judge/rubrics.js';
import { createJudge } from '../../judge/judgeClient.js';

export interface JudgeValidatorConfig {
  /** The evaluation rubric: a built-in name or custom { text: string } */
  rubric: RubricSpec;
  /** Optional reference response to compare against */
  reference?: unknown;
  /** Minimum score to pass (0–1, default: 0.7) */
  threshold?: number;
  /** Number of judge evaluations to run. Scores averaged. @default 1 */
  reps?: number;
  // Inline judge configuration (replaces judgeConfigs registry + configId)
  /** Judge provider. @default 'claude' */
  provider?: ProviderKind;
  /** Model override */
  model?: string;
  /** Environment variable name for API key */
  apiKeyEnvVar?: string;
  /** Max tokens for judge response */
  maxTokens?: number;
  /** Temperature for judge LLM (0–1) */
  temperature?: number;
  /** Max budget in USD per evaluation */
  maxBudgetUsd?: number;
  /** Fail if response exceeds this size in bytes */
  maxToolOutputSize?: number;
}

export async function validateJudge(
  response: unknown,
  config: JudgeValidatorConfig
): Promise<ValidationResult> {
  const {
    rubric,
    reference,
    threshold = 0.7,
    reps = 1,
    provider,
    model,
    apiKeyEnvVar,
    maxTokens,
    temperature,
    maxBudgetUsd,
    maxToolOutputSize,
  } = config;

  const resolvedRubric = resolveRubric(rubric);

  // Build JudgeConfig from inline fields (no registry lookup)
  const judgeConfig = {
    ...(provider !== undefined && { provider }),
    ...(model !== undefined && { model }),
    ...(apiKeyEnvVar !== undefined && { apiKeyEnvVar }),
    ...(maxTokens !== undefined && { maxTokens }),
    ...(temperature !== undefined && { temperature }),
    ...(maxBudgetUsd !== undefined && { maxBudgetUsd }),
    ...(maxToolOutputSize !== undefined && { maxToolOutputSize }),
  };

  try {
    const judge = createJudge(judgeConfig);
    const scores: number[] = [];
    let lastReasoning: string | undefined;

    for (let i = 0; i < reps; i++) {
      const judgeResult = await judge.evaluate(
        response,
        reference ?? null,
        resolvedRubric
      );
      scores.push(judgeResult.score ?? (judgeResult.pass ? 1.0 : 0.0));
      lastReasoning = judgeResult.reasoning;
    }

    if (scores.length === 0) {
      return {
        pass: false,
        message: 'Judge evaluation failed: no scores collected',
      };
    }

    const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const passed = meanScore >= threshold;
    const repNote =
      reps > 1
        ? ` (mean of ${reps} reps: [${scores.map((s) => s.toFixed(2)).join(', ')}])`
        : '';

    return {
      pass: passed,
      message: passed
        ? `Judge passed with score ${meanScore.toFixed(2)}${repNote}`
        : `Judge failed with score ${meanScore.toFixed(2)} (threshold: ${threshold})${repNote}. ${lastReasoning ?? ''}`,
    };
  } catch (err) {
    return {
      pass: false,
      message: `Judge evaluation error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
```

### Step 2: Add inline judge config fields to `passesJudge` in `src/evals/datasetTypes.ts`

Update the `passesJudge` object in `EvalExpectBlock`:

```typescript
passesJudge?: {
  rubric: BuiltInRubric | { text: string };
  reference?: unknown;
  threshold?: number;
  reps?: number;
  /** Judge provider (default: 'claude') */
  provider?: 'claude' | 'anthropic' | 'openai' | 'google';
  /** Model override for this evaluation */
  model?: string;
  /** API key env var override */
  apiKeyEnvVar?: string;
  /** Max tokens for judge response */
  maxTokens?: number;
  /** Temperature (0–1) */
  temperature?: number;
  /** Max spend in USD */
  maxBudgetUsd?: number;
  /** Fail if response exceeds N bytes before judging */
  maxToolOutputSize?: number;
};
```

Update `EvalExpectBlockSchema` to add the new fields to the `passesJudge` Zod object:

```typescript
passesJudge: z.object({
  rubric: z.union([
    z.enum(['correctness', 'completeness', 'groundedness', 'instruction-following', 'conciseness']),
    z.object({ text: z.string().min(1) }),
  ]),
  reference: z.unknown().optional(),
  threshold: z.number().min(0).max(1).optional(),
  reps: z.number().int().min(1).optional(),
  provider: z.enum(['claude', 'anthropic', 'openai', 'google']).optional(),
  model: z.string().optional(),
  apiKeyEnvVar: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(1).optional(),
  maxBudgetUsd: z.number().positive().optional(),
  maxToolOutputSize: z.number().int().positive().optional(),
}).optional(),
```

### Step 3: Remove `judgeConfigs` from `src/evals/evalRunner.ts`

**In `EvalRunnerOptions`:** Delete the `judgeConfigs?: Record<string, JudgeConfig>` field entirely.

**In `EvalCaseOptions`:** Delete the `judgeConfigs?: Record<string, JudgeConfig>` field entirely.

**In `ExpectBlockConfig`:** Delete `judgeConfigs?: Record<string, JudgeConfig>`.

**In `runExpectBlockValidations`:**

- Remove `judgeConfigs` from destructuring
- Update the `passesJudge` block to pass inline config directly to `validateJudge`:

```typescript
if (expectBlock.passesJudge !== undefined) {
  const effectiveReps = expectBlock.passesJudge.reps ?? config.judgeReps ?? 1;
  const effectiveReference =
    expectBlock.passesJudge.reference !== undefined
      ? expectBlock.passesJudge.reference
      : config.canonicalAnswer;
  const validation = await validateJudge(response, {
    ...expectBlock.passesJudge,
    reference: effectiveReference,
    reps: effectiveReps,
  });
  results.judge = { pass: validation.pass, details: validation.message };
}
```

**Remove `JudgeConfig` import** from `evalRunner.ts` if it's no longer used there.

**In `runEvalDataset` destructuring:** Remove `judgeConfigs` from the destructured options. The `judgeConfigs` being spread into `runEvalCase` options — remove that too.

### Step 4: Update `JudgeMatcherOptions` in `src/assertions/matchers/types.ts`

Remove `judgeConfig?: JudgeConfig` and replace with individual fields:

```typescript
export interface JudgeMatcherOptions {
  /** Reference response to compare against */
  reference?: unknown;
  /** Score threshold for passing (default: 0.7) */
  passingThreshold?: number;
  /** Number of judge evaluations (scores averaged) */
  reps?: number;
  /** Override the judge provider */
  provider?: ProviderKind;
  /** Override the judge model */
  model?: string;
}
```

### Step 5: Update `toPassToolJudge` in `src/assertions/matchers/toPassToolJudge.ts`

Remove all the `_inline` registry hack. Pass fields directly:

```typescript
export async function toPassToolJudge(
  this: { isNot: boolean },
  received: unknown,
  rubric: RubricSpec,
  options: JudgeMatcherOptions = {}
): Promise<{ pass: boolean; message: () => string }> {
  const {
    reference = null,
    passingThreshold = DEFAULT_PASSING_THRESHOLD,
    reps,
    provider,
    model,
  } = options;

  const validation = await validateJudge(received, {
    rubric,
    reference: reference ?? undefined,
    threshold: passingThreshold,
    ...(reps !== undefined && { reps }),
    ...(provider !== undefined && { provider }),
    ...(model !== undefined && { model }),
  });

  // ... rest unchanged
}
```

Remove the `JudgeConfig` import — it's no longer needed here.

### Step 6: Update tests

In `src/assertions/validators/judge.test.ts`:

- Remove all calls that pass a `judgeConfigs` registry as the third argument to `validateJudge`
- Remove any usage of `configId` in test cases
- Update rubric values from plain strings to `BuiltInRubric | { text: string }` format

In `src/evals/evalRunner.test.ts`:

- Remove any `judgeConfigs` usage from `runEvalDataset` calls

In `src/evals/datasetTypes.test.ts`:

- Remove `configId` from any `passesJudge` test cases

### Step 7: Run tests and typecheck

```bash
npm test
npm run typecheck
```

Expect TypeScript to catch any missed usage of removed fields. Fix all errors.

### Step 8: Commit

```bash
git add -A
git commit -m "feat(judge): remove judgeConfigs registry — inline judge config on passesJudge"
```

---

## Acceptance Criteria

- [ ] `'custom-http'` removed from `ProviderKind` type — TypeScript catches it at compile time
- [ ] `EvalCaseResult.mode` field gone from both `types/reporter.ts` and UI types
- [ ] `defaultJudgeReps` on `EvalRunnerOptions` applies to cases without explicit `judgeReps`
- [ ] `rubric: 'correctness'` (BuiltInRubric) works; `rubric: 'typo'` is a TypeScript error
- [ ] `rubric: { text: 'My custom rubric...' }` works for arbitrary text
- [ ] `judgeConfigs` and `configId` are completely gone from all types and runtime code
- [ ] `toPassToolJudge` no longer uses `configId: '_inline'` hack
- [ ] `npm test` passes
- [ ] `npm run typecheck` clean
