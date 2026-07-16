import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EvalCase, JudgeExpectConfig } from './datasetTypes.js';
import type { EvalContext } from './evalRunner.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import { planJudgeBudget } from '../judge/budgetAllocator.js';

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

function createContext(): EvalContext {
  return {
    mcp: createMockMCP(),
    testInfo: {
      attach: vi.fn().mockResolvedValue(undefined),
    } as unknown as EvalContext['testInfo'],
  };
}

function createEvalCase(overrides: Partial<EvalCase>): EvalCase {
  return {
    id: 'budget-case',
    toolName: 'test-tool',
    args: { input: 'test' },
    ...overrides,
  };
}

describe('evalRunner budget-aware judge allocation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('routes budget-aware reps into validateJudge when maxBudgetUsd is set', async () => {
    const { runEvalCase } = await import('./evalRunner.js');
    const judgeModule = await import('../assertions/validators/judge.js');

    const capturedReps: number[] = [];
    vi.spyOn(judgeModule, 'validateJudge').mockImplementation(
      async (_response, cfg) => {
        capturedReps.push(cfg.reps ?? 0);
        return {
          pass: true,
          message: 'Judge passed with score 0.90',
          details: { score: 0.9, judgeProvider: 'anthropic' },
        };
      }
    );

    const cheapJudge: JudgeExpectConfig = {
      rubric: 'correctness',
      reps: 5,
      maxBudgetUsd: 0.015,
    };
    const strongJudge: JudgeExpectConfig = {
      rubric: 'completeness',
      reps: 2,
      maxBudgetUsd: 0.015,
    };

    const evalCase = createEvalCase({
      expect: { passesJudge: [cheapJudge, strongJudge] },
    });

    await runEvalCase(evalCase, createContext());

    // The call site derives a shared per-query budget (min of the set
    // maxBudgetUsd values) and feeds planJudgeBudget; the reps passed to
    // validateJudge must match that plan exactly.
    const expected = planJudgeBudget({
      judges: [cheapJudge, strongJudge],
      defaultReps: 1,
      budgetUsd: 0.015,
    });
    expect(capturedReps).toEqual(expected.reps);
    expect(expected.reallocated).toBe(true);
    // Budget pressure capped total reps below the 7 requested (5 + 2),
    // without dropping either judge below one rep.
    expect(capturedReps[0]! + capturedReps[1]!).toBeLessThan(7);
    expect(capturedReps.every((r) => r >= 1)).toBe(true);
  });

  it('preserves each judge own reps when no budget is set (no behavior change)', async () => {
    const { runEvalCase } = await import('./evalRunner.js');
    const judgeModule = await import('../assertions/validators/judge.js');

    const capturedReps: number[] = [];
    vi.spyOn(judgeModule, 'validateJudge').mockImplementation(
      async (_response, cfg) => {
        capturedReps.push(cfg.reps ?? 0);
        return {
          pass: true,
          message: 'Judge passed',
          details: { score: 0.9, judgeProvider: 'anthropic' },
        };
      }
    );

    const evalCase = createEvalCase({
      expect: {
        passesJudge: [
          { rubric: 'correctness', reps: 3 },
          { rubric: 'completeness' },
        ],
      },
    });

    await runEvalCase(evalCase, createContext());

    // No maxBudgetUsd -> identity plan: explicit reps honored, default 1 otherwise.
    expect(capturedReps).toEqual([3, 1]);
  });
});
