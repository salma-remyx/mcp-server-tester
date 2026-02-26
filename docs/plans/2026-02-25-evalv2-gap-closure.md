# EvalV2 Gap Closure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the highest-priority gaps between `@gleanwork/mcp-server-tester` and Glean's internal EvalV2 system, making the OSS framework suitable for production MCP eval workflows.

**Architecture:** Seven additive tasks that each extend existing types, validators, and runners without breaking existing behavior. All new fields are optional; all new behaviors are opt-in. Tasks 1–4 share `datasetTypes.ts` and must run sequentially. Tasks 5–7 touch independent subsystems and can be parallelized after Task 1 lands.

**Tech Stack:** TypeScript strict, Vitest (unit tests via `npm test`), Zod (schema validation), Claude Agent SDK (judge), Vercel AI SDK (LLM host), Playwright (integration test runner).

**Run all tests:** `npm test`
**Run single file:** `npm test -- src/path/to/file.test.ts`
**Typecheck:** `npm run typecheck`

---

## Task 1: Judge Reps (P0)

**Why:** A single judge run per eval case is noisy. EvalV2 runs the judge N times and averages scores (median). Without this, judge-based accuracy is unreliable for production use.

**Semantic:** `judgeReps` on `EvalCase` is the default number of judge evaluations to run per `passesJudge` assertion. `passesJudge.reps` overrides it per-assertion. Scores are averaged; the mean must meet threshold to pass.

**Files:**

- Modify: `src/evals/datasetTypes.ts` — add `judgeReps` to `EvalCase`, `reps` to `passesJudge` block
- Modify: `src/assertions/validators/judge.ts` — loop judge N times, average scores
- Modify: `src/evals/evalRunner.ts` — thread `judgeReps` through `ExpectBlockConfig`
- Modify: `src/evals/evalRunner.test.ts` — new tests
- Modify: `src/evals/datasetTypes.test.ts` — Zod validation tests

---

### Step 1: Write failing tests

Add to `src/evals/evalRunner.test.ts` (find the existing test suite and append):

```typescript
describe('judge reps', () => {
  it('runs judge once by default', async () => {
    let callCount = 0;
    // We'll use a spy approach — see step 3 for mock pattern
    // For now: verify judgeReps: 1 === same as no judgeReps
    const evalCase: EvalCase = {
      id: 'judge-reps-default',
      toolName: 'echo',
      args: { message: 'hello' },
      expect: {
        passesJudge: { rubric: 'Response is a greeting', threshold: 0.5 },
      },
    };
    // Just verify it runs without error (real judge call skipped in unit test via mock)
  });

  it('averages scores across reps and passes when mean >= threshold', async () => {
    // Mock: first call score 0.6, second call score 0.8, mean 0.7 >= threshold 0.7 → pass
    // Implemented via mock judge in test setup
  });

  it('fails when mean score < threshold even if some reps pass', async () => {
    // Mock: scores [0.4, 0.4], mean 0.4 < threshold 0.7 → fail
  });

  it('per-assertion reps overrides case-level judgeReps', async () => {
    // judgeReps: 3 on case, reps: 1 on passesJudge → runs 1 time
  });
});
```

Add to `src/evals/datasetTypes.test.ts`:

```typescript
it('accepts judgeReps as positive integer', () => {
  const result = EvalCaseSchema.safeParse({
    id: 'test',
    judgeReps: 3,
    expect: { passesJudge: { rubric: 'test' } },
  });
  expect(result.success).toBe(true);
});

it('rejects judgeReps: 0', () => {
  const result = EvalCaseSchema.safeParse({ id: 'test', judgeReps: 0 });
  expect(result.success).toBe(false);
});

it('accepts passesJudge.reps', () => {
  const result = EvalCaseSchema.safeParse({
    id: 'test',
    expect: { passesJudge: { rubric: 'test', reps: 5 } },
  });
  expect(result.success).toBe(true);
});
```

Run: `npm test -- src/evals/datasetTypes.test.ts`
Expected: FAIL — `judgeReps` field unknown to Zod schema

---

### Step 2: Add `judgeReps` to `EvalCase` in `datasetTypes.ts`

In `src/evals/datasetTypes.ts`, add to the `EvalCase` interface after `accuracyThreshold`:

```typescript
/**
 * Number of times to invoke the LLM judge per `passesJudge` assertion.
 * Scores are averaged; the mean must meet the threshold to pass.
 * Reduces judge variance caused by non-determinism.
 * Per-assertion `passesJudge.reps` overrides this value.
 * @default 1
 */
judgeReps?: number;
```

Add to the `passesJudge` object in `EvalExpectBlock`:

```typescript
passesJudge?: {
  rubric: string;
  reference?: unknown;
  threshold?: number;
  configId?: string;
  /** Override for number of judge evaluations (overrides EvalCase.judgeReps) */
  reps?: number;
};
```

In `EvalCaseSchema` Zod definition, add after `accuracyThreshold`:

```typescript
judgeReps: z.number().int().min(1).optional(),
```

In `EvalExpectBlockSchema`, add `reps` to the `passesJudge` object:

```typescript
passesJudge: z
  .object({
    rubric: z.string(),
    reference: z.unknown().optional(),
    threshold: z.number().min(0).max(1).optional(),
    configId: z.string().optional(),
    reps: z.number().int().min(1).optional(),
  })
  .optional(),
```

Run: `npm test -- src/evals/datasetTypes.test.ts`
Expected: PASS

---

### Step 3: Modify `validateJudge` to accept and loop `reps`

In `src/assertions/validators/judge.ts`, update `JudgeValidatorConfig`:

```typescript
export interface JudgeValidatorConfig {
  rubric: string;
  reference?: unknown;
  threshold?: number;
  configId?: string;
  /** Number of judge evaluations to run. Scores averaged. @default 1 */
  reps?: number;
}
```

Replace the `judge.evaluate(...)` call with a loop:

