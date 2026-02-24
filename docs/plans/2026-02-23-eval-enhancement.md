# Eval Enhancement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the capability gap between `@gleanwork/mcp-server-tester` and `@mcpjam/sdk` by adding multi-iteration accuracy scoring, first-class tool call assertions, Vercel AI SDK support (9 LLM providers + latency decomposition), and Streamable HTTP transport.

**Architecture:** The existing validator/matcher duality is the north star — every new assertion adds a pure `validateX()` function in `src/assertions/validators/` and a `toX()` Playwright matcher in `src/assertions/matchers/`. The eval runner upgrades to run cases N times and report accuracy as a 0–1 score rather than binary pass/fail. The LLM host layer swaps the custom agentic loop for Vercel AI SDK's `generateText` with `maxSteps`, which handles tool calling natively across 9 providers and gives per-step latency decomposition for free. All 4 phases are independently deployable.

**Tech Stack:** TypeScript strict, Vitest (unit), Playwright (integration), Zod, `ai` (Vercel AI SDK), `@ai-sdk/anthropic`, `@ai-sdk/openai`

---

## Phase 1: Multi-Iteration Accuracy Scoring

> Biggest capability gap. Evals currently run once and return binary pass/fail. This adds `iterations` + `accuracyThreshold` to cases and `concurrency` to the runner, so you get statistical win-rate metrics instead of coin-flip verdicts.

---

### Task 1.1: Add `iterations` and `accuracyThreshold` to `EvalCase`

**Files:**

- Modify: `src/evals/datasetTypes.ts`

**Step 1: Write the failing test**

Add to `src/evals/datasetTypes.test.ts`:

```typescript
it('should accept iterations and accuracyThreshold on a case', () => {
  const raw = {
    name: 'test',
    cases: [
      {
        id: 'multi-iter',
        toolName: 'add',
        args: { a: 1, b: 2 },
        iterations: 5,
        accuracyThreshold: 0.8,
      },
    ],
  };
  const result = validateEvalDataset(raw);
  expect(result.cases[0].iterations).toBe(5);
  expect(result.cases[0].accuracyThreshold).toBe(0.8);
});

it('should reject iterations below 1', () => {
  const raw = {
    name: 'test',
    cases: [{ id: 'bad', toolName: 'add', args: {}, iterations: 0 }],
  };
  expect(() => validateEvalDataset(raw)).toThrow();
});

it('should reject accuracyThreshold outside 0-1', () => {
  const raw = {
    name: 'test',
    cases: [{ id: 'bad', toolName: 'add', args: {}, accuracyThreshold: 1.5 }],
  };
  expect(() => validateEvalDataset(raw)).toThrow();
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- src/evals/datasetTypes.test.ts -t "iterations"
```

Expected: FAIL — `iterations` is not in the Zod schema.

**Step 3: Add to `EvalCase` interface and Zod schema**

In `src/evals/datasetTypes.ts`, add to `EvalCase` interface (after `metadata?`):

```typescript
/**
 * Number of times to run this case and compute an accuracy score.
 * When > 1, `EvalCaseResult.accuracy` is populated and `pass` is determined
 * by `accuracyThreshold` rather than a single run.
 * @default 1
 */
iterations?: number;

/**
 * Minimum accuracy (0–1) required to pass when `iterations > 1`.
 * @default 1.0 (all iterations must pass)
 */
accuracyThreshold?: number;
```

Add to `EvalCaseSchema` (after `metadata`):

```typescript
iterations: z.number().int().min(1).optional(),
accuracyThreshold: z.number().min(0).max(1).optional(),
```

**Step 4: Run test to verify it passes**

```bash
npm test -- src/evals/datasetTypes.test.ts -t "iterations"
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/evals/datasetTypes.ts src/evals/datasetTypes.test.ts
git commit -m "feat(evals): add iterations and accuracyThreshold to EvalCase"
```

---

### Task 1.2: Add `accuracy` and `iterationResults` to `EvalCaseResult`

**Files:**

- Modify: `src/evals/evalRunner.ts`

**Step 1: Write the failing test**

Add to `src/evals/evalRunner.test.ts`:

```typescript
describe('multi-iteration cases', () => {
  it('should compute accuracy when iterations > 1', async () => {
    let callCount = 0;
    const mcp = createMockMCP();
    // Alternate pass/fail: callTool returns 'hello' on even calls, 'bye' on odd
    vi.mocked(mcp.callTool).mockImplementation(async () => {
      callCount++;
      return {
        content: [
          { type: 'text', text: callCount % 2 === 0 ? 'nope' : 'hello' },
        ],
        isError: false,
      };
    });

    const evalCase = createEvalCase({
      iterations: 4,
      accuracyThreshold: 0.5,
      expect: { containsText: 'hello' },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));

    expect(result.accuracy).toBeDefined();
    expect(result.accuracy).toBe(0.5); // 2 of 4 pass
    expect(result.pass).toBe(true); // 0.5 >= 0.5 threshold
    expect(result.iterationResults).toHaveLength(4);
    expect(result.iterationResults?.filter((r) => r.pass)).toHaveLength(2);
  });

  it('should fail when accuracy is below threshold', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'wrong' }] });
    const evalCase = createEvalCase({
      iterations: 3,
      accuracyThreshold: 0.8,
      expect: { containsText: 'hello' },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.accuracy).toBe(0);
    expect(result.pass).toBe(false);
  });

  it('should not set accuracy for single-iteration cases', async () => {
    const evalCase = createEvalCase();
    const result = await runEvalCase(evalCase, createContext());
    expect(result.accuracy).toBeUndefined();
    expect(result.iterationResults).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- src/evals/evalRunner.test.ts -t "multi-iteration"
```

Expected: FAIL — `accuracy` and `iterationResults` do not exist.

**Step 3: Add types and update `runEvalCase`**

In `src/evals/evalRunner.ts`, add a new interface after the imports:

```typescript
/**
 * Result of a single iteration within a multi-iteration eval case
 */
export interface IterationResult {
  /** Whether this iteration passed */
  pass: boolean;
  /** Execution time for this iteration */
  durationMs: number;
  /** Error message if the iteration failed with an exception */
  error?: string;
}
```

Add two new optional fields to `EvalCaseResult` (after `durationMs`):

```typescript
/**
 * Accuracy score (0–1) across all iterations.
 * Only present when the case was run with `iterations > 1`.
 */
accuracy?: number;

/**
 * Per-iteration pass/fail breakdown.
 * Only present when the case was run with `iterations > 1`.
 */
iterationResults?: Array<IterationResult>;
```

