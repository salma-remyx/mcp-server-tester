import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { runEvalCase, runEvalDataset, type EvalContext } from './evalRunner.js';
import type { EvalCase, EvalDataset } from './datasetTypes.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';

function createMockMCP(callToolResponse?: {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
    project: 'test-project',
    getServerInfo: vi.fn().mockReturnValue({ name: 'test', version: '1.0.0' }),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({
      content: callToolResponse?.content ?? [
        { type: 'text', text: 'response' },
      ],
      structuredContent: callToolResponse?.structuredContent,
      isError: callToolResponse?.isError ?? false,
    }),
  };
}

function createContext(mcp?: MCPFixtureApi): EvalContext {
  return {
    mcp: mcp ?? createMockMCP(),
  };
}

function createEvalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'test-case',
    toolName: 'test-tool',
    args: { input: 'test' },
    ...overrides,
  };
}

describe('runEvalCase', () => {
  describe('direct mode', () => {
    it('should call tool and return result', async () => {
      const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
      const context = createContext(mcp);
      const evalCase = createEvalCase();

      const result = await runEvalCase(evalCase, context);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mcp.callTool).toHaveBeenCalledWith('test-tool', { input: 'test' });
      expect(result.id).toBe('test-case');
      expect(result.toolName).toBe('test-tool');
      expect(result.mode).toBe('direct');
      expect(result.source).toBe('eval');
      expect(result.response).toBeDefined();
    });

    it('should use structuredContent when available', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'fallback' }],
        structuredContent: { data: 'structured' },
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase();

      const result = await runEvalCase(evalCase, context);

      expect(result.response).toEqual({ data: 'structured' });
    });

    it('should pass when no expect block is provided', async () => {
      const context = createContext();
      const evalCase = createEvalCase();

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(true);
    });

    it('should pass when expect.containsText matches', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'hello world' }],
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: { containsText: 'hello' },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(true);
      expect(result.expectations.textContains?.pass).toBe(true);
    });

    it('should fail when expect.containsText does not match', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'hello world' }],
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: { containsText: 'goodbye' },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(false);
      expect(result.expectations.textContains?.pass).toBe(false);
    });

    it('should validate with expect.schema when schema is provided', async () => {
      const mcp = createMockMCP({
        structuredContent: { name: 'test', age: 25 },
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: { schema: 'PersonSchema' },
      });

      const PersonSchema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const result = await runEvalCase(evalCase, context, {
        schemas: { PersonSchema },
      });

      expect(result.pass).toBe(true);
      expect(result.expectations.schema?.pass).toBe(true);
    });

    it('should fail when expect.schema validation fails', async () => {
      const mcp = createMockMCP({
        structuredContent: { name: 'test', age: 'not-a-number' },
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: { schema: 'PersonSchema' },
      });

      const PersonSchema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const result = await runEvalCase(evalCase, context, {
        schemas: { PersonSchema },
      });

      expect(result.pass).toBe(false);
      expect(result.expectations.schema?.pass).toBe(false);
    });

    it('should fail when schema is not found in registry', async () => {
      const mcp = createMockMCP({
        structuredContent: { data: 'test' },
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: { schema: 'MissingSchema' },
      });

      const result = await runEvalCase(evalCase, context, { schemas: {} });

      expect(result.pass).toBe(false);
      expect(result.expectations.schema?.details).toContain('not found');
    });

    it('should validate expect.matchesPattern', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'Order #12345 confirmed' }],
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: { matchesPattern: '#\\d+' },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(true);
      expect(result.expectations.regex?.pass).toBe(true);
    });

    it('should validate expect.isError for error responses', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'Error: something went wrong' }],
        isError: true,
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: { isError: true },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(true);
      expect(result.expectations.error?.pass).toBe(true);
    });

    it('should validate expect.response for exact match', async () => {
      const mcp = createMockMCP({
        structuredContent: { status: 'ok', count: 42 },
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: { response: { status: 'ok', count: 42 } },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(true);
      expect(result.expectations.exact?.pass).toBe(true);
    });

    it('should validate multiple expectations together', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'Order #12345 confirmed for John' }],
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: {
          containsText: ['Order', 'John'],
          matchesPattern: '#\\d+',
        },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(true);
      expect(result.expectations.textContains?.pass).toBe(true);
      expect(result.expectations.regex?.pass).toBe(true);
    });

    it('should fail if any expectation fails', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'Order confirmed' }],
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: {
          containsText: 'Order',
          matchesPattern: '#\\d+', // This will fail - no order number
        },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(false);
      expect(result.expectations.textContains?.pass).toBe(true);
      expect(result.expectations.regex?.pass).toBe(false);
    });

    it('should fail when toolName is missing', async () => {
      const context = createContext();
      const evalCase = createEvalCase({ toolName: undefined });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(false);
      expect(result.error).toContain('toolName is required');
    });

    it('should fail when args are missing', async () => {
      const context = createContext();
      const evalCase = createEvalCase({ args: undefined });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(false);
      expect(result.error).toContain('args is required');
    });

    it('should track duration', async () => {
      const context = createContext();
      const evalCase = createEvalCase();

      const result = await runEvalCase(evalCase, context);

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should use provided datasetName', async () => {
      const context = createContext();
      const evalCase = createEvalCase();

      const result = await runEvalCase(evalCase, context, {
        datasetName: 'my-dataset',
      });

      expect(result.datasetName).toBe('my-dataset');
    });

    it('should default datasetName to single-case', async () => {
      const context = createContext();
      const evalCase = createEvalCase();

      const result = await runEvalCase(evalCase, context);

      expect(result.datasetName).toBe('single-case');
    });

    it('should not run expectations when tool call errors', async () => {
      const mcp = createMockMCP();
      (mcp.callTool as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Tool failed')
      );

      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: { containsText: 'hello' },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.error).toContain('Tool failed');
      expect(result.pass).toBe(false);
      // Expectations should be empty since tool call failed
      expect(result.expectations.textContains).toBeUndefined();
    });
  });

  describe('llm_host mode', () => {
    it('should fail when scenario is missing', async () => {
      const context = createContext();
      const evalCase = createEvalCase({
        mode: 'llm_host',
        scenario: undefined,
        llmHostConfig: { provider: 'openai', model: 'gpt-4' },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(false);
      expect(result.error).toContain('scenario is required');
    });

    it('should fail when llmHostConfig is missing', async () => {
      const context = createContext();
      const evalCase = createEvalCase({
        mode: 'llm_host',
        scenario: 'test scenario',
        llmHostConfig: undefined,
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(false);
      expect(result.error).toContain('llmHostConfig is required');
    });
  });
});

describe('multi-iteration cases', () => {
  it('should compute accuracy when iterations > 1', async () => {
    let callCount = 0;
    const mcp = createMockMCP();
    // Alternate pass/fail: callTool returns 'hello' on odd calls, 'nope' on even
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

describe('toolsTriggered and toolCallCount expectations in eval runner', () => {
  it('populates toolsTriggered expectation result when simulation result contains expected tool', async () => {
    // A structuredContent that matches LLMHostSimulationResult shape is recognized by the validator
    const simulationResult = {
      success: true,
      toolCalls: [{ name: 'search', arguments: { query: 'hello' } }],
      response: 'Done',
    };

    const mcp = createMockMCP({ structuredContent: simulationResult });
    const evalCase = createEvalCase({
      expect: {
        toolsTriggered: {
          calls: [{ name: 'search', required: true }],
        },
      },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.expectations.toolsTriggered).toBeDefined();
    expect(result.expectations.toolsTriggered?.pass).toBe(true);
  });

  it('fails toolsTriggered when required tool was not called', async () => {
    const simulationResult = {
      success: true,
      toolCalls: [{ name: 'other', arguments: {} }],
      response: 'Done',
    };

    const mcp = createMockMCP({ structuredContent: simulationResult });
    const evalCase = createEvalCase({
      expect: {
        toolsTriggered: {
          calls: [{ name: 'search', required: true }],
        },
      },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.expectations.toolsTriggered?.pass).toBe(false);
    expect(result.pass).toBe(false);
  });

  it('fails toolsTriggered with informative message when response is not a simulation', async () => {
    // A plain text response is not a simulation result
    const mcp = createMockMCP({
      content: [{ type: 'text', text: 'plain text' }],
    });

    const evalCase = createEvalCase({
      expect: { toolsTriggered: { calls: [{ name: 'search' }] } },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.expectations.toolsTriggered?.pass).toBe(false);
    expect(result.expectations.toolsTriggered?.details).toContain('llm_host');
  });

  it('validates toolCallCount correctly from simulation result', async () => {
    const simulationResult = {
      success: true,
      toolCalls: [
        { name: 'a', arguments: {} },
        { name: 'b', arguments: {} },
      ],
      response: 'Done',
    };

    const mcp = createMockMCP({ structuredContent: simulationResult });
    const evalCase = createEvalCase({
      expect: { toolCallCount: { min: 1, max: 3 } },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.expectations.toolCallCount?.pass).toBe(true);
  });
});

describe('runEvalDataset concurrency', () => {
  function createDataset(cases: EvalCase[]): EvalDataset {
    return { name: 'test-dataset', cases };
  }

  it('should run cases concurrently when concurrency > 1', async () => {
    const startTimes: number[] = [];
    const mcp = createMockMCP();
    vi.mocked(mcp.callTool).mockImplementation(async () => {
      startTimes.push(Date.now());
      await new Promise((r) => setTimeout(r, 30)); // simulate latency
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    });

    const dataset = createDataset([
      createEvalCase({ id: 'c1' }),
      createEvalCase({ id: 'c2' }),
      createEvalCase({ id: 'c3' }),
    ]);

    const start = Date.now();
    await runEvalDataset({ dataset, concurrency: 3 }, createContext(mcp));
    const elapsed = Date.now() - start;

    // 3 cases with 30ms each, run in parallel → should complete in ~30-60ms not ~90ms
    expect(elapsed).toBeLessThan(80);
  });

  it('should default to sequential execution (concurrency: 1)', async () => {
    const dataset = createDataset([
      createEvalCase({ id: 's1' }),
      createEvalCase({ id: 's2' }),
    ]);
    const result = await runEvalDataset({ dataset }, createContext());
    expect(result.total).toBe(2);
  });
});

describe('runEvalDataset', () => {
  function createDataset(cases: EvalCase[]): EvalDataset {
    return {
      name: 'test-dataset',
      cases,
    };
  }

  it('should run all cases in dataset', async () => {
    const context = createContext();
    const dataset = createDataset([
      createEvalCase({ id: 'case-1' }),
      createEvalCase({ id: 'case-2' }),
      createEvalCase({ id: 'case-3' }),
    ]);

    const result = await runEvalDataset({ dataset }, context);

    expect(result.total).toBe(3);
    expect(result.caseResults).toHaveLength(3);
    expect(result.caseResults[0]!.id).toBe('case-1');
    expect(result.caseResults[1]!.id).toBe('case-2');
    expect(result.caseResults[2]!.id).toBe('case-3');
  });

  it('should count passed and failed cases', async () => {
    const mcp = createMockMCP({
      content: [{ type: 'text', text: 'hello world' }],
    });
    const context = createContext(mcp);
    const dataset = createDataset([
      createEvalCase({ id: 'case-1', expect: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-2', expect: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-3', expect: { containsText: 'goodbye' } }), // fails
    ]);

    const result = await runEvalDataset({ dataset }, context);

    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
  });

  it('should set datasetName on all results', async () => {
    const context = createContext();
    const dataset = createDataset([
      createEvalCase({ id: 'case-1' }),
      createEvalCase({ id: 'case-2' }),
    ]);
    dataset.name = 'my-dataset';

    const result = await runEvalDataset({ dataset }, context);

    expect(result.caseResults[0]!.datasetName).toBe('my-dataset');
    expect(result.caseResults[1]!.datasetName).toBe('my-dataset');
  });

  it('should call onCaseComplete callback', async () => {
    const context = createContext();
    const dataset = createDataset([
      createEvalCase({ id: 'case-1' }),
      createEvalCase({ id: 'case-2' }),
    ]);
    const onCaseComplete = vi.fn();

    await runEvalDataset({ dataset, onCaseComplete }, context);

    expect(onCaseComplete).toHaveBeenCalledTimes(2);
    // onCaseComplete receives EvalCaseResult, not EvalCase
    expect(onCaseComplete.mock.calls[0]![0].id).toBe('case-1');
    expect(onCaseComplete.mock.calls[1]![0].id).toBe('case-2');
  });

  it('should stop on failure when stopOnFailure is true', async () => {
    const mcp = createMockMCP({
      content: [{ type: 'text', text: 'hello' }],
    });
    const context = createContext(mcp);
    const dataset = createDataset([
      createEvalCase({ id: 'case-1', expect: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-2', expect: { containsText: 'goodbye' } }), // fails
      createEvalCase({ id: 'case-3', expect: { containsText: 'hello' } }),
    ]);

    const result = await runEvalDataset(
      { dataset, stopOnFailure: true },
      context
    );

    expect(result.total).toBe(2); // Only ran 2 cases
    expect(result.caseResults).toHaveLength(2);
    expect(result.caseResults[0]!.id).toBe('case-1');
    expect(result.caseResults[1]!.id).toBe('case-2');
  });

  it('should continue on failure when stopOnFailure is false', async () => {
    const mcp = createMockMCP({
      content: [{ type: 'text', text: 'hello' }],
    });
    const context = createContext(mcp);
    const dataset = createDataset([
      createEvalCase({ id: 'case-1', expect: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-2', expect: { containsText: 'goodbye' } }), // fails
      createEvalCase({ id: 'case-3', expect: { containsText: 'hello' } }),
    ]);

    const result = await runEvalDataset(
      { dataset, stopOnFailure: false },
      context
    );

    expect(result.total).toBe(3); // Ran all 3 cases
    expect(result.caseResults).toHaveLength(3);
  });

  it('should track total duration', async () => {
    const context = createContext();
    const dataset = createDataset([createEvalCase()]);

    const result = await runEvalDataset({ dataset }, context);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should attach results when testInfo is provided', async () => {
    const mockTestInfo = {
      attach: vi.fn().mockResolvedValue(undefined),
    };
    const context = createContext();
    context.testInfo = mockTestInfo as unknown as EvalContext['testInfo'];

    const dataset = createDataset([createEvalCase()]);

    await runEvalDataset({ dataset }, context);

    expect(mockTestInfo.attach).toHaveBeenCalledWith('mcp-test-results', {
      contentType: 'application/json',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      body: expect.any(Buffer),
    });
  });

  it('should merge schemas from dataset and options', async () => {
    const mcp = createMockMCP({
      structuredContent: { name: 'test' },
    });
    const context = createContext(mcp);

    const DatasetSchema = z.object({ name: z.string() });
    const OptionsSchema = z.object({ count: z.number() });

    const dataset = createDataset([
      createEvalCase({ id: 'case-1', expect: { schema: 'DatasetSchema' } }),
    ]);
    dataset.schemas = { DatasetSchema };

    const result = await runEvalDataset(
      { dataset, schemas: { OptionsSchema } },
      context
    );

    // Dataset schema should work
    expect(result.caseResults[0]!.pass).toBe(true);
  });
});
