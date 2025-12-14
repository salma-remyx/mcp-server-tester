import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import type { JudgeConfig } from '../judge/judgeTypes.js';
import type { EvalDataset, EvalCase, EvalExpectBlock } from './datasetTypes.js';
import type { TestInfo, Expect } from '@playwright/test';
import type { ZodType } from 'zod';
import { simulateLLMHost } from './llmHost/llmHostSimulation.js';
import type {
  AuthType,
  ResultSource,
  ExpectationType,
  EvalExpectationResult,
} from '../types/index.js';
import {
  validateResponse,
  validateSchema,
  validateText,
  validatePattern,
  validateError,
  validateSize,
} from '../assertions/validators/index.js';
import { createJudge } from '../judge/judgeClient.js';

/**
 * Context passed to the eval runner
 */
export interface EvalContext {
  /**
   * MCP fixture API for interacting with the server
   */
  mcp: MCPFixtureApi;

  /**
   * Optional Playwright TestInfo for reporter integration
   * When provided, eval results will be attached to the test for the MCP reporter
   */
  testInfo?: TestInfo;

  /**
   * Optional Playwright expect function for snapshot testing
   * Required for snapshot expectations to work properly
   */
  expect?: Expect;
}

export type { EvalExpectationResult } from '../types/index.js';

/**
 * Result of a single eval case
 */
export interface EvalCaseResult {
  /**
   * Case ID
   */
  id: string;

  /**
   * Dataset name this case belongs to
   */
  datasetName: string;

  /**
   * MCP tool name that was called
   */
  toolName: string;

  /**
   * Evaluation mode (direct or llm_host)
   * @deprecated Mode is inferred from test context, not displayed in reports
   */
  mode?: 'direct' | 'llm_host';

  /**
   * Source of this result
   * - 'eval': From runEvalDataset() using JSON eval datasets
   * - 'test': From direct API test tracking (MCP fixture calls)
   */
  source: ResultSource;

  /**
   * Overall pass/fail status
   */
  pass: boolean;

  /**
   * Tool response
   */
  response?: unknown;

  /**
   * Error if tool call failed
   */
  error?: string;

  /**
   * Expectation results
   */
  expectations: Partial<Record<ExpectationType, EvalExpectationResult>>;

  /**
   * Authentication type used for this test
   */
  authType?: AuthType;

  /**
   * Playwright project name this test belongs to
   * Used for filtering/grouping results by project in the reporter
   */
  project?: string;

  /**
   * Execution time in milliseconds
   */
  durationMs: number;
}

/**
 * Overall result of running an eval dataset
 */
export interface EvalRunnerResult {
  /**
   * Total number of cases
   */
  total: number;

  /**
   * Number of passing cases
   */
  passed: number;

  /**
   * Number of failing cases
   */
  failed: number;

  /**
   * Individual case results
   */
  caseResults: Array<EvalCaseResult>;

  /**
   * Overall execution time in milliseconds
   */
  durationMs: number;
}

/**
 * Options for running eval dataset
 */
export interface EvalRunnerOptions {
  /**
   * The dataset to run
   */
  dataset: EvalDataset;

  /**
   * Schema registry for schema validation by name
   *
   * Maps schema names to Zod schemas for use with expect.schema
   *
   * @example
   * ```typescript
   * {
   *   schemas: {
   *     WeatherResponse: z.object({ temperature: z.number() }),
   *     ErrorResponse: z.object({ error: z.string() }),
   *   }
   * }
   * ```
   */
  schemas?: Record<string, ZodType>;

  /**
   * Judge configuration registry by ID
   *
   * Maps config IDs to JudgeConfig for use with expect.passesJudge.configId
   */
  judgeConfigs?: Record<string, JudgeConfig>;

  /**
   * Whether to stop on first failure
   * @default false
   */
  stopOnFailure?: boolean;

  /**
   * Optional callback called after each case
   */
  onCaseComplete?: (result: EvalCaseResult) => void | Promise<void>;
}

/**
 * Options for running a single eval case
 */
export interface EvalCaseOptions {
  /**
   * Dataset name for the result (defaults to 'single-case')
   */
  datasetName?: string;

  /**
   * Schema registry for schema validation by name
   */
  schemas?: Record<string, ZodType>;

  /**
   * Judge configuration registry by ID
   */
  judgeConfigs?: Record<string, JudgeConfig>;
}