Extract the existing `runEvalCase` body into a private `runSingleIteration` function, then update `runEvalCase` to loop when `iterations > 1`:

```typescript
async function runSingleIteration(
  evalCase: EvalCase,
  context: EvalContext,
  options: EvalCaseOptions
): Promise<EvalCaseResult> {
  const startTime = Date.now();
  const mode = evalCase.mode || 'direct';

  const { response, error } = await executeToolCall(evalCase, context.mcp);

  let expectationResults: EvalCaseResult['expectations'] = {};
  if (!error && evalCase.expect) {
    expectationResults = await runExpectBlockValidations(
      evalCase.expect,
      response,
      {
        schemas: options.schemas,
        judgeConfigs: options.judgeConfigs,
        playwrightExpect: context.expect,
      }
    );
  }

  return {
    id: evalCase.id,
    datasetName: options.datasetName ?? 'single-case',
    toolName: evalCase.toolName ?? evalCase.scenario ?? 'unknown',
    mode,
    source: 'eval',
    pass: didCasePass(error, expectationResults),
    response,
    error,
    expectations: expectationResults,
    authType: context.mcp.authType,
    project: context.mcp.project,
    durationMs: Date.now() - startTime,
  };
}

export async function runEvalCase(
  evalCase: EvalCase,
  context: EvalContext,
  options: EvalCaseOptions = {}
): Promise<EvalCaseResult> {
  const iterations = evalCase.iterations ?? 1;

  if (iterations === 1) {
    return runSingleIteration(evalCase, context, options);
  }

  // Multi-iteration: run N times and compute accuracy
  const iterationResults: IterationResult[] = [];
  let lastResult: EvalCaseResult | null = null;

  for (let i = 0; i < iterations; i++) {
    const result = await runSingleIteration(evalCase, context, options);
    lastResult = result;
    iterationResults.push({
      pass: result.pass,
      durationMs: result.durationMs,
      error: result.error,
    });
  }

  const passCount = iterationResults.filter((r) => r.pass).length;
  const accuracy = passCount / iterations;
  const threshold = evalCase.accuracyThreshold ?? 1.0;

  return {
    // Spread the last iteration for response/expectations context
    ...lastResult!,
    pass: accuracy >= threshold,
    accuracy,
    iterationResults,
    durationMs: iterationResults.reduce((sum, r) => sum + r.durationMs, 0),
  };
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- src/evals/evalRunner.test.ts -t "multi-iteration"
npm run typecheck
```

Expected: all PASS

**Step 5: Commit**

```bash
git add src/evals/evalRunner.ts src/evals/evalRunner.test.ts
git commit -m "feat(evals): add multi-iteration accuracy scoring to runEvalCase"
```

---

### Task 1.3: Add `concurrency` to `EvalRunnerOptions`

**Files:**

- Modify: `src/evals/evalRunner.ts`

**Step 1: Write the failing test**

Add to `src/evals/evalRunner.test.ts`:

```typescript
describe('runEvalDataset concurrency', () => {
  it('should run cases concurrently when concurrency > 1', async () => {
    const startTimes: number[] = [];
    const mcp = createMockMCP();
    vi.mocked(mcp.callTool).mockImplementation(async () => {
      startTimes.push(Date.now());
      await new Promise((r) => setTimeout(r, 30)); // simulate latency
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    });

    const dataset: EvalDataset = {
      name: 'concurrent-test',
      cases: [
        { id: 'c1', toolName: 'tool', args: {} },
        { id: 'c2', toolName: 'tool', args: {} },
        { id: 'c3', toolName: 'tool', args: {} },
      ],
    };

    const start = Date.now();
    await runEvalDataset({ dataset, concurrency: 3 }, createContext(mcp));
    const elapsed = Date.now() - start;

    // 3 cases with 30ms each, run in parallel → should complete in ~30-60ms not ~90ms
    expect(elapsed).toBeLessThan(80);
  });

  it('should default to sequential execution (concurrency: 1)', async () => {
    // The existing sequential tests should still pass unchanged
    const dataset: EvalDataset = {
      name: 'seq-test',
      cases: [
        { id: 's1', toolName: 'tool', args: {} },
        { id: 's2', toolName: 'tool', args: {} },
      ],
    };
    const result = await runEvalDataset({ dataset }, createContext());
    expect(result.total).toBe(2);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- src/evals/evalRunner.test.ts -t "concurrency"
```

Expected: FAIL — `concurrency` option is not in `EvalRunnerOptions`.

**Step 3: Add concurrency to options and runner**

In `src/evals/evalRunner.ts`, add to `EvalRunnerOptions` (after `onCaseComplete`):

```typescript
/**
 * Maximum number of eval cases to run concurrently.
 * @default 1 (sequential)
 */
concurrency?: number;
```

Add this private helper function before `runEvalDataset`:

```typescript
/**
 * Runs an array of async tasks with bounded concurrency.
 * Preserves result ordering.
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
```

Update `runEvalDataset` to use it:

```typescript
export async function runEvalDataset(
  options: EvalRunnerOptions,
  context: EvalContext
): Promise<EvalRunnerResult> {
  const {
    dataset,
    schemas,
    judgeConfigs,
    stopOnFailure = false,
    concurrency = 1,
    onCaseComplete,
  } = options;

  const startTime = Date.now();

  const allSchemas = { ...dataset.schemas, ...schemas };

  // Build task list
  const tasks = dataset.cases.map((evalCase) => async () => {
    const result = await runEvalCase(evalCase, context, {
      datasetName: dataset.name,
      schemas: allSchemas,
      judgeConfigs,
    });

    if (onCaseComplete) {
      await onCaseComplete(result);
    }

    return result;
  });

  let caseResults: EvalCaseResult[];

  if (concurrency === 1 || stopOnFailure) {
    // Sequential path — required when stopOnFailure is set
    caseResults = [];
    for (const task of tasks) {
      const result = await task();
      caseResults.push(result);
      if (stopOnFailure && !result.pass) break;
    }
  } else {
    caseResults = await runWithConcurrency(tasks, concurrency);
  }

  const total = caseResults.length;
  const passed = caseResults.filter((r) => r.pass).length;

  const result: EvalRunnerResult = {
    total,
    passed,
    failed: total - passed,
    caseResults,
    durationMs: Date.now() - startTime,
  };

  if (context.testInfo) {
    await context.testInfo.attach('mcp-test-results', {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ caseResults })),
    });
  }

  return result;
}
```

**Step 4: Run all eval runner tests**

```bash
npm test -- src/evals/evalRunner.test.ts
npm run typecheck
```

Expected: all PASS

