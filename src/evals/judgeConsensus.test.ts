import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveJudgeConsensus } from './judgeConsensus.js';
import type { EvalExpectationResult } from '../types/index.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import type { EvalCase } from './datasetTypes.js';

// Helpers mirror the ones in evalRunner.test.ts so the integration tests go
// through the real runEvalCase path the same way the existing judge tests do.
function createMockMCP(): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
    project: 'test-project',
    getServerInfo: vi.fn().mockReturnValue({ name: 'test', version: '1.0.0' }),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
    }),
  };
}

function createContext(mcp?: MCPFixtureApi) {
  return {
    mcp: mcp ?? createMockMCP(),
    testInfo: {
      attach: vi.fn().mockResolvedValue(undefined),
    } as unknown as never,
  };
}

function createEvalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'test-case',
    toolName: 'test-tool',
    args: { input: 'x' },
    ...overrides,
  };
}

function judge(pass: boolean, score?: number): EvalExpectationResult {
  return {
    pass,
    details: pass ? 'passed' : 'failed',
    ...(score !== undefined && { score }),
  };
}

describe('resolveJudgeConsensus', () => {
  describe('unanimous (default)', () => {
    it('passes only when every judge passes', () => {
      const r = resolveJudgeConsensus([judge(true), judge(true)]);
      expect(r.pass).toBe(true);
      expect(r.agreement).toBe(1);
      // Default-path summary is identical to the runner's historical output.
      expect(r.details).toBe('2/2 judges passed');
    });

    it('fails when any judge fails', () => {
      const r = resolveJudgeConsensus([judge(true), judge(false)]);
      expect(r.pass).toBe(false);
      expect(r.agreement).toBe(0.5);
      expect(r.details).toBe('1/2 judges passed');
    });

    it('is the default when no options are passed', () => {
      expect(resolveJudgeConsensus([judge(true), judge(false)]).pass).toBe(
        false
      );
    });
  });

  describe('majority', () => {
    it('passes when strictly more than half agree', () => {
      const r = resolveJudgeConsensus(
        [judge(true), judge(true), judge(false)],
        { policy: 'majority' }
      );
      expect(r.pass).toBe(true);
      expect(r.agreement).toBeCloseTo(2 / 3, 6);
    });

    it('fails at exactly half (not strictly greater)', () => {
      const r = resolveJudgeConsensus([judge(true), judge(false)], {
        policy: 'majority',
      });
      expect(r.pass).toBe(false);
    });
  });

  describe('mean', () => {
    it('passes when the mean score clears the threshold', () => {
      const r = resolveJudgeConsensus(
        [judge(true, 0.9), judge(true, 0.9), judge(false, 0.3)],
        { policy: 'mean', threshold: 0.6 }
      );
      // (0.9 + 0.9 + 0.3) / 3 = 0.7
      expect(r.pass).toBe(true);
      expect(r.agreement).toBeCloseTo(0.7, 6);
    });

    it('falls back to pass/fail as 1/0 when a judge has no score', () => {
      const r = resolveJudgeConsensus([judge(true), judge(false, 0.4)], {
        policy: 'mean',
        threshold: 0.6,
      });
      // (1 + 0.4) / 2 = 0.7
      expect(r.pass).toBe(true);
      expect(r.agreement).toBeCloseTo(0.7, 6);
    });
  });

  describe('median', () => {
    it('uses the middle score for odd counts', () => {
      const r = resolveJudgeConsensus(
        [judge(false, 0.2), judge(true, 0.8), judge(true, 0.95)],
        { policy: 'median', threshold: 0.7 }
      );
      expect(r.pass).toBe(true);
      expect(r.agreement).toBeCloseTo(0.8, 6);
    });

    it('averages the two middle scores for even counts', () => {
      const r = resolveJudgeConsensus(
        [
          judge(false, 0.2),
          judge(true, 0.6),
          judge(true, 0.8),
          judge(true, 0.95),
        ],
        { policy: 'median', threshold: 0.7 }
      );
      // median of [0.2, 0.6, 0.8, 0.95] = (0.6 + 0.8) / 2 = 0.7
      expect(r.pass).toBe(true);
      expect(r.agreement).toBeCloseTo(0.7, 6);
    });
  });

  describe('min', () => {
    it('passes only when the lowest score clears the threshold', () => {
      const r = resolveJudgeConsensus(
        [judge(true, 0.9), judge(true, 0.75), judge(true, 0.95)],
        { policy: 'min', threshold: 0.7 }
      );
      expect(r.pass).toBe(true);
      expect(r.agreement).toBeCloseTo(0.75, 6);
    });

    it('fails if a single judge scores below the threshold', () => {
      const r = resolveJudgeConsensus(
        [judge(true, 0.9), judge(false, 0.3), judge(true, 0.95)],
        { policy: 'min', threshold: 0.7 }
      );
      expect(r.pass).toBe(false);
      expect(r.agreement).toBeCloseTo(0.3, 6);
    });
  });

  it('handles an empty judge list', () => {
    const r = resolveJudgeConsensus([]);
    expect(r.pass).toBe(false);
    expect(r.agreement).toBe(0);
  });
});

