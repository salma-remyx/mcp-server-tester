import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EvalContext } from './evalRunner.js';
import type { EvalCase } from './datasetTypes.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';

/**
 * Integration coverage for the `judgeConsensus` option, exercised end-to-end
 * through the public `runEvalCase` entry point with `validateJudge` spied on
 * (the same pattern used by the existing multi-judge tests in evalRunner.test.ts).
 * This proves the eval runner's multi-judge branch now consults the consensus
 * aggregator instead of a hard-coded all-must-pass rule.
 */

function createMockMCP(): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
    project: 'test-project',
    getServerInfo: vi.fn().mockReturnValue({ name: 'test', version: '1.0.0' }),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'response' }],
      isError: false,
    }),
  };
}

function createContext(mcp: MCPFixtureApi): EvalContext {
  return {
    mcp,
    // Stub testInfo so runEvalCase skips reporter attachment without a real
    // Playwright context.
    testInfo: {
      attach: vi.fn().mockResolvedValue(undefined),
    } as unknown as EvalContext['testInfo'],
  };
}

function createEvalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'consensus-case',
    toolName: 'test-tool',
    args: { input: 'test' },
    ...overrides,
  };
}

/** Spies on validateJudge so the first `passCount` calls pass and the rest fail. */
async function mockJudges(passCount: number) {
  const judgeModule = await import('../assertions/validators/judge.js');
  let call = 0;
  vi.spyOn(judgeModule, 'validateJudge').mockImplementation(async () => {
    call++;
    const pass = call <= passCount;
    return {
      pass,
      message: pass ? 'Judge passed' : 'Judge failed',
      details: {
        score: pass ? 0.9 : 0.4,
        reasoning: pass ? 'Good' : 'Bad',
        judgeProvider: 'anthropic',
        judgeModel: 'claude-sonnet',
      },
    };
  });
}

describe('judgeConsensus in the eval runner', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('defaults to unanimity: 2 of 3 judges passing still fails (legacy behavior)', async () => {
    const { runEvalCase } = await import('./evalRunner.js');
    await mockJudges(2);

    const evalCase = createEvalCase({
      expect: {
        passesJudge: [
          { rubric: 'correctness', threshold: 0.7 },
          { rubric: 'completeness', threshold: 0.7 },
          { rubric: 'groundedness', threshold: 0.7 },
        ],
      },
    });

    const result = await runEvalCase(evalCase, createContext(createMockMCP()));

    expect(result.expectations.judge).toBeDefined();
    expect(result.expectations.judge!.pass).toBe(false);
    expect(result.expectations.judge!.judgeResults).toHaveLength(3);
    // Default path keeps the bare legacy summary.
    expect(result.expectations.judge!.details).toBe('2/3 judges passed');
    expect(result.pass).toBe(false);

    vi.restoreAllMocks();
  });

  it('passes under majority consensus when more than half agree (2 of 3)', async () => {
    const { runEvalCase } = await import('./evalRunner.js');
    await mockJudges(2);

    const evalCase = createEvalCase({
      expect: {
        passesJudge: [
          { rubric: 'correctness', threshold: 0.7 },
          { rubric: 'completeness', threshold: 0.7 },
          { rubric: 'groundedness', threshold: 0.7 },
        ],
        judgeConsensus: { mode: 'majority' },
      },
    });

    const result = await runEvalCase(evalCase, createContext(createMockMCP()));

    expect(result.expectations.judge!.pass).toBe(true);
    expect(result.expectations.judge!.details).toContain('2/3');
    expect(result.expectations.judge!.details).toContain('threshold');
    expect(result.pass).toBe(true);

    vi.restoreAllMocks();
  });

  it('honours a numeric minPassFraction (1 of 2 passes at 0.5)', async () => {
    const { runEvalCase } = await import('./evalRunner.js');
    await mockJudges(1);

    const evalCase = createEvalCase({
      expect: {
        passesJudge: [
          { rubric: 'correctness', threshold: 0.7 },
          { rubric: 'completeness', threshold: 0.7 },
        ],
        judgeConsensus: { minPassFraction: 0.5 },
      },
    });

    const result = await runEvalCase(evalCase, createContext(createMockMCP()));

    expect(result.expectations.judge!.pass).toBe(true);
    expect(result.expectations.judge!.details).toContain('1/2');
    expect(result.expectations.judge!.details).toContain('threshold');

    vi.restoreAllMocks();
  });

  it('validates judgeConsensus via the dataset Zod schema', async () => {
    const { validateEvalCase } = await import('./datasetTypes.js');
    const parsed = validateEvalCase({
      id: 'schema-case',
      toolName: 't',
      args: {},
      expect: {
        passesJudge: [{ rubric: 'correctness' }],
        judgeConsensus: { mode: 'majority', minPassFraction: 0.6 },
      },
    });
    expect(parsed.expect?.judgeConsensus).toEqual({
      mode: 'majority',
      minPassFraction: 0.6,
    });
  });
});