async function executeToolCall(
  evalCase: EvalCase,
  mcp: MCPFixtureApi
): Promise<{ response: unknown; error?: string }> {
  const mode = evalCase.mode || 'direct';

  try {
    if (mode === 'llm_host') {
      // LLM host simulation mode
      if (!evalCase.scenario) {
        throw new Error(
          `Eval case ${evalCase.id}: scenario is required for llm_host mode`
        );
      }

      if (!evalCase.llmHostConfig) {
        throw new Error(
          `Eval case ${evalCase.id}: llmHostConfig is required for llm_host mode`
        );
      }

      const simulationResult = await simulateLLMHost(
        mcp,
        evalCase.scenario,
        evalCase.llmHostConfig
      );

      if (!simulationResult.success) {
        throw new Error(simulationResult.error || 'LLM host simulation failed');
      }

      return { response: simulationResult };
    } else {
      // Direct mode - call tool directly
      if (!evalCase.toolName) {
        throw new Error(
          `Eval case ${evalCase.id}: toolName is required for direct mode`
        );
      }
      if (!evalCase.args) {
        throw new Error(
          `Eval case ${evalCase.id}: args is required for direct mode`
        );
      }

      const result = await mcp.callTool(evalCase.toolName, evalCase.args);

      // For error expectations, return the full result so isError can be checked
      // For other expectations, return the content (backwards compatible)
      if (evalCase.expect?.isError !== undefined) {
        return { response: result };
      }
      return { response: result.structuredContent ?? result.content };
    }
  } catch (err) {
    return {
      response: undefined,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Determines if a case passed based on error and expectation results
 */
function didCasePass(
  error: string | undefined,
  expectations: EvalCaseResult['expectations']
): boolean {
  return (
    !error &&
    Object.values(expectations).every(
      (result) => result === undefined || result.pass
    )
  );
}

/**
 * Configuration for processing expect blocks
 */
interface ExpectBlockConfig {
  schemas?: Record<string, ZodType>;
  judgeConfigs?: Record<string, JudgeConfig>;
  playwrightExpect?: Expect;
}

/**
 * Processes the new unified expect block using validators
 *
 * This function translates the expect block into validation results,
 * calling the appropriate validators for each field.
 */
async function runExpectBlockValidations(
  expectBlock: EvalExpectBlock,
  response: unknown,
  config: ExpectBlockConfig
): Promise<EvalCaseResult['expectations']> {
  const results: EvalCaseResult['expectations'] = {};

  // response (toMatchToolResponse)
  if (expectBlock.response !== undefined) {
    const validation = validateResponse(response, expectBlock.response);
    results.exact = {
      pass: validation.pass,
      details: validation.message,
    };
  }

  // schema (toMatchToolSchema)
  if (expectBlock.schema !== undefined) {
    const schema = config.schemas?.[expectBlock.schema];
    if (!schema) {
      results.schema = {
        pass: false,
        details: `Schema "${expectBlock.schema}" not found in schemas registry`,
      };
    } else {
      const validation = validateSchema(response, schema);
      results.schema = {
        pass: validation.pass,
        details: validation.message,
      };
    }
  }

  // containsText (toContainToolText)
  if (expectBlock.containsText !== undefined) {
    const validation = validateText(response, expectBlock.containsText);
    results.textContains = {
      pass: validation.pass,
      details: validation.message,
    };
  }

  // matchesPattern (toMatchToolPattern)
  if (expectBlock.matchesPattern !== undefined) {
    const validation = validatePattern(response, expectBlock.matchesPattern);
    results.regex = {
      pass: validation.pass,
      details: validation.message,
    };
  }

  // isError (toBeToolError)
  if (expectBlock.isError !== undefined) {
    const validation = validateError(response, expectBlock.isError);
    results.error = {
      pass: validation.pass,
      details: validation.message,
    };
  }

  // responseSize (toHaveToolResponseSize)
  if (expectBlock.responseSize !== undefined) {
    const validation = validateSize(response, expectBlock.responseSize);
    results.size = {
      pass: validation.pass,
      details: validation.message,
    };
  }

  // passesJudge (toPassToolJudge)
  if (expectBlock.passesJudge !== undefined) {
    const {
      rubric,
      reference,
      threshold = 0.7,
      configId,
    } = expectBlock.passesJudge;

    // Get judge config
    const judgeConfig = configId ? (config.judgeConfigs?.[configId] ?? {}) : {};

    try {
      const judge = createJudge(judgeConfig);
      const judgeResult = await judge.evaluate(
        response,
        reference ?? null,
        rubric
      );
      const score = judgeResult.score ?? (judgeResult.pass ? 1.0 : 0.0);
      const passed = score >= threshold;

      results.judge = {
        pass: passed,
        details: passed
          ? `Judge passed with score ${score.toFixed(2)}`
          : `Judge failed with score ${score.toFixed(2)} (threshold: ${threshold}). ${judgeResult.reasoning ?? ''}`,
      };
    } catch (err) {
      results.judge = {
        pass: false,
        details: `Judge evaluation error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // snapshot (toMatchToolSnapshot) - requires Playwright expect
  if (expectBlock.snapshot !== undefined) {
    if (!config.playwrightExpect) {
      results.snapshot = {
        pass: false,
        details: 'Snapshot testing requires expect in context',
      };
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/await-thenable
        await config
          .playwrightExpect(response)
          .toMatchSnapshot(expectBlock.snapshot);
        results.snapshot = {
          pass: true,
          details: `Matches snapshot "${expectBlock.snapshot}"`,
        };
      } catch (err) {
        results.snapshot = {
          pass: false,
          details: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  return results;
}

/**
 * Runs a single eval case and returns the result
 *
 * @param evalCase - The eval case to run
 * @param context - Context containing mcp, testInfo, expect
 * @param options - Optional configuration (datasetName, schemas, judgeConfigs)
 * @returns The result of running the eval case
 *
 * @example
 * ```typescript
 * const result = await runEvalCase(
 *   evalCase,
 *   { mcp, testInfo, expect },
 *   { schemas: { WeatherResponse: WeatherSchema } }
 * );
 *
 * expect(result.pass).toBe(true);
 * ```
 */
export async function runEvalCase(
  evalCase: EvalCase,
  context: EvalContext,
  options: EvalCaseOptions = {}
): Promise<EvalCaseResult> {
  const startTime = Date.now();
  const mode = evalCase.mode || 'direct';

  // Execute tool call
  const { response, error } = await executeToolCall(evalCase, context.mcp);

  // Collect expectation results from expect block
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

  // Build result - use test context for authType and project (Playwright is source of truth)
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

/**
 * Runs an eval dataset against an MCP server
 *
 * This function composes runEvalCase() for each case in the dataset,
 * adding dataset-level features like stopOnFailure and callbacks.
 *
 * @param options - Eval runner options (dataset, schemas, judgeConfigs)
 * @param context - Eval context (mcp fixture, optional testInfo, optional expect)
 * @returns Eval results
 *
 * @example
 * // Basic usage
 * const result = await runEvalDataset(
 *   {
 *     dataset,
 *     schemas: { WeatherResponse: WeatherSchema },
 *   },
 *   { mcp }
 * );
 *
 * @example
 * // With MCP reporter integration
 * test('eval dataset', async ({ mcp }, testInfo) => {
 *   const result = await runEvalDataset(
 *     { dataset },
 *     { mcp, testInfo }  // testInfo enables MCP reporter
 *   );
 * });
 */
export async function runEvalDataset(
  options: EvalRunnerOptions,
  context: EvalContext
): Promise<EvalRunnerResult> {
  const {
    dataset,
    schemas,
    judgeConfigs,
    stopOnFailure = false,
    onCaseComplete,
  } = options;

  const startTime = Date.now();
  const caseResults: EvalCaseResult[] = [];

  // Context is used as-is (judge is handled via judgeConfigs in expect block)
  const enrichedContext = context;

  // Merge schemas from dataset and options
  const allSchemas = {
    ...dataset.schemas,
    ...schemas,
  };

  // Run each case
  for (const evalCase of dataset.cases) {
    const result = await runEvalCase(evalCase, enrichedContext, {
      datasetName: dataset.name,
      schemas: allSchemas,
      judgeConfigs,
    });

    caseResults.push(result);

    // Call onCaseComplete callback
    if (onCaseComplete) {
      await onCaseComplete(result);
    }

    // Stop on failure if requested
    if (stopOnFailure && !result.pass) {
      break;
    }
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

  // Attach results for MCP reporter if testInfo is provided
  if (context.testInfo) {
    await context.testInfo.attach('mcp-test-results', {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ caseResults })),
    });
  }

  return result;
}