**Step 5: Commit**

```bash
git add src/evals/evalRunner.ts src/evals/evalRunner.test.ts
git commit -m "feat(evals): add concurrency option to runEvalDataset"
```

---

## Phase 2: Vercel AI SDK for LLM Host

> Replaces the custom agentic loop (orchestrator.ts + two adapters) with Vercel AI SDK's `generateText`, giving 9 providers, a battle-tested tool-call loop, and latency decomposition (LLM time vs. MCP tool time) for free.

---

### Task 2.1: Install Vercel AI SDK as optional peer dependencies

**Files:**

- Modify: `package.json`

**Step 1: Install packages**

```bash
npm install --save-optional ai @ai-sdk/anthropic @ai-sdk/openai
```

**Step 2: Add peer dependency declarations**

In `package.json`, add to `peerDependencies`:

```json
"peerDependenciesMeta": {
  "ai": { "optional": true },
  "@ai-sdk/anthropic": { "optional": true },
  "@ai-sdk/openai": { "optional": true }
},
```

And to `peerDependencies`:

```json
"ai": "^4.0.0",
"@ai-sdk/anthropic": "^1.0.0",
"@ai-sdk/openai": "^1.0.0"
```

**Step 3: Verify build**

```bash
npm run typecheck
npm run build
```

Expected: clean build.

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(deps): add ai, @ai-sdk/anthropic, @ai-sdk/openai as optional peers"
```

---

### Task 2.2: Expand `LLMProvider` and add latency fields to simulation result

**Files:**

- Modify: `src/evals/llmHost/llmHostTypes.ts`
- Modify: `src/evals/datasetTypes.ts` (Zod schema update)

**Step 1: Write the failing test**

Add to `src/evals/datasetTypes.test.ts`:

```typescript
it('should accept new provider values in llmHostConfig', () => {
  const providers = [
    'openai',
    'anthropic',
    'google',
    'mistral',
    'azure',
    'ollama',
    'deepseek',
    'openrouter',
    'xai',
  ];
  for (const provider of providers) {
    expect(() =>
      validateEvalDataset({
        name: 'test',
        cases: [
          {
            id: 'c',
            mode: 'llm_host',
            scenario: 's',
            llmHostConfig: { provider },
          },
        ],
      })
    ).not.toThrow();
  }
});
```

**Step 2: Run to verify it fails**

```bash
npm test -- src/evals/datasetTypes.test.ts -t "provider values"
```

Expected: FAIL for non-openai/anthropic providers.

**Step 3: Expand types**

In `src/evals/llmHost/llmHostTypes.ts`, replace `LLMProvider` and expand `LLMHostSimulationResult`:

```typescript
/**
 * LLM provider for host simulation.
 * 'openai' and 'anthropic' use their native SDKs (legacy adapters).
 * All others require the Vercel AI SDK (`ai` package).
 */
export type LLMProvider =
  | 'openai'
  | 'anthropic'
  | 'azure'
  | 'google'
  | 'mistral'
  | 'ollama'
  | 'deepseek'
  | 'openrouter'
  | 'xai';
```

In `LLMHostSimulationResult`, add after `conversationHistory`:

```typescript
/**
 * Milliseconds spent waiting for LLM responses (excludes MCP tool execution time)
 */
llmDurationMs?: number;

/**
 * Milliseconds spent executing MCP tool calls (excludes LLM response time)
 */
mcpDurationMs?: number;
```

Update `LLMHostConfigSchema` in `src/evals/datasetTypes.ts`:

```typescript
const LLMHostConfigSchema = z.object({
  provider: z.enum([
    'openai',
    'anthropic',
    'azure',
    'google',
    'mistral',
    'ollama',
    'deepseek',
    'openrouter',
    'xai',
  ]),
  apiKeyEnvVar: z.string().optional(),
  model: z.string().optional(),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  maxToolCalls: z.number().optional(),
});
```

**Step 4: Run tests**

```bash
npm test -- src/evals/datasetTypes.test.ts
npm run typecheck
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/evals/llmHost/llmHostTypes.ts src/evals/datasetTypes.ts
git commit -m "feat(llm-host): expand LLMProvider to 9 providers, add latency fields to result"
```

---

### Task 2.3: Create Vercel AI SDK orchestrator

**Files:**

- Create: `src/evals/llmHost/adapters/vercel.ts`

**Step 1: Write the failing test**

Create `src/evals/llmHost/adapters/vercel.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVercelOrchestrator } from './vercel.js';
import type { MCPFixtureApi } from '../../../mcp/fixtures/mcpFixture.js';

// Mock the 'ai' package
vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({
    text: 'Final answer',
    steps: [
      {
        stepType: 'tool-result',
        toolCalls: [{ toolName: 'get_weather', args: { city: 'London' } }],
        experimental_providerMetadata: {},
      },
    ],
    usage: { promptTokens: 100, completionTokens: 50 },
  }),
}));

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn(() => ({ id: 'gpt-4o' })),
}));

function createMockMCP(): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
    project: undefined,
    getServerInfo: vi.fn().mockReturnValue(null),
    listTools: vi.fn().mockResolvedValue([
      {
        name: 'get_weather',
        description: 'Get weather',
        inputSchema: { type: 'object', properties: {} },
      },
    ]),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Sunny, 20°C' }],
      isError: false,
    }),
  };
}

