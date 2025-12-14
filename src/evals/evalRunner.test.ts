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