```typescript
export async function validateJudge(
  response: unknown,
  config: JudgeValidatorConfig,
  judgeConfigs?: Record<string, JudgeConfig>
): Promise<ValidationResult> {
  const { rubric, reference, threshold = 0.7, configId, reps = 1 } = config;

  const judgeConfig: JudgeConfig = configId
    ? (judgeConfigs?.[configId] ?? {})
    : {};

  try {
    const judge = createJudge(judgeConfig);

    const scores: number[] = [];
    let lastReasoning: string | undefined;

    for (let i = 0; i < reps; i++) {
      const judgeResult = await judge.evaluate(
        response,
        reference ?? null,
        rubric
      );
      scores.push(judgeResult.score ?? (judgeResult.pass ? 1.0 : 0.0));
      lastReasoning = judgeResult.reasoning;
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

---

### Step 4: Thread `judgeReps` through `ExpectBlockConfig` in `evalRunner.ts`

In `src/evals/evalRunner.ts`, add `judgeReps` to `ExpectBlockConfig`:

```typescript
interface ExpectBlockConfig {
  schemas?: Record<string, ZodType>;
  judgeConfigs?: Record<string, JudgeConfig>;
  playwrightExpect?: Expect;
  judgeReps?: number; // NEW — case-level default reps for judge evaluations
}
```

In `runExpectBlockValidations`, pass the effective reps when calling `validateJudge`:

```typescript
// passesJudge (toPassToolJudge)
if (expectBlock.passesJudge !== undefined) {
  const effectiveReps = expectBlock.passesJudge.reps ?? config.judgeReps ?? 1;
  const validation = await validateJudge(
    response,
    { ...expectBlock.passesJudge, reps: effectiveReps },
    config.judgeConfigs
  );
  results.judge = { pass: validation.pass, details: validation.message };
}
```

In `runSingleIteration`, thread `judgeReps` into the config object:

```typescript
expectationResults = await runExpectBlockValidations(
  evalCase.expect,
  response,
  {
    schemas: options.schemas,
    judgeConfigs: options.judgeConfigs,
    playwrightExpect: context.expect,
    judgeReps: evalCase.judgeReps, // NEW
  }
);
```

---

### Step 5: Run all tests, typecheck

```bash
npm test
npm run typecheck
```

Expected: All existing tests pass, new judge reps tests pass (mocked). TypeScript: no errors.

---

### Step 6: Commit

```bash
git add src/evals/datasetTypes.ts src/assertions/validators/judge.ts src/evals/evalRunner.ts src/evals/evalRunner.test.ts src/evals/datasetTypes.test.ts
git commit -m "feat(evals): add judgeReps — run judge N times and average scores (P0)"
```

---

## Task 2: `canonicalAnswer` Field + `BuiltInRubric` (P1)

**Why:** Teams currently embed reference answers inline in `rubric` strings. EvalV2 stores `canonical_answer` per case, which judges use as a reference. Named rubrics (`BuiltInRubric`) standardize judge behavior across teams — consistent semantics for CORRECTNESS, COMPLETENESS, GROUNDEDNESS.

**Files:**

- Modify: `src/evals/datasetTypes.ts` — add `canonicalAnswer` to `EvalCase`
- Create: `src/judge/rubrics.ts` — `BuiltInRubric` type + rubric text map
- Modify: `src/judge/judgeTypes.ts` — export `BuiltInRubric`
- Modify: `src/assertions/validators/judge.ts` — resolve built-in rubric strings
- Modify: `src/evals/evalRunner.ts` — pass `canonicalAnswer` as judge reference when `passesJudge.reference` is absent
- Modify: `src/index.ts` — export `BuiltInRubric`, `BUILT_IN_RUBRICS`
- Modify: `src/evals/datasetTypes.test.ts` — validation tests

---

### Step 1: Write failing tests

In `src/evals/datasetTypes.test.ts`, add:

```typescript
it('accepts canonicalAnswer string', () => {
  const result = EvalCaseSchema.safeParse({
    id: 'test',
    canonicalAnswer: 'The capital of France is Paris.',
  });
  expect(result.success).toBe(true);
});
```

Add test for built-in rubric resolution in `src/assertions/validators/validators.test.ts` (or create a judge-specific test file):

```typescript
it('resolves built-in rubric "correctness" to a full rubric string', async () => {
  // The rubric passed to judge.evaluate should not be the literal string 'correctness'
  // but the expanded rubric text. We verify this via the message output.
  // (Mock the judge to capture the rubric argument)
});
```

Run: `npm test -- src/evals/datasetTypes.test.ts`
Expected: FAIL — `canonicalAnswer` field unknown

---

### Step 2: Create `src/judge/rubrics.ts`

```typescript
/**
 * Built-in judge rubrics matching Glean EvalV2's named judge types.
 * Use these for consistent, standardized evaluations across teams.
 */
export type BuiltInRubric =
  | 'correctness'
  | 'completeness'
  | 'groundedness'
  | 'instruction-following'
  | 'conciseness';

export const BUILT_IN_RUBRICS: Record<BuiltInRubric, string> = {
  correctness:
    'Evaluate whether the response is factually correct and accurately answers the question. ' +
    'Compare against the reference answer if provided. ' +
    'Score 1.0 for fully correct, 0.5 for partially correct, 0.0 for incorrect or irrelevant.',

  completeness:
    'Evaluate whether the response fully addresses all aspects of the question. ' +
    'Score 1.0 if the response covers all key points, 0.5 if it partially answers, ' +
    '0.0 if major aspects are missing.',

  groundedness:
    'Evaluate whether all claims in the response are supported by the retrieved context or reference. ' +
    'Penalize unsupported assertions or hallucinated facts. ' +
    'Score 1.0 for fully grounded, 0.5 for mostly grounded, 0.0 for hallucinated.',

  'instruction-following':
    'Evaluate whether the response follows the instructions given in the question. ' +
    'Check format, tone, constraints, and task completion. ' +
    'Score 1.0 for full compliance, 0.5 for partial, 0.0 for non-compliance.',

  conciseness:
    'Evaluate whether the response is appropriately concise without losing important information. ' +
    'Penalize unnecessary verbosity. Score 1.0 for well-sized, 0.5 for somewhat verbose, 0.0 for excessively long.',
};

/**
 * Returns true if `s` is a built-in rubric name.
 */
export function isBuiltInRubric(s: string): s is BuiltInRubric {
  return s in BUILT_IN_RUBRICS;
}

/**
 * Resolves a rubric string: if it's a built-in name, returns the expanded text.
 * Otherwise returns the string as-is.
 */
export function resolveRubric(rubric: string): string {
  if (isBuiltInRubric(rubric)) {
    return BUILT_IN_RUBRICS[rubric];
  }
  return rubric;
}
```

---

### Step 3: Add `canonicalAnswer` to `EvalCase` in `datasetTypes.ts`

Add to `EvalCase` interface after `metadata`:

```typescript
/**
 * Golden/expected answer for this case.
 * When set, automatically passed as `reference` to the LLM judge
 * (unless passesJudge.reference is explicitly provided).
 * Mirrors EvalV2's `canonical_answer` field.
 */