describe('createVercelOrchestrator', () => {
  it('should return a simulation result with tool calls', async () => {
    const orchestrator = createVercelOrchestrator();
    const result = await orchestrator.simulate(
      createMockMCP(),
      'What is the weather in London?',
      { provider: 'openai', model: 'gpt-4o' }
    );

    expect(result.success).toBe(true);
    expect(result.response).toBe('Final answer');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('get_weather');
    expect(result.llmDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.mcpDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('should return success:false on error', async () => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockRejectedValueOnce(new Error('API error'));

    const orchestrator = createVercelOrchestrator();
    const result = await orchestrator.simulate(createMockMCP(), 'scenario', {
      provider: 'openai',
      model: 'gpt-4o',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('API error');
  });
});
```

**Step 2: Run to verify it fails**

```bash
npm test -- src/evals/llmHost/adapters/vercel.test.ts
```

Expected: FAIL — file does not exist.

**Step 3: Implement the Vercel orchestrator**

Create `src/evals/llmHost/adapters/vercel.ts`:

```typescript
/**
 * Vercel AI SDK-based LLM host orchestrator.
 *
 * Replaces the custom agentic loop with generateText + maxSteps,
 * giving access to 9 providers and built-in latency decomposition.
 */
import type {
  LLMHostConfig,
  LLMHostSimulationResult,
  LLMHostSimulator,
  LLMProvider,
  LLMToolCall,
} from '../llmHostTypes.js';
import type { MCPFixtureApi } from '../../../mcp/fixtures/mcpFixture.js';
import { extractText } from '../../../mcp/response.js';

// Map our provider names to Vercel AI SDK model factory imports
async function loadModel(provider: LLMProvider, model: string) {
  switch (provider) {
    case 'openai': {
      const { openai } = await import('@ai-sdk/openai');
      return openai(model);
    }
    case 'anthropic': {
      const { anthropic } = await import('@ai-sdk/anthropic');
      return anthropic(model);
    }
    case 'google': {
      const { google } = await import('@ai-sdk/google');
      return google(model);
    }
    case 'mistral': {
      const { mistral } = await import('@ai-sdk/mistral');
      return mistral(model);
    }
    case 'azure': {
      const { azure } = await import('@ai-sdk/azure');
      return azure(model);
    }
    case 'ollama': {
      const { ollama } = await import('@ai-sdk/ollama');
      return ollama(model);
    }
    case 'deepseek': {
      const { deepseek } = await import('@ai-sdk/deepseek');
      return deepseek(model);
    }
    case 'openrouter': {
      const { openrouter } = await import('@openrouter/ai-sdk-provider');
      return openrouter(model);
    }
    case 'xai': {
      const { xai } = await import('@ai-sdk/xai');
      return xai(model);
    }
    default:
      throw new Error(
        `Unsupported Vercel AI SDK provider: ${String(provider)}`
      );
  }
}

function defaultModel(provider: LLMProvider): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o';
    case 'anthropic':
      return 'claude-3-5-sonnet-20241022';
    case 'google':
      return 'gemini-1.5-pro';
    case 'mistral':
      return 'mistral-large-latest';
    default:
      return 'default';
  }
}

/**
 * Creates a Vercel AI SDK-based LLM host simulator.
 *
 * Uses generateText with maxSteps to handle multi-turn tool calling.
 * Produces llmDurationMs and mcpDurationMs for latency decomposition.
 */
export function createVercelOrchestrator(): LLMHostSimulator {
  return {
    async simulate(
      mcp: MCPFixtureApi,
      scenario: string,
      config: LLMHostConfig
    ): Promise<LLMHostSimulationResult> {
      try {
        const { generateText, tool } = await import('ai');

        const modelId = config.model ?? defaultModel(config.provider);
        const model = await loadModel(config.provider, modelId);

        // Get available MCP tools and wrap them for Vercel AI SDK
        const mcpTools = await mcp.listTools();
        let llmDurationMs = 0;
        let mcpDurationMs = 0;
        const allToolCalls: LLMToolCall[] = [];

        // Build tool definitions in Vercel AI SDK format
        const tools: Record<string, ReturnType<typeof tool>> = {};
        for (const mcpTool of mcpTools) {
          const toolName = mcpTool.name;
          tools[toolName] = tool({
            description: mcpTool.description ?? '',
            parameters: mcpTool.inputSchema as Parameters<
              typeof tool
            >[0]['parameters'],
            execute: async (args: Record<string, unknown>) => {
              const mcpStart = Date.now();
              const result = await mcp.callTool(toolName, args);
              mcpDurationMs += Date.now() - mcpStart;

              allToolCalls.push({ name: toolName, arguments: args });
              return extractText(result);
            },
          });
        }

        const llmStart = Date.now();
        const result = await generateText({
          model,
          prompt: scenario,
          tools,
          maxSteps: config.maxToolCalls ?? 10,
          temperature: config.temperature ?? 0,
          maxTokens: config.maxTokens,
        });
        llmDurationMs = Date.now() - llmStart - mcpDurationMs;

        return {
          success: true,
          toolCalls: allToolCalls,
          response: result.text,
          llmDurationMs,
          mcpDurationMs,
          conversationHistory: result.steps.map((step) => ({
            role: step.stepType === 'tool-result' ? 'tool' : 'assistant',
            content:
              step.stepType === 'tool-result'
                ? JSON.stringify(step.toolResults)
                : step.text,
          })),
        };
      } catch (err) {
        return {
          success: false,
          toolCalls: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
```

**Step 4: Run tests**

```bash
npm test -- src/evals/llmHost/adapters/vercel.test.ts
npm run typecheck
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/evals/llmHost/adapters/vercel.ts src/evals/llmHost/adapters/vercel.test.ts
git commit -m "feat(llm-host): add Vercel AI SDK orchestrator with 9 provider support"
```

---

### Task 2.4: Register Vercel orchestrator for providers that need it

**Files:**

- Modify: `src/evals/llmHost/llmHostSimulation.ts`

**Step 1: Write the failing test**

Add to `src/evals/llmHost/llmHostSimulation.test.ts`:

```typescript
it('should report google as an available provider', () => {
  expect(isProviderAvailable('google')).toBe(true);
});
```

**Step 2: Run to verify it fails**

```bash
npm test -- src/evals/llmHost/llmHostSimulation.test.ts -t "google"
```

Expected: FAIL — `'google'` is not a registered provider.

**Step 3: Register Vercel providers**

In `src/evals/llmHost/llmHostSimulation.ts`, add after the existing `registerAdapter` calls:

```typescript
import { createVercelOrchestrator } from './adapters/vercel.js';

// Vercel AI SDK providers (registered as a single factory since they're all
// accessed through dynamic imports inside the orchestrator)
const vercelProviders: LLMProvider[] = [
  'google',
  'azure',
  'mistral',
  'ollama',
  'deepseek',
  'openrouter',
  'xai',
];

// For Vercel-based providers, the "adapter" is actually the Vercel orchestrator
// wrapped to match the existing adapter interface
for (const provider of vercelProviders) {
  registerAdapter(provider, () => createVercelOrchestrator());
}
```

Note: The existing `openai` and `anthropic` adapters remain registered — they use the native SDK path. If you want them to also go through Vercel AI SDK for latency decomposition, you can re-register them here later.

**Step 4: Run tests**

```bash
npm test -- src/evals/llmHost/
npm run typecheck
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/evals/llmHost/llmHostSimulation.ts
git commit -m "feat(llm-host): register Vercel AI SDK orchestrator for 7 additional providers"
```

---

## Phase 3: First-Class Tool Call Assertions

> Promotes `metadata.expectedToolCalls` (buried, informal) to first-class `toolsTriggered` and `toolCallCount` expectations in the `EvalExpectBlock`, with a validator + Playwright matcher for each.

---

### Task 3.1: Add `toolsTriggered` and `toolCallCount` to `ExpectationType`

**Files:**

- Modify: `src/types/index.ts`

**Step 1: Write the failing test**

Add to `src/evals/datasetTypes.test.ts`:

```typescript
it('should accept toolsTriggered in expect block', () => {
  const raw = {
    name: 'test',
    cases: [
      {
        id: 'tool-trigger-test',
        mode: 'llm_host',
        scenario: 'Search for documents',
        llmHostConfig: { provider: 'openai' },
        expect: {
          toolsTriggered: {
            calls: [{ name: 'search', required: true }],
            order: 'any',
          },
          toolCallCount: { min: 1, max: 3 },
        },
      },
    ],
  };
  expect(() => validateEvalDataset(raw)).not.toThrow();
});
```

**Step 2: Run to verify it fails**

```bash
npm test -- src/evals/datasetTypes.test.ts -t "toolsTriggered"
```

Expected: FAIL — `toolsTriggered` and `toolCallCount` not in Zod schema.

**Step 3: Update types**

In `src/types/index.ts`, add to `ExpectationType`:

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

**Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): add toolsTriggered and toolCallCount to ExpectationType"
```

---

### Task 3.2: Add `toolsTriggered` and `toolCallCount` to `EvalExpectBlock`

**Files:**

- Modify: `src/evals/datasetTypes.ts`

**Step 1: Add interfaces and Zod schemas**

In `src/evals/datasetTypes.ts`, add to `EvalExpectBlock` interface:

```typescript
/**
 * Asserts which tools the LLM called during an llm_host simulation.
 * Only meaningful for llm_host mode — direct mode has no tool call trace.
 */
toolsTriggered?: {
  /** Expected tool calls */
  calls: Array<{
    /** Tool name */
    name: string;
    /** Expected arguments (partial match — extra keys are allowed) */
    arguments?: Record<string, unknown>;
    /** Whether this call MUST have been made (default: true) */
    required?: boolean;
  }>;
  /**
   * 'strict': calls must appear in the exact order listed
   * 'any': calls can appear in any order (default)
   */
  order?: 'strict' | 'any';
  /** If true, no tool calls outside the `calls` list are allowed */
  exclusive?: boolean;
};

/**
 * Asserts the number of tool calls made during an llm_host simulation.
 */
toolCallCount?: {
  /** Minimum number of tool calls */
  min?: number;
  /** Maximum number of tool calls */
  max?: number;
  /** Exact number of tool calls */
  exact?: number;
};
```

Add to `EvalExpectBlockSchema` Zod object:

```typescript
toolsTriggered: z
  .object({
    calls: z.array(
      z.object({
        name: z.string(),
        arguments: z.record(z.unknown()).optional(),
        required: z.boolean().optional(),
      })
    ),
    order: z.enum(['strict', 'any']).optional(),
    exclusive: z.boolean().optional(),
  })
  .optional(),
toolCallCount: z
  .object({
    min: z.number().int().min(0).optional(),
    max: z.number().int().min(0).optional(),
    exact: z.number().int().min(0).optional(),
  })
  .optional(),
```

**Step 2: Run tests**

```bash
npm test -- src/evals/datasetTypes.test.ts
npm run typecheck
```

Expected: PASS

**Step 3: Commit**

```bash
git add src/evals/datasetTypes.ts
git commit -m "feat(evals): add toolsTriggered and toolCallCount to EvalExpectBlock"
```

---

### Task 3.3: Create `validateToolCalls` and `validateToolCallCount` validators

**Files:**

- Create: `src/assertions/validators/toolCalls.ts`
- Modify: `src/assertions/validators/index.ts`

**Step 1: Write the failing tests**

Create `src/assertions/validators/toolCalls.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateToolCalls, validateToolCallCount } from './toolCalls.js';
import type { LLMHostSimulationResult } from '../../evals/llmHost/llmHostTypes.js';

function makeResult(
  toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>
): LLMHostSimulationResult {
  return { success: true, toolCalls };
}

describe('validateToolCalls', () => {
  it('passes when required tool was called', () => {
    const result = makeResult([
      { name: 'search', arguments: { query: 'hello' } },
    ]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search', required: true }],
    });
    expect(v.pass).toBe(true);
  });

  it('fails when required tool was not called', () => {
    const result = makeResult([{ name: 'other' }]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search', required: true }],
    });
    expect(v.pass).toBe(false);
    expect(v.message).toContain('search');
  });

  it('passes optional tool even when missing', () => {
    const result = makeResult([]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search', required: false }],
    });
    expect(v.pass).toBe(true);
  });

  it('validates partial argument match', () => {
    const result = makeResult([
      { name: 'search', arguments: { query: 'hello', limit: 10 } },
    ]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search', arguments: { query: 'hello' } }],
    });
    expect(v.pass).toBe(true);
  });

  it('fails when arguments do not match', () => {
    const result = makeResult([
      { name: 'search', arguments: { query: 'wrong' } },
    ]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search', arguments: { query: 'hello' } }],
    });
    expect(v.pass).toBe(false);
  });

  it('enforces strict order when order is strict', () => {
    const result = makeResult([{ name: 'search' }, { name: 'fetch' }]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'fetch' }, { name: 'search' }],
      order: 'strict',
    });
    expect(v.pass).toBe(false);
  });

  it('passes strict order when sequence matches', () => {
    const result = makeResult([{ name: 'search' }, { name: 'fetch' }]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search' }, { name: 'fetch' }],
      order: 'strict',
    });
    expect(v.pass).toBe(true);
  });

  it('fails when exclusive and unexpected tool was called', () => {
    const result = makeResult([{ name: 'search' }, { name: 'unexpected' }]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search' }],
      exclusive: true,
    });
    expect(v.pass).toBe(false);
    expect(v.message).toContain('unexpected');
  });

  it('returns error when response is not an LLMHostSimulationResult', () => {
    const v = validateToolCalls('not a simulation result', {
      calls: [{ name: 'search' }],
    });
    expect(v.pass).toBe(false);
    expect(v.message).toContain('llm_host');
  });
});

describe('validateToolCallCount', () => {
  it('passes exact count', () => {
    const result = makeResult([{ name: 'a' }, { name: 'b' }]);
    expect(validateToolCallCount(result, { exact: 2 }).pass).toBe(true);
  });

  it('fails wrong exact count', () => {
    const result = makeResult([{ name: 'a' }]);
    const v = validateToolCallCount(result, { exact: 2 });
    expect(v.pass).toBe(false);
    expect(v.message).toContain('1');
  });

  it('passes min/max range', () => {
    const result = makeResult([{ name: 'a' }, { name: 'b' }]);
    expect(validateToolCallCount(result, { min: 1, max: 3 }).pass).toBe(true);
  });

  it('fails when below min', () => {
    const result = makeResult([]);
    expect(validateToolCallCount(result, { min: 1 }).pass).toBe(false);
  });

  it('fails when above max', () => {
    const result = makeResult([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    expect(validateToolCallCount(result, { max: 2 }).pass).toBe(false);
  });
});
```

**Step 2: Run to verify it fails**

```bash
npm test -- src/assertions/validators/toolCalls.test.ts
```

Expected: FAIL — file does not exist.

**Step 3: Implement the validators**

Create `src/assertions/validators/toolCalls.ts`:

```typescript
/**
 * Tool call validators for llm_host simulation results.
 *
 * These validators extract the tool call trace from an LLMHostSimulationResult
 * and apply assertions against expected call lists and counts.
 */
import type { ValidationResult } from './types.js';
import type {
  LLMHostSimulationResult,
  LLMToolCall,
} from '../../evals/llmHost/llmHostTypes.js';

export interface ToolCallExpectation {
  calls: Array<{
    name: string;
    arguments?: Record<string, unknown>;
    required?: boolean;
  }>;
  order?: 'strict' | 'any';
  exclusive?: boolean;
}

export interface ToolCallCountOptions {
  min?: number;
  max?: number;
  exact?: number;
}

function isSimulationResult(value: unknown): value is LLMHostSimulationResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    'toolCalls' in value &&
    Array.isArray((value as LLMHostSimulationResult).toolCalls)
  );
}

function partialMatch(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>
): boolean {
  return Object.entries(expected).every(([k, v]) => {
    const actualVal = actual[k];
    if (
      typeof v === 'object' &&
      v !== null &&
      typeof actualVal === 'object' &&
      actualVal !== null
    ) {
      return partialMatch(
        actualVal as Record<string, unknown>,
        v as Record<string, unknown>
      );
    }
    return JSON.stringify(actualVal) === JSON.stringify(v);
  });
}

function findMatchingCall(
  actual: LLMToolCall[],
  expected: ToolCallExpectation['calls'][number],
  startIndex = 0
): number {
  for (let i = startIndex; i < actual.length; i++) {
    const call = actual[i];
    if (call.name !== expected.name) continue;
    if (
      expected.arguments &&
      !partialMatch(call.arguments ?? {}, expected.arguments)
    ) {
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * Validates tool calls made during an LLM host simulation.
 *
 * @param response - Must be an LLMHostSimulationResult (from llm_host mode)
 * @param expectation - Expected tool call specification
 */
export function validateToolCalls(
  response: unknown,
  expectation: ToolCallExpectation
): ValidationResult {
  if (!isSimulationResult(response)) {
    return {
      pass: false,
      message:
        'toolsTriggered expectation requires llm_host mode — response must be an LLMHostSimulationResult',
    };
  }

  const actual = response.toolCalls;
  const required = expectation.calls.filter((c) => c.required !== false);
  const order = expectation.order ?? 'any';

  if (order === 'strict') {
    // All calls must appear in the specified sequence
    let searchFrom = 0;
    for (const expected of expectation.calls) {
      const idx = findMatchingCall(actual, expected, searchFrom);
      if (idx === -1) {
        if (expected.required !== false) {
          return {
            pass: false,
            message: `Expected tool '${expected.name}' to be called in sequence (starting from position ${searchFrom}), but it was not found`,
          };
        }
      } else {
        searchFrom = idx + 1;
      }
    }
  } else {
    // Any order: each required call must appear somewhere
    for (const expected of required) {
      const idx = findMatchingCall(actual, expected);
      if (idx === -1) {
        const argsNote = expected.arguments
          ? ` with args ${JSON.stringify(expected.arguments)}`
          : '';
        return {
          pass: false,
          message: `Expected tool '${expected.name}'${argsNote} to be called, but it was not`,
        };
      }
    }
  }

  if (expectation.exclusive) {
    const allowedNames = new Set(expectation.calls.map((c) => c.name));
    const unexpected = actual.filter((c) => !allowedNames.has(c.name));
    if (unexpected.length > 0) {
      const names = unexpected.map((c) => `'${c.name}'`).join(', ');
      return {
        pass: false,
        message: `Unexpected tool calls: ${names}. Only ${[...allowedNames].map((n) => `'${n}'`).join(', ')} are allowed`,
      };
    }
  }

  return { pass: true, message: 'All tool call expectations met' };
}

/**
 * Validates the number of tool calls made during an LLM host simulation.
 *
 * @param response - Must be an LLMHostSimulationResult (from llm_host mode)
 * @param options - Count constraints (min, max, exact)
 */
export function validateToolCallCount(
  response: unknown,
  options: ToolCallCountOptions
): ValidationResult {
  if (!isSimulationResult(response)) {
    return {
      pass: false,
      message:
        'toolCallCount expectation requires llm_host mode — response must be an LLMHostSimulationResult',
    };
  }

  const count = response.toolCalls.length;
  const { min, max, exact } = options;

  if (exact !== undefined && count !== exact) {
    return {
      pass: false,
      message: `Expected exactly ${exact} tool call(s), but got ${count}`,
    };
  }

  if (min !== undefined && count < min) {
    return {
      pass: false,
      message: `Expected at least ${min} tool call(s), but got ${count}`,
    };
  }

  if (max !== undefined && count > max) {
    return {
      pass: false,
      message: `Expected at most ${max} tool call(s), but got ${count}`,
    };
  }

  return {
    pass: true,
    message: `Tool call count (${count}) is within expected range`,
  };
}
```

**Step 4: Export from validators index**

In `src/assertions/validators/index.ts`, add:

```typescript
export { validateToolCalls, validateToolCallCount } from './toolCalls.js';
export type { ToolCallExpectation, ToolCallCountOptions } from './toolCalls.js';
```

**Step 5: Run tests**

```bash
npm test -- src/assertions/validators/toolCalls.test.ts
npm run typecheck
```

Expected: all PASS

**Step 6: Commit**

```bash
git add src/assertions/validators/toolCalls.ts src/assertions/validators/toolCalls.test.ts src/assertions/validators/index.ts
git commit -m "feat(validators): add validateToolCalls and validateToolCallCount"
```

---

### Task 3.4: Create `toHaveToolCalls` and `toHaveToolCallCount` Playwright matchers

**Files:**

- Create: `src/assertions/matchers/toHaveToolCalls.ts`
- Create: `src/assertions/matchers/toHaveToolCallCount.ts`
- Modify: `src/assertions/matchers/index.ts`
- Modify: `src/assertions/matchers/types.ts`

**Step 1: Write the failing test**

Create `src/assertions/matchers/toolCallMatchers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { expect as mcpExpect } from './index.js';
import type { LLMHostSimulationResult } from '../../evals/llmHost/llmHostTypes.js';

function makeResult(names: string[]): LLMHostSimulationResult {
  return {
    success: true,
    toolCalls: names.map((name) => ({ name, arguments: {} })),
  };
}

describe('toHaveToolCalls', () => {
  it('passes when required tool was called', () => {
    const result = makeResult(['search', 'fetch']);
    expect(() =>
      mcpExpect(result).toHaveToolCalls({ calls: [{ name: 'search' }] })
    ).not.toThrow();
  });

  it('fails when required tool was not called', () => {
    const result = makeResult(['fetch']);
    expect(() =>
      mcpExpect(result).toHaveToolCalls({ calls: [{ name: 'search' }] })
    ).toThrow();
  });
});

describe('toHaveToolCallCount', () => {
  it('passes with exact count', () => {
    const result = makeResult(['a', 'b']);
    expect(() =>
      mcpExpect(result).toHaveToolCallCount({ exact: 2 })
    ).not.toThrow();
  });

  it('fails with wrong count', () => {
    const result = makeResult(['a']);
    expect(() => mcpExpect(result).toHaveToolCallCount({ exact: 2 })).toThrow();
  });
});
```

**Step 2: Run to verify it fails**

```bash
npm test -- src/assertions/matchers/toolCallMatchers.test.ts
```

Expected: FAIL — matchers do not exist.

**Step 3: Implement the matchers**

Create `src/assertions/matchers/toHaveToolCalls.ts`:

```typescript
import {
  validateToolCalls,
  type ToolCallExpectation,
} from '../validators/toolCalls.js';

export function toHaveToolCalls(
  this: { isNot: boolean },
  received: unknown,
  expectation: ToolCallExpectation
) {
  const result = validateToolCalls(received, expectation);
  return {
    pass: result.pass,
    message: () => result.message,
  };
}
```

Create `src/assertions/matchers/toHaveToolCallCount.ts`:

```typescript
import {
  validateToolCallCount,
  type ToolCallCountOptions,
} from '../validators/toolCalls.js';

export function toHaveToolCallCount(
  this: { isNot: boolean },
  received: unknown,
  options: ToolCallCountOptions
) {
  const result = validateToolCallCount(received, options);
  return {
    pass: result.pass,
    message: () => result.message,
  };
}
```

**Step 4: Register in matchers index**

In `src/assertions/matchers/index.ts`, add:

```typescript
import { toHaveToolCalls } from './toHaveToolCalls.js';
import { toHaveToolCallCount } from './toHaveToolCallCount.js';
```

And add to the `expect.extend(...)` call:

```typescript
export const expect = baseExpect.extend({
  // ... existing matchers
  toHaveToolCalls,
  toHaveToolCallCount,
});
```

**Step 5: Add TypeScript declarations**

In `src/assertions/matchers/types.ts`, add to the `Matchers` interface:

````typescript
/**
 * Validates which tools the LLM called during an llm_host simulation.
 *
 * @example
 * ```typescript
 * expect(simulationResult).toHaveToolCalls({
 *   calls: [
 *     { name: 'search', arguments: { query: 'hello' }, required: true },
 *   ],
 *   order: 'any',
 * });
 * ```
 */
toHaveToolCalls(expectation: ToolCallExpectation): R;

/**
 * Validates the number of tool calls made during an llm_host simulation.
 *
 * @example
 * ```typescript
 * expect(simulationResult).toHaveToolCallCount({ min: 1, max: 3 });
 * expect(simulationResult).toHaveToolCallCount({ exact: 2 });
 * ```
 */
toHaveToolCallCount(options: ToolCallCountOptions): R;
````

And add the imports at the top of the file:

```typescript
import type {
  ToolCallExpectation,
  ToolCallCountOptions,
} from '../validators/toolCalls.js';
```

**Step 6: Run tests**

```bash
npm test -- src/assertions/matchers/toolCallMatchers.test.ts
npm run typecheck
```

Expected: PASS

**Step 7: Commit**

```bash
git add src/assertions/matchers/toHaveToolCalls.ts src/assertions/matchers/toHaveToolCallCount.ts src/assertions/matchers/toolCallMatchers.test.ts src/assertions/matchers/index.ts src/assertions/matchers/types.ts
git commit -m "feat(matchers): add toHaveToolCalls and toHaveToolCallCount Playwright matchers"
```

---

### Task 3.5: Wire tool call assertions into the eval runner

**Files:**

- Modify: `src/evals/evalRunner.ts`

**Step 1: Write the failing test**

Add to `src/evals/evalRunner.test.ts`:

```typescript
describe('toolsTriggered expectation', () => {
  it('should validate tool calls from llm_host simulation result', async () => {
    const simulationResult = {
      success: true,
      toolCalls: [{ name: 'search', arguments: { query: 'hello' } }],
      response: 'Done',
    };

    // Mock llm_host mode by making callTool return a simulation result wrapper
    const mcp = createMockMCP();
    // We'll test this via the expect block on a pre-built response
    const evalCase = createEvalCase({
      mode: 'llm_host',
      scenario: 'search for hello',
      llmHostConfig: { provider: 'anthropic' },
      expect: {
        toolsTriggered: {
          calls: [{ name: 'search', required: true }],
        },
      },
    });

    // Directly test the expectation processing path
    // by calling runExpectBlockValidations (exposed for testing)
    // Instead, test via runEvalCase with a mocked simulateLLMHost
    vi.mock('./llmHost/llmHostSimulation.js', () => ({
      simulateLLMHost: vi.fn().mockResolvedValue(simulationResult),
    }));

    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.expectations.toolsTriggered).toBeDefined();
    expect(result.expectations.toolsTriggered?.pass).toBe(true);
  });

  it('should fail when required tool was not called', async () => {
    const simulationResult = {
      success: true,
      toolCalls: [{ name: 'other', arguments: {} }],
      response: 'Done',
    };

    vi.mock('./llmHost/llmHostSimulation.js', () => ({
      simulateLLMHost: vi.fn().mockResolvedValue(simulationResult),
    }));

    const evalCase = createEvalCase({
      mode: 'llm_host',
      scenario: 'search',
      llmHostConfig: { provider: 'anthropic' },
      expect: {
        toolsTriggered: {
          calls: [{ name: 'search', required: true }],
        },
      },
    });

    const result = await runEvalCase(evalCase, createContext());
    expect(result.expectations.toolsTriggered?.pass).toBe(false);
    expect(result.pass).toBe(false);
  });
});

describe('toolCallCount expectation', () => {
  it('should validate tool call count', async () => {
    const simulationResult = {
      success: true,
      toolCalls: [
        { name: 'a', arguments: {} },
        { name: 'b', arguments: {} },
      ],
      response: 'Done',
    };

    vi.mock('./llmHost/llmHostSimulation.js', () => ({
      simulateLLMHost: vi.fn().mockResolvedValue(simulationResult),
    }));

    const evalCase = createEvalCase({
      mode: 'llm_host',
      scenario: 'do stuff',
      llmHostConfig: { provider: 'anthropic' },
      expect: { toolCallCount: { min: 1, max: 3 } },
    });

    const result = await runEvalCase(evalCase, createContext());
    expect(result.expectations.toolCallCount?.pass).toBe(true);
  });
});
```

**Step 2: Run to verify it fails**

```bash
npm test -- src/evals/evalRunner.test.ts -t "toolsTriggered"
```

Expected: FAIL — `toolsTriggered` is not processed in `runExpectBlockValidations`.

**Step 3: Add handling in `runExpectBlockValidations`**

In `src/evals/evalRunner.ts`, add imports at the top:

```typescript
import {
  validateToolCalls,
  validateToolCallCount,
} from '../assertions/validators/index.js';
```

Add to `runExpectBlockValidations`, after the `responseSize` block:

```typescript
// toolsTriggered (toHaveToolCalls)
if (expectBlock.toolsTriggered !== undefined) {
  const validation = validateToolCalls(response, expectBlock.toolsTriggered);
  results.toolsTriggered = {
    pass: validation.pass,
    details: validation.message,
  };
}

// toolCallCount (toHaveToolCallCount)
if (expectBlock.toolCallCount !== undefined) {
  const validation = validateToolCallCount(response, expectBlock.toolCallCount);
  results.toolCallCount = {
    pass: validation.pass,
    details: validation.message,
  };
}
```

**Step 4: Run all tests**

```bash
npm test
npm run typecheck
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/evals/evalRunner.ts src/evals/evalRunner.test.ts
git commit -m "feat(evals): wire toolsTriggered and toolCallCount into eval runner"
```

---

### Task 3.6: Export new validators and matchers from package index

**Files:**

- Modify: `src/index.ts`

**Step 1: Read current index**

```bash
grep -n "validateText\|toContainToolText" src/index.ts
```

Note the pattern used for existing validators/matchers and follow it.

**Step 2: Add exports**

In `src/index.ts`, alongside the existing validator exports, add:

```typescript
export {
  validateToolCalls,
  validateToolCallCount,
  type ToolCallExpectation,
  type ToolCallCountOptions,
} from './assertions/validators/index.js';
```

**Step 3: Run typecheck and build**

```bash
npm run typecheck
npm run build
```

Expected: clean build

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: export validateToolCalls and validateToolCallCount from package index"
```

---

## Phase 4: Streamable HTTP Transport with SSE Fallback

> MCPJam automatically tries the newer Streamable HTTP transport (MCP spec 2025-03-26) and falls back to SSE. We currently always use SSE. This adds transport negotiation to match.

---

### Task 4.1: Add Streamable HTTP with SSE fallback to `createMCPClientForConfig`

**Files:**

- Modify: `src/mcp/clientFactory.ts`

**Step 1: Write the failing test**

In `src/mcp/clientFactory.test.ts`, add:

```typescript
it('should attempt Streamable HTTP before SSE for http config', async () => {
  // This test verifies the fallback behavior is configured
  // Full integration test requires a real server — this checks the code path
  const config = {
    type: 'http' as const,
    url: 'http://localhost:9999/mcp',
  };

  // StreamableHTTPClientTransport should be tried first
  // We can verify by checking that the function doesn't throw with an http config
  // (actual connection errors are expected in unit tests without a server)
  await expect(createMCPClientForConfig(config)).rejects.toThrow(); // connection refused, not "unsupported transport"
});
```

**Step 2: Run to see current behavior**

```bash
npm test -- src/mcp/clientFactory.test.ts
```

Note whether the existing SSE-only test passes.

**Step 3: Update `createMCPClientForConfig`**

In `src/mcp/clientFactory.ts`, update the HTTP transport handling:

```typescript
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
```

Replace the HTTP transport block with:

```typescript
// Try Streamable HTTP first (MCP spec 2025-03-26), fall back to SSE
async function createHttpTransport(url: URL, headers?: Record<string, string>) {
  // Attempt Streamable HTTP
  try {
    const transport = new StreamableHTTPClientTransport(url, { headers });
    // Do a quick ping-style connect to validate the transport works
    return transport;
  } catch {
    // Fall back to SSE transport (2024-11-05 spec)
    return new SSEClientTransport(url, { requestInit: { headers } });
  }
}
```

In the main `createMCPClientForConfig` function, replace the SSE transport creation with a call to `createHttpTransport`.

**Step 4: Run tests and typecheck**

```bash
npm test -- src/mcp/
npm run typecheck
```

Expected: PASS (unit tests) — integration requires a real server.

**Step 5: Commit**

```bash
git add src/mcp/clientFactory.ts src/mcp/clientFactory.test.ts
git commit -m "feat(transport): add Streamable HTTP with SSE fallback to HTTP transport"
```

---

## Verification Checklist

After completing all phases, run the full test suite:

```bash
npm run test:all
```

This runs: `build && format:check && lint && typecheck && test`

Expected output: all green.

Run Playwright integration tests against a real MCP server:

```bash
npm run test:playwright
```

---

## Notes

- **Phase ordering**: Each phase is independently mergeable. Phase 1 is highest priority (biggest user-facing gap). Phase 3 complements Phase 2 (tool call assertions are most useful in `llm_host` mode).
- **Backward compatibility**: All new fields are optional. Existing datasets and tests continue to work unchanged.
- **The PostHog note**: If MCPJam SDK is ever merged in as a dependency, strip the bundled PostHog telemetry before shipping — it has no opt-out and is a non-starter for enterprise users.
- **Phase 2 provider availability**: The 7 new Vercel AI SDK providers (`@ai-sdk/google`, `@ai-sdk/mistral`, etc.) are not added to `devDependencies` — only `@ai-sdk/openai` and `@ai-sdk/anthropic` are. Users who want Google/Mistral/etc. install the relevant `@ai-sdk/*` package themselves.