// Integration: prove the consensus policy is actually wired into the eval
// runner's multi-judge path. These go through runEvalCase (a non-new module)
// with a mocked validateJudge, the same pattern the existing judge tests use.
describe('judgeConsensus wiring in runEvalCase', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // Three judges: two pass, one fails. Under the runner's default this MUST
  // fail (unanimous); under a 'majority' policy it MUST pass — proving the
  // policy flows from expect.judgeConsensus into the aggregation.
  function mockThreeJudgesTwoPass() {
    return async () => {
      const judgeModule = await import('../assertions/validators/judge.js');
      let callCount = 0;
      vi.spyOn(judgeModule, 'validateJudge').mockImplementation(async () => {
        callCount++;
        const passes = callCount !== 3; // third judge fails
        return {
          pass: passes,
          message: passes ? 'passed' : 'failed',
          details: {
            score: passes ? 0.9 : 0.3,
            judgeProvider: 'anthropic',
          },
        };
      });
    };
  }

  it('defaults to unanimous (fails when one of three judges fails)', async () => {
    await mockThreeJudgesTwoPass()();
    const { runEvalCase } = await import('./evalRunner.js');

    const evalCase = createEvalCase({
      expect: {
        passesJudge: [
          { rubric: 'correctness' },
          { rubric: 'completeness' },
          { rubric: 'groundedness' },
        ],
      },
    });

    const result = await runEvalCase(evalCase, createContext());
    expect(result.expectations.judge!.pass).toBe(false);
    expect(result.expectations.judge!.details).toBe('2/3 judges passed');
    expect(result.expectations.judge!.judgeResults).toHaveLength(3);
    vi.restoreAllMocks();
  });

  it('passes under majority policy when a majority agrees', async () => {
    await mockThreeJudgesTwoPass()();
    const { runEvalCase } = await import('./evalRunner.js');

    const evalCase = createEvalCase({
      expect: {
        passesJudge: [
          { rubric: 'correctness' },
          { rubric: 'completeness' },
          { rubric: 'groundedness' },
        ],
        judgeConsensus: { policy: 'majority' },
      },
    });

    const result = await runEvalCase(evalCase, createContext());
    expect(result.expectations.judge!.pass).toBe(true);
    expect(result.expectations.judge!.details).toContain('majority');
    expect(result.expectations.judge!.score).toBeCloseTo(2 / 3, 6);
    vi.restoreAllMocks();
  });

  it('passes under mean policy with a low threshold', async () => {
    await mockThreeJudgesTwoPass()();
    const { runEvalCase } = await import('./evalRunner.js');

    const evalCase = createEvalCase({
      expect: {
        passesJudge: [
          { rubric: 'correctness' },
          { rubric: 'completeness' },
          { rubric: 'groundedness' },
        ],
        judgeConsensus: { policy: 'mean', threshold: 0.6 },
      },
    });

    const result = await runEvalCase(evalCase, createContext());
    // mean(0.9, 0.9, 0.3) = 0.7 >= 0.6
    expect(result.expectations.judge!.pass).toBe(true);
    expect(result.expectations.judge!.details).toContain('mean');
    expect(result.expectations.judge!.score).toBeCloseTo(0.7, 6);
    vi.restoreAllMocks();
  });
});