canonicalAnswer?: string;
```

Add to `EvalCaseSchema`:

```typescript
canonicalAnswer: z.string().optional(),
```

---

### Step 4: Update `validateJudge` to resolve built-in rubrics

In `src/assertions/validators/judge.ts`, add import and resolve:

```typescript
import { resolveRubric } from '../../judge/rubrics.js';

// Inside validateJudge, before creating the judge:
const resolvedRubric = resolveRubric(rubric);

// Then use resolvedRubric instead of rubric in judge.evaluate(...)
const judgeResult = await judge.evaluate(
  response,
  reference ?? null,
  resolvedRubric
);
```

---

### Step 5: Pass `canonicalAnswer` as judge reference in `evalRunner.ts`

In `runExpectBlockValidations`, add `canonicalAnswer` to `ExpectBlockConfig`:

```typescript
interface ExpectBlockConfig {
  schemas?: Record<string, ZodType>;
  judgeConfigs?: Record<string, JudgeConfig>;
  playwrightExpect?: Expect;
  judgeReps?: number;
  canonicalAnswer?: string; // NEW
}
```

When processing `passesJudge`, use `canonicalAnswer` as fallback reference:

```typescript
if (expectBlock.passesJudge !== undefined) {
  const effectiveReps = expectBlock.passesJudge.reps ?? config.judgeReps ?? 1;
  const effectiveReference =
    expectBlock.passesJudge.reference !== undefined
      ? expectBlock.passesJudge.reference
      : config.canonicalAnswer; // NEW — use case-level canonical as fallback
  const validation = await validateJudge(
    response,
    {
      ...expectBlock.passesJudge,
      reference: effectiveReference,
      reps: effectiveReps,
    },
    config.judgeConfigs
  );
  results.judge = { pass: validation.pass, details: validation.message };
}
```

In `runSingleIteration`, add `canonicalAnswer` to config:

```typescript
expectationResults = await runExpectBlockValidations(
  evalCase.expect,
  response,
  {
    schemas: options.schemas,
    judgeConfigs: options.judgeConfigs,
    playwrightExpect: context.expect,
    judgeReps: evalCase.judgeReps,
    canonicalAnswer: evalCase.canonicalAnswer, // NEW
  }
);
```

---

### Step 6: Export from `src/judge/judgeTypes.ts` and `src/index.ts`

In `src/judge/judgeTypes.ts`, add re-export:

```typescript
export type { BuiltInRubric } from './rubrics.js';
export { BUILT_IN_RUBRICS, resolveRubric, isBuiltInRubric } from './rubrics.js';
```

In `src/index.ts`, add:

```typescript
export type { BuiltInRubric } from './judge/judgeTypes.js';
export {
  BUILT_IN_RUBRICS,
  resolveRubric,
  isBuiltInRubric,
} from './judge/judgeTypes.js';
```

---

### Step 7: Run tests and typecheck

```bash
npm test
npm run typecheck
```

Expected: All pass. TypeScript: no errors.

---

### Step 8: Commit

```bash
git add src/evals/datasetTypes.ts src/judge/rubrics.ts src/judge/judgeTypes.ts src/assertions/validators/judge.ts src/evals/evalRunner.ts src/index.ts src/evals/datasetTypes.test.ts
git commit -m "feat(evals): add canonicalAnswer field and BuiltInRubric named rubrics (P1)"
```

---

## Task 3: Tags and Tag-Based Filtering (P1)

**Why:** EvalV2 slices eval results by `query_classification_results`. Without tagging, teams can't filter or analyze results by query type (e.g., "show me only tool-finding cases"). Enables building specialized eval sets with consistent labeling.

**Files:**

- Modify: `src/evals/datasetTypes.ts` — add `tags?: string[]` to `EvalCase`
- Modify: `src/evals/evalRunner.ts` — add `filterTags` to `EvalRunnerOptions`; filter cases before running
- Modify: `src/types/reporter.ts` — add `tags?: string[]` to `EvalCaseResult`
- Modify: `src/reporters/ui-src/types.ts` — sync UI types
- Modify: `src/evals/datasetTypes.test.ts`, `src/evals/evalRunner.test.ts`

---

### Step 1: Write failing tests

In `src/evals/datasetTypes.test.ts`:

```typescript
it('accepts tags array', () => {
  const result = EvalCaseSchema.safeParse({
    id: 'test',
    tags: ['tool-finding', 'multi-hop'],
  });
  expect(result.success).toBe(true);
});

it('accepts empty tags array', () => {
  const result = EvalCaseSchema.safeParse({ id: 'test', tags: [] });
  expect(result.success).toBe(true);
});
```

In `src/evals/evalRunner.test.ts`:

```typescript
describe('filterTags', () => {
  it('runs only cases matching any of the specified tags', async () => {
    const dataset: EvalDataset = {
      name: 'filter-test',
      cases: [
        { id: 'a', toolName: 'tool', args: {}, tags: ['search'] },
        { id: 'b', toolName: 'tool', args: {}, tags: ['nav'] },
        { id: 'c', toolName: 'tool', args: {}, tags: ['search', 'nav'] },
      ],
    };
    const result = await runEvalDataset(
      { dataset, filterTags: ['search'] },
      { mcp: mockMcp }
    );
    expect(result.total).toBe(2); // cases 'a' and 'c'
    expect(result.caseResults.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('runs all cases when filterTags is undefined', async () => {
    // ... standard behavior unchanged
  });

  it('runs zero cases when no cases match filterTags', async () => {
    // ...
  });
});
```

Run: `npm test -- src/evals/evalRunner.test.ts`
Expected: FAIL — `filterTags` not recognized

---

### Step 2: Add `tags` to `EvalCase` in `datasetTypes.ts`

Add to `EvalCase` interface after `metadata`:

```typescript
/**
 * Arbitrary string labels for this case.
 * Used for filtering eval runs with `EvalRunnerOptions.filterTags`
 * and for slicing results in the reporter.
 *
 * @example ['tool-finding', 'multi-hop', 'search']
 */
tags?: string[];
```

Add to `EvalCaseSchema`:

```typescript
tags: z.array(z.string()).optional(),
```

---

### Step 3: Add `filterTags` to `EvalRunnerOptions` in `evalRunner.ts`

Add to `EvalRunnerOptions`:

```typescript
/**
 * When set, only eval cases whose `tags` array contains at least one of
 * the specified tags are run. Cases with no `tags` field are excluded.
 * When undefined, all cases run (default behavior).
 */
filterTags?: string[];
```

At the top of `runEvalDataset`, after destructuring options, filter the cases:

```typescript
const casesToRun =
  options.filterTags && options.filterTags.length > 0
    ? dataset.cases.filter((c) =>
        c.tags?.some((t) => options.filterTags!.includes(t))
      )
    : dataset.cases;
```

Replace all references to `dataset.cases` in the function body with `casesToRun`.

---

### Step 4: Add `tags` to `EvalCaseResult` in `types/reporter.ts`

In `EvalCaseResult`, add after `mode`:

```typescript
/**
 * Tags from the source eval case, for filtering and reporting.
 */
tags?: string[];
```

In `runSingleIteration` in `evalRunner.ts`, add to the returned object:

```typescript
return {
  // ...existing fields...
  tags: evalCase.tags, // NEW
};
```

---

### Step 5: Sync UI types in `src/reporters/ui-src/types.ts`

Find `EvalCaseResult` in the UI types file and add the same `tags?: string[]` field.

---

### Step 6: Run tests and typecheck

```bash
npm test
npm run typecheck
```

Expected: All pass.

---

### Step 7: Commit

```bash
git add src/evals/datasetTypes.ts src/evals/evalRunner.ts src/types/reporter.ts src/reporters/ui-src/types.ts src/evals/datasetTypes.test.ts src/evals/evalRunner.test.ts
git commit -m "feat(evals): add tags field and filterTags runner option (P1)"
```

---

## Task 4: Tool Precision & Recall Float Metrics (P1)

**Why:** `toolsTriggered` currently returns binary pass/fail. EvalV2's `TOOL_PRECISION` and `TOOL_RECALL` judges output float scores (0–1), which are actionable for debugging tool descriptions. A precision of 0.6 tells you _how bad_ the over-triggering is; binary doesn't.

**Semantic:**

- **Precision** = required calls that were actually made / total calls made = measures over-triggering
- **Recall** = required calls that were made / total required calls = measures missed tools

**Files:**

- Modify: `src/assertions/validators/toolCalls.ts` — compute and return `precision`, `recall` in `ValidationResult`
- Modify: `src/assertions/validators/types.ts` — extend `ValidationResult` with optional `metrics`
- Modify: `src/types/reporter.ts` — add `toolPrecision?: number`, `toolRecall?: number` to `EvalCaseResult`
- Modify: `src/evals/evalRunner.ts` — extract metrics from `toolsTriggered` result and surface in `EvalCaseResult`
- Modify: `src/reporters/ui-src/types.ts` — sync UI types

---

### Step 1: Write failing tests

In `src/assertions/validators/toolCalls.test.ts` (create if not exists, otherwise append):

```typescript
describe('validateToolCalls precision/recall', () => {
  const makeSimResult = (names: string[]) => ({
    success: true,
    toolCalls: names.map((name) => ({ name, arguments: {} })),
    response: 'done',
  });

  it('computes precision 1.0 and recall 1.0 when all required tools called exactly', () => {
    const result = validateToolCalls(makeSimResult(['search', 'read']), {
      calls: [
        { name: 'search', required: true },
        { name: 'read', required: true },
      ],
    });
    expect(result.metrics?.precision).toBe(1.0);
    expect(result.metrics?.recall).toBe(1.0);
  });

  it('computes recall 0.5 when one of two required tools not called', () => {
    const result = validateToolCalls(makeSimResult(['search']), {
      calls: [
        { name: 'search', required: true },
        { name: 'read', required: true },
      ],
    });
    expect(result.metrics?.recall).toBe(0.5);
  });

  it('computes precision 0.5 when one unexpected tool called alongside required', () => {
    const result = validateToolCalls(makeSimResult(['search', 'irrelevant']), {
      calls: [{ name: 'search', required: true }],
      exclusive: true,
    });
    expect(result.metrics?.precision).toBeCloseTo(0.5);
  });
});
```

Run: `npm test -- src/assertions/validators/toolCalls.test.ts`
Expected: FAIL — `result.metrics` is undefined

---

### Step 2: Extend `ValidationResult` in `src/assertions/validators/types.ts`

Find `ValidationResult` and add:

```typescript
export interface ValidationResult {
  pass: boolean;
  message: string;
  /**
   * Optional quantitative metrics from the validation.
   * Currently populated by validateToolCalls for precision/recall.
   */
  metrics?: {
    precision?: number;
    recall?: number;
  };
}
```

---

### Step 3: Compute and return precision/recall in `validateToolCalls`

In `src/assertions/validators/toolCalls.ts`, at the end of `validateToolCalls` before the final `return { pass: true, ... }`:

```typescript
// Compute precision and recall
const requiredCalls = expectation.calls.filter((c) => c.required !== false);
const calledRequiredCount = requiredCalls.filter(
  (expected) => findMatchingCall(actual, expected) !== -1
).length;

const recall =
  requiredCalls.length > 0 ? calledRequiredCount / requiredCalls.length : 1.0;

// Precision: of all tool calls made, what fraction were expected?
// When exclusive=true, any unexpected call hurts precision.
// When exclusive=false, only count expected calls in denominator.
const allowedNames = new Set(expectation.calls.map((c) => c.name));
const expectedCallsMade = actual.filter((c) => allowedNames.has(c.name)).length;
const precision = actual.length > 0 ? expectedCallsMade / actual.length : 1.0;

return {
  pass: true,
  message: 'All tool call expectations met',
  metrics: { precision, recall },
};
```

Also attach metrics to the failure returns (with the actual values so callers can see partial scores):

```typescript
// On each early failure return, compute partial metrics and attach:
// (add to each return statement)
const partialRecall = ...; // computed inline
const partialPrecision = ...; // computed inline
return {
  pass: false,
  message: '...',
  metrics: { precision: partialPrecision, recall: partialRecall },
};
```

For simplicity: compute precision/recall at the start of the function before the order checks, and attach to every return.

---

### Step 4: Add `toolPrecision` / `toolRecall` to `EvalCaseResult` in `types/reporter.ts`

In `EvalCaseResult`, add after `iterationResults`:

```typescript
/**
 * Precision of tool calls made (0–1).
 * 1.0 means every tool called was expected; <1.0 means unexpected tools were called.
 * Only present when toolsTriggered expectation was evaluated.
 */
toolPrecision?: number;

/**
 * Recall of required tool calls (0–1).
 * 1.0 means all required tools were called; <1.0 means some were missed.
 * Only present when toolsTriggered expectation was evaluated.
 */
toolRecall?: number;
```

---

### Step 5: Extract metrics in `evalRunner.ts` and attach to result

In `runExpectBlockValidations`, extract metrics from toolsTriggered result:

```typescript
// toolsTriggered (toHaveToolCalls)
if (expectBlock.toolsTriggered !== undefined) {
  const validation = validateToolCalls(response, expectBlock.toolsTriggered);
  results.toolsTriggered = {
    pass: validation.pass,
    details: validation.message,
  };
  // Surface precision/recall for caller to attach to EvalCaseResult
  if (validation.metrics) {
    results._toolMetrics = validation.metrics; // internal carry
  }
}
```

Actually, a cleaner approach: return the full `ValidationResult` alongside the simplified `EvalExpectationResult`, or return metrics out-of-band. Let me use a simpler approach — modify `runExpectBlockValidations` to return an extended type:

```typescript
interface ExpectBlockResults {
  expectations: EvalCaseResult['expectations'];
  toolPrecision?: number;
  toolRecall?: number;
}

async function runExpectBlockValidations(...): Promise<ExpectBlockResults> {
  // ...existing code...
  let toolPrecision: number | undefined;
  let toolRecall: number | undefined;

  if (expectBlock.toolsTriggered !== undefined) {
    const validation = validateToolCalls(response, expectBlock.toolsTriggered);
    results.toolsTriggered = { pass: validation.pass, details: validation.message };
    toolPrecision = validation.metrics?.precision;
    toolRecall = validation.metrics?.recall;
  }

  return { expectations: results, toolPrecision, toolRecall };
}
```

Update `runSingleIteration` to use the extended return value:

```typescript
const { expectations: expectationResults, toolPrecision, toolRecall } =
  await runExpectBlockValidations(...);

return {
  // ...existing fields...
  toolPrecision,  // NEW
  toolRecall,     // NEW
};
```

---

### Step 6: Sync UI types in `src/reporters/ui-src/types.ts`

Add `toolPrecision?: number` and `toolRecall?: number` to the `EvalCaseResult` interface in the UI types file.

---

### Step 7: Run tests and typecheck

```bash
npm test
npm run typecheck
```

Expected: All pass.

---

### Step 8: Commit

```bash
git add src/assertions/validators/types.ts src/assertions/validators/toolCalls.ts src/types/reporter.ts src/evals/evalRunner.ts src/reporters/ui-src/types.ts src/assertions/validators/toolCalls.test.ts
git commit -m "feat(evals): surface tool precision and recall float metrics (P1)"
```

---

## Task 5: Multiple Judge Providers (P1)

**Why:** Claude-only judging introduces single-provider bias and lock-in. EvalV2 supports GPT-4/5 and Gemini alongside Claude. Multi-judge consensus reduces variance. Teams using OpenAI in their LLM host may want the same provider for judging.

**Design:** Implement `OpenAIJudge` and `GoogleJudge` using the OpenAI Node SDK and Google AI SDK respectively. Both implement the `Judge` interface identically.

**Files:**

- Create: `src/judge/openaiJudge.ts`
- Create: `src/judge/googleJudge.ts`
- Modify: `src/judge/judgeTypes.ts` — extend `ProviderKind`
- Modify: `src/judge/judgeClient.ts` — add cases to switch
- Modify: `src/index.ts` — export new provider kind

**Dependencies:** `openai` package is likely already installed (used by LLM host). `@ai-sdk/google` or `@google/genai` — check `package.json`. If not installed, the error should be caught gracefully with a helpful message.

---

### Step 1: Check existing dependencies

```bash
cat package.json | grep -E '"openai"|"@google"'
```

Verify which packages are available. The LLM host uses Vercel AI SDK. For judges, we want direct API clients for simplicity.

---

### Step 2: Write failing tests in `src/judge/claudeAgentJudge.test.ts` (or create `src/judge/judgeClient.test.ts`)

```typescript
describe('createJudge provider routing', () => {
  it('creates a Claude judge for provider "claude"', () => {
    // Just verify no error thrown; actual evaluation is integration tested
    expect(() => createJudge({ provider: 'claude' })).not.toThrow();
  });

  it('creates an OpenAI judge for provider "openai"', () => {
    expect(() => createJudge({ provider: 'openai' })).not.toThrow();
  });

  it('creates a Google judge for provider "google"', () => {
    expect(() => createJudge({ provider: 'google' })).not.toThrow();
  });

  it('throws for unknown provider', () => {
    // @ts-expect-error — testing runtime guard
    expect(() => createJudge({ provider: 'unknown' })).toThrow('Unsupported');
  });
});
```

Run: `npm test -- src/judge/judgeClient.test.ts`
Expected: FAIL — 'openai' and 'google' still throw

---

### Step 3: Update `ProviderKind` in `judgeTypes.ts`

```typescript
export type ProviderKind =
  | 'claude'
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'custom-http'; // keep for error message
```

Remove the `@deprecated` comment from `ProviderKind` — `openai` and `google` are now supported. `custom-http` remains deprecated.

---

### Step 4: Create `src/judge/openaiJudge.ts`

````typescript
import type { Judge, JudgeConfig, JudgeResult } from './judgeTypes.js';

/**
 * OpenAI-backed LLM judge.
 * Requires `openai` package and OPENAI_API_KEY (or apiKeyEnvVar override).
 */
export function createOpenAIJudge(config: JudgeConfig = {}): Judge {
  const apiKey = process.env[config.apiKeyEnvVar ?? 'OPENAI_API_KEY'];
  if (!apiKey) {
    throw new Error(
      `OpenAI judge requires an API key. Set ${config.apiKeyEnvVar ?? 'OPENAI_API_KEY'} environment variable.`
    );
  }

  const model = config.model ?? 'gpt-4o';
  const maxTokens = config.maxTokens ?? 1000;
  const temperature = config.temperature ?? 0.0;

  return {
    async evaluate(candidate, reference, rubric): Promise<JudgeResult> {
      // Dynamic import to avoid hard dependency when not used
      let OpenAI: typeof import('openai').default;
      try {
        const module = await import('openai');
        OpenAI = module.default;
      } catch {
        throw new Error(
          'OpenAI judge requires the `openai` package. Run: npm install openai'
        );
      }

      const client = new OpenAI({ apiKey });
      const prompt = buildJudgePrompt(candidate, reference, rubric);

      const startTime = Date.now();
      const response = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [
          {
            role: 'system',
            content:
              'You are an expert evaluator. Respond with valid JSON only: {"pass": boolean, "score": number, "reasoning": string}',
          },
          { role: 'user', content: prompt },
        ],
      });
      const durationMs = Date.now() - startTime;

      const text = response.choices[0]?.message.content ?? '';
      const parsed = parseJudgeResponse(text);

      return {
        pass: parsed.pass,
        score: parsed.score,
        reasoning: parsed.reasoning,
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          totalCostUsd: 0, // OpenAI cost calculation left to caller
          durationMs,
        },
      };
    },
  };
}

function buildJudgePrompt(
  candidate: unknown,
  reference: unknown,
  rubric: string
): string {
  const parts = [
    `Rubric: ${rubric}`,
    `Response to evaluate:\n${JSON.stringify(candidate, null, 2)}`,
  ];
  if (reference !== null && reference !== undefined) {
    parts.push(`Reference answer:\n${JSON.stringify(reference, null, 2)}`);
  }
  return parts.join('\n\n');
}

function parseJudgeResponse(text: string): {
  pass: boolean;
  score: number;
  reasoning: string;
} {
  const cleaned = text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as {
      pass?: boolean;
      score?: number;
      reasoning?: string;
    };
    return {
      pass: parsed.pass ?? false,
      score:
        typeof parsed.score === 'number'
          ? parsed.score
          : parsed.pass
            ? 1.0
            : 0.0,
      reasoning: parsed.reasoning ?? '',
    };
  } catch {
    return {
      pass: false,
      score: 0,
      reasoning: `Failed to parse judge response: ${text}`,
    };
  }
}
````

---

### Step 5: Create `src/judge/googleJudge.ts`

````typescript
import type { Judge, JudgeConfig, JudgeResult } from './judgeTypes.js';

/**
 * Google Gemini-backed LLM judge.
 * Requires `@google/generative-ai` package and GOOGLE_API_KEY (or apiKeyEnvVar override).
 */
export function createGoogleJudge(config: JudgeConfig = {}): Judge {
  const apiKey = process.env[config.apiKeyEnvVar ?? 'GOOGLE_API_KEY'];
  if (!apiKey) {
    throw new Error(
      `Google judge requires an API key. Set ${config.apiKeyEnvVar ?? 'GOOGLE_API_KEY'} environment variable.`
    );
  }

  const model = config.model ?? 'gemini-2.0-flash';
  const maxTokens = config.maxTokens ?? 1000;

  return {
    async evaluate(candidate, reference, rubric): Promise<JudgeResult> {
      let GoogleGenerativeAI: typeof import('@google/generative-ai').GoogleGenerativeAI;
      try {
        const module = await import('@google/generative-ai');
        GoogleGenerativeAI = module.GoogleGenerativeAI;
      } catch {
        throw new Error(
          'Google judge requires the `@google/generative-ai` package. Run: npm install @google/generative-ai'
        );
      }

      const genAI = new GoogleGenerativeAI(apiKey);
      const gemini = genAI.getGenerativeModel({
        model,
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.0 },
        systemInstruction:
          'You are an expert evaluator. Respond with valid JSON only: {"pass": boolean, "score": number, "reasoning": string}',
      });

      const parts = [
        `Rubric: ${rubric}`,
        `Response to evaluate:\n${JSON.stringify(candidate, null, 2)}`,
      ];
      if (reference !== null && reference !== undefined) {
        parts.push(`Reference answer:\n${JSON.stringify(reference, null, 2)}`);
      }

      const startTime = Date.now();
      const result = await gemini.generateContent(parts.join('\n\n'));
      const durationMs = Date.now() - startTime;

      const text = result.response.text();
      const cleaned = text
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      try {
        const parsed = JSON.parse(cleaned) as {
          pass?: boolean;
          score?: number;
          reasoning?: string;
        };
        return {
          pass: parsed.pass ?? false,
          score:
            typeof parsed.score === 'number'
              ? parsed.score
              : parsed.pass
                ? 1.0
                : 0.0,
          reasoning: parsed.reasoning ?? '',
          usage: {
            inputTokens: result.response.usageMetadata?.promptTokenCount ?? 0,
            outputTokens:
              result.response.usageMetadata?.candidatesTokenCount ?? 0,
            totalCostUsd: 0,
            durationMs,
          },
        };
      } catch {
        return {
          pass: false,
          score: 0,
          reasoning: `Failed to parse judge response: ${text}`,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalCostUsd: 0,
            durationMs,
          },
        };
      }
    },
  };
}
````

---

### Step 6: Wire into `judgeClient.ts`

```typescript
import type { Judge, JudgeConfig, ProviderKind } from './judgeTypes.js';
import { createClaudeAgentJudge } from './claudeAgentJudge.js';
import { createOpenAIJudge } from './openaiJudge.js';
import { createGoogleJudge } from './googleJudge.js';

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

    case 'custom-http':
      throw new Error(
        'custom-http provider is no longer supported. ' +
          'Please use createJudge() without specifying provider.'
      );

    default:
      throw new Error(`Unsupported LLM provider: ${String(provider)}`);
  }
}
```

---

### Step 7: Run tests and typecheck

```bash
npm test
npm run typecheck
```

Expected: All pass. Judge client tests pass (no actual API calls in unit tests — APIs are lazily imported).

---

### Step 8: Commit

```bash
git add src/judge/judgeTypes.ts src/judge/openaiJudge.ts src/judge/googleJudge.ts src/judge/judgeClient.ts src/judge/judgeClient.test.ts
git commit -m "feat(judge): add OpenAI and Google Gemini judge providers (P1)"
```

---

## Task 6: Baseline Eval Comparison (P1)

**Why:** No way to ask "did this run regress vs. last week?" EvalV2's `baselineEvalId` enables regression detection. Without a baseline, teams can't tell if a change improved or degraded eval quality.

**Design:** File-based baseline. `runEvalDataset` optionally saves results to a JSON file. On the next run, `baselineResultsFrom` loads that file and computes delta per case and overall. Results include `deltaAccuracy` (current − baseline pass rate).

**Files:**

- Create: `src/evals/baseline.ts` — save/load functions
- Modify: `src/evals/evalRunner.ts` — `saveResultsTo`, `baselineResultsFrom` in options; compute `delta`
- Modify: `src/evals/evalRunner.ts` — extend `EvalRunnerResult` with `baseline` comparison fields
- Modify: `src/types/reporter.ts` — add `baselinePass?: boolean` to `EvalCaseResult`
- Modify: `src/reporters/ui-src/types.ts` — sync
- Modify: `src/index.ts` — export baseline utilities

---

### Step 1: Write failing tests

In `src/evals/baseline.test.ts` (create):

```typescript
import { saveBaseline, loadBaseline } from './baseline.js';
import type { EvalRunnerResult } from './evalRunner.js';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('baseline save/load', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcp-baseline-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('saves and loads baseline round-trip', async () => {
    const result: EvalRunnerResult = {
      total: 2,
      passed: 1,
      failed: 1,
      caseResults: [
        {
          id: 'a',
          pass: true,
          datasetName: 'test',
          toolName: 'tool',
          source: 'eval',
          durationMs: 100,
          expectations: {},
        },
        {
          id: 'b',
          pass: false,
          datasetName: 'test',
          toolName: 'tool',
          source: 'eval',
          durationMs: 200,
          expectations: {},
        },
      ],
      durationMs: 300,
    };

    const filePath = join(tmpDir, 'baseline.json');
    await saveBaseline(result, filePath);
    const loaded = await loadBaseline(filePath);

    expect(loaded.total).toBe(2);
    expect(loaded.passed).toBe(1);
    expect(loaded.caseResults).toHaveLength(2);
  });

  it('throws if baseline file not found', async () => {
    await expect(loadBaseline('/does/not/exist.json')).rejects.toThrow();
  });
});
```

Run: `npm test -- src/evals/baseline.test.ts`
Expected: FAIL — module not found

---

### Step 2: Create `src/evals/baseline.ts`

```typescript
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { EvalRunnerResult } from './evalRunner.js';

/**
 * Saves eval results to a JSON file for use as a baseline in future runs.
 */
export async function saveBaseline(
  result: EvalRunnerResult,
  filePath: string
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(result, null, 2), 'utf8');
}

/**
 * Loads a previously saved baseline from a JSON file.
 */
export async function loadBaseline(
  filePath: string
): Promise<EvalRunnerResult> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as EvalRunnerResult;
}

/**
 * Computes per-case delta between current and baseline results.
 * Returns a map of case ID → baseline pass status.
 */
export function buildBaselinePassMap(
  baseline: EvalRunnerResult
): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const result of baseline.caseResults) {
    map.set(result.id, result.pass);
  }
  return map;
}
```

---

### Step 3: Add `saveResultsTo` / `baselineResultsFrom` to `EvalRunnerOptions` and extend `EvalRunnerResult`

In `EvalRunnerOptions` in `evalRunner.ts`:

```typescript
/**
 * If set, saves the run results to this file path after completion.
 * Use with baselineResultsFrom on the next run for regression detection.
 */
saveResultsTo?: string;

/**
 * If set, loads this file as the baseline and computes delta vs. current run.
 */
baselineResultsFrom?: string;
```

Extend `EvalRunnerResult`:

```typescript
export interface EvalRunnerResult {
  total: number;
  passed: number;
  failed: number;
  caseResults: Array<EvalCaseResult>;
  durationMs: number;

  /**
   * Delta vs. baseline: current pass rate minus baseline pass rate.
   * Positive = improvement, negative = regression, undefined = no baseline.
   */
  deltaPassRate?: number;

  /**
   * Number of cases that regressed (passed in baseline, failed now).
   */
  regressions?: number;

  /**
   * Number of cases that improved (failed in baseline, passed now).
   */
  improvements?: number;
}
```

In `runEvalDataset`, after building `result`, add:

```typescript
import {
  saveBaseline,
  loadBaseline,
  buildBaselinePassMap,
} from './baseline.js';

// Load baseline if requested
if (options.baselineResultsFrom) {
  try {
    const baseline = await loadBaseline(options.baselineResultsFrom);
    const baselineMap = buildBaselinePassMap(baseline);
    const baselinePassRate = baseline.passed / baseline.total;

    // Tag each case result with its baseline pass status
    for (const cr of result.caseResults) {
      const baselinePass = baselineMap.get(cr.id);
      if (baselinePass !== undefined) {
        cr.baselinePass = baselinePass;
      }
    }

    const regressions = result.caseResults.filter(
      (cr) => cr.baselinePass === true && !cr.pass
    ).length;
    const improvements = result.caseResults.filter(
      (cr) => cr.baselinePass === false && cr.pass
    ).length;

    result.deltaPassRate = result.passed / result.total - baselinePassRate;
    result.regressions = regressions;
    result.improvements = improvements;
  } catch (err) {
    console.warn(
      `[mcp-server-tester] Could not load baseline from ${options.baselineResultsFrom}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// Save results if requested
if (options.saveResultsTo) {
  await saveBaseline(result, options.saveResultsTo);
}
```

---

### Step 4: Add `baselinePass` to `EvalCaseResult` in `types/reporter.ts`

```typescript
/**
 * Pass/fail status of this case in the baseline run.
 * Only present when a baseline was provided to runEvalDataset.
 */
baselinePass?: boolean;
```

Sync `src/reporters/ui-src/types.ts`.

---

### Step 5: Export from `src/index.ts`

```typescript
export { saveBaseline, loadBaseline } from './evals/baseline.js';
```

---

### Step 6: Run tests and typecheck

```bash
npm test
npm run typecheck
```

Expected: All pass.

---

### Step 7: Commit

```bash
git add src/evals/baseline.ts src/evals/baseline.test.ts src/evals/evalRunner.ts src/types/reporter.ts src/reporters/ui-src/types.ts src/index.ts
git commit -m "feat(evals): add baseline eval comparison — save/load, delta pass rate, regressions (P1)"
```

---

## Task 7: Multi-Server A/B Comparison (P1)

**Why:** The core MCP eval use case is "Glean MCP vs. native MCP vs. GleanChat". This requires running the same dataset against two servers and comparing case by case. Currently requires two manual runs and no tooling to compare.

**Design:** `runServerComparison(options, contextA, contextB)` runs the same dataset against two MCP servers in parallel and returns a `ServerComparisonResult` with per-case winners, ties, overall win rates, and delta metrics.

**Files:**

- Create: `src/evals/serverComparison.ts` — `runServerComparison`, comparison types
- Modify: `src/index.ts` — export
- Create: `src/evals/serverComparison.test.ts`

---

### Step 1: Write failing tests

```typescript
// src/evals/serverComparison.test.ts
import { runServerComparison } from './serverComparison.js';

describe('runServerComparison', () => {
  it('returns A_WINS when server A passes and B fails', async () => {
    // Mock contexts where A succeeds and B fails
  });

  it('returns TIE when both pass', async () => {
    // Mock contexts where both succeed
  });

  it('returns B_WINS when server B passes and A fails', async () => {
    // Mock contexts where B succeeds and A fails
  });

  it('computes correct overall win rates', async () => {
    // A wins 2, B wins 1, tie 1 → A winRate 0.5, B winRate 0.25, tieRate 0.25
  });
});
```

Run: `npm test -- src/evals/serverComparison.test.ts`
Expected: FAIL — module not found

---

### Step 2: Create `src/evals/serverComparison.ts`

```typescript
import { runEvalDataset } from './evalRunner.js';
import type {
  EvalRunnerOptions,
  EvalContext,
  EvalRunnerResult,
} from './evalRunner.js';
import type { EvalCaseResult } from '../types/reporter.js';

export type ComparisonOutcome = 'A_WINS' | 'B_WINS' | 'TIE' | 'BOTH_FAIL';

export interface CaseComparisonResult {
  id: string;
  outcome: ComparisonOutcome;
  serverA: EvalCaseResult;
  serverB: EvalCaseResult;
}

export interface ServerComparisonResult {
  dataset: string;
  total: number;
  aWins: number;
  bWins: number;
  ties: number;
  bothFail: number;
  aWinRate: number;
  bWinRate: number;
  tieRate: number;
  cases: CaseComparisonResult[];
  serverAResult: EvalRunnerResult;
  serverBResult: EvalRunnerResult;
  durationMs: number;
}

export interface ServerComparisonOptions extends Omit<
  EvalRunnerOptions,
  'saveResultsTo' | 'baselineResultsFrom'
> {
  serverALabel?: string;
  serverBLabel?: string;
}

/**
 * Runs the same eval dataset against two MCP servers in parallel
 * and returns a detailed comparison of results.
 *
 * @example
 * const comparison = await runServerComparison(
 *   { dataset },
 *   { mcp: gleanMcpFixture },
 *   { mcp: nativeMcpFixture }
 * );
 * console.log(`Glean wins: ${comparison.aWinRate * 100}%`);
 */
export async function runServerComparison(
  options: ServerComparisonOptions,
  contextA: EvalContext,
  contextB: EvalContext
): Promise<ServerComparisonResult> {
  const startTime = Date.now();

  // Run both servers in parallel
  const [resultA, resultB] = await Promise.all([
    runEvalDataset(options, contextA),
    runEvalDataset(options, contextB),
  ]);

  // Build case ID → result maps
  const mapA = new Map(resultA.caseResults.map((r) => [r.id, r]));
  const mapB = new Map(resultB.caseResults.map((r) => [r.id, r]));

  const allIds = [...new Set([...mapA.keys(), ...mapB.keys()])];
  const cases: CaseComparisonResult[] = [];

  let aWins = 0,
    bWins = 0,
    ties = 0,
    bothFail = 0;

  for (const id of allIds) {
    const a = mapA.get(id);
    const b = mapB.get(id);

    if (!a || !b) continue; // skip cases not in both results

    let outcome: ComparisonOutcome;
    if (a.pass && b.pass) {
      outcome = 'TIE';
      ties++;
    } else if (a.pass && !b.pass) {
      outcome = 'A_WINS';
      aWins++;
    } else if (!a.pass && b.pass) {
      outcome = 'B_WINS';
      bWins++;
    } else {
      outcome = 'BOTH_FAIL';
      bothFail++;
    }

    cases.push({ id, outcome, serverA: a, serverB: b });
  }

  const total = cases.length;

  return {
    dataset: options.dataset.name,
    total,
    aWins,
    bWins,
    ties,
    bothFail,
    aWinRate: total > 0 ? aWins / total : 0,
    bWinRate: total > 0 ? bWins / total : 0,
    tieRate: total > 0 ? ties / total : 0,
    cases,
    serverAResult: resultA,
    serverBResult: resultB,
    durationMs: Date.now() - startTime,
  };
}
```

---

### Step 3: Export from `src/index.ts`

```typescript
export { runServerComparison } from './evals/serverComparison.js';
export type {
  ServerComparisonResult,
  CaseComparisonResult,
  ComparisonOutcome,
  ServerComparisonOptions,
} from './evals/serverComparison.js';
```

---

### Step 4: Run tests and typecheck

```bash
npm test
npm run typecheck
```

Expected: All pass.

---

### Step 5: Commit

```bash
git add src/evals/serverComparison.ts src/evals/serverComparison.test.ts src/index.ts
git commit -m "feat(evals): add runServerComparison for A/B multi-server eval (P1)"
```

---

## Execution Order & Parallelization Guide

**Sequential (shared files):** Run Tasks 1 → 2 → 3 → 4 in order. All touch `datasetTypes.ts`.

**Parallel after Task 1:** Tasks 5, 6, 7 each touch independent files. Once Task 1 lands, they can be executed concurrently by separate subagents:

- Subagent A: Task 5 (judge providers)
- Subagent B: Task 6 (baseline comparison)
- Subagent C: Task 7 (server comparison)

**Verification gate after each task:**

```bash
npm test && npm run typecheck
```

Never advance to the next task with a failing typecheck or test.

---

## Acceptance Criteria

The implementation is complete when:

- [ ] `EvalCase.judgeReps` accepted in JSON datasets; judge runs N times and averages
- [ ] `EvalCase.canonicalAnswer` accepted; passed as reference to judge automatically
- [ ] `passesJudge.rubric: 'correctness'` (and other built-ins) expand to full rubric text
- [ ] `EvalCase.tags` accepted; `filterTags` in runner options filters cases by tag
- [ ] `EvalCaseResult.toolPrecision` and `toolRecall` populated when `toolsTriggered` evaluated
- [ ] `createJudge({ provider: 'openai' })` works without error (given OPENAI_API_KEY)
- [ ] `createJudge({ provider: 'google' })` works without error (given GOOGLE_API_KEY)
- [ ] `runEvalDataset({ ..., saveResultsTo: 'baseline.json' })` saves results to file
- [ ] `runEvalDataset({ ..., baselineResultsFrom: 'baseline.json' })` loads baseline and populates `deltaPassRate`, `regressions`, `improvements`
- [ ] `runServerComparison(options, contextA, contextB)` runs dataset against two servers and returns win/loss/tie breakdown
- [ ] All new fields optional; zero breaking changes to existing API
- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
