import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  auditJudgeReliability,
  judgeReliabilityCaseFromResult,
} from './judgeReliabilityAudit.js';
import type { EvalCaseResult } from '../types/reporter.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import type { EvalCase, EvalDataset } from './datasetTypes.js';
import type { EvalContext } from './evalRunner.js';

function makeCaseResult(overrides: Partial<EvalCaseResult>): EvalCaseResult {
  return {
    id: 'x',
    datasetName: 'audit-test',
    toolName: 't',
    source: 'eval',
    pass: true,
    expectations: {},
    durationMs: 1,
    ...overrides,
  };
}

describe('auditJudgeReliability — pure statistics', () => {
  it('returns a zeroed report with a helpful summary when there is no multi-judge data', () => {
    const report = auditJudgeReliability([]);
    expect(report.caseCount).toBe(0);
    expect(report.judgeCount).toBe(0);
    expect(report.perJudgeSlices).toEqual([]);
    expect(report.evaluatorReplacementDrift.decisionDisagreementRate).toBe(0);
    expect(report.summary).toContain('No multi-judge cases');
  });

  it('computes per-judge dataset slices (pass rate + mean score)', () => {
    const report = auditJudgeReliability([
      {
        id: 'a',
        votes: [
          { judgeProvider: 'anthropic', pass: true, score: 0.9 },
          { judgeProvider: 'openai', pass: false, score: 0.3 },
        ],
      },
      {
        id: 'b',
        votes: [
          { judgeProvider: 'anthropic', pass: true, score: 0.8 },
          { judgeProvider: 'openai', pass: true, score: 0.7 },
        ],
      },
    ]);

    const byJudge = new Map(report.perJudgeSlices.map((s) => [s.judge, s]));
    const anthropic = byJudge.get('anthropic')!;
    const openai = byJudge.get('openai')!;
    expect(anthropic.sampleCount).toBe(2);
    expect(anthropic.passRate).toBe(1);
    expect(anthropic.meanScore).toBeCloseTo(0.85, 5);
    expect(openai.sampleCount).toBe(2);
    expect(openai.passRate).toBe(0.5);
    expect(openai.meanScore).toBeCloseTo(0.5, 5);
  });

  it('measures evaluator-replacement drift (decision disagreement + score delta)', () => {
    const report = auditJudgeReliability([
      {
        id: 'a',
        votes: [
          { judgeProvider: 'anthropic', pass: true, score: 0.9 },
          { judgeProvider: 'openai', pass: false, score: 0.3 },
        ],
      },
      {
        id: 'b',
        votes: [
          { judgeProvider: 'anthropic', pass: true, score: 0.8 },
          { judgeProvider: 'openai', pass: true, score: 0.7 },
        ],
      },
    ]);

    // Case 'a' disagrees on the decision, case 'b' agrees -> 1/2.
    expect(report.evaluatorReplacementDrift.decisionDisagreementRate).toBe(0.5);
    expect(report.evaluatorReplacementDrift.sampleCount).toBe(2);
    // |0.9-0.3|=0.6 and |0.8-0.7|=0.1 -> mean 0.35.
    expect(report.evaluatorReplacementDrift.meanAbsScoreDelta).toBeCloseTo(
      0.35,
      5
    );
  });

  it('flags correlated errors (juries add little when agreement is perfect)', () => {
    const report = auditJudgeReliability([
      {
        id: 'a',
        votes: [
          { judgeProvider: 'x', pass: true },
          { judgeProvider: 'y', pass: true },
        ],
      },
      {
        id: 'b',
        votes: [
          { judgeProvider: 'x', pass: false },
          { judgeProvider: 'y', pass: false },
        ],
      },
    ]);

    expect(report.errorDependence.unanimousAgreementRate).toBe(1);
    expect(report.errorDependence.meanPairwiseAgreement).toBe(1);
    expect(report.evaluatorReplacementDrift.decisionDisagreementRate).toBe(0);
    expect(report.summary).toContain('correlated');
  });

  it('computes leniency spread and verbosity correlation bias probes', () => {
    const report = auditJudgeReliability([
      {
        id: 'a',
        responseLength: 5,
        votes: [
          { judgeProvider: 'anthropic', pass: true, score: 0.9 },
          { judgeProvider: 'openai', pass: true, score: 0.8 },
        ],
      },
      {
        id: 'b',
        responseLength: 500,
        votes: [
          { judgeProvider: 'anthropic', pass: true, score: 0.2 },
          { judgeProvider: 'openai', pass: true, score: 0.1 },
        ],
      },
    ]);

    // Leniency: anthropic mean (0.9+0.2)/2=0.55, openai mean (0.8+0.1)/2=0.45 -> 0.1.
    expect(report.biasProbes.leniencySpread).toBeCloseTo(0.1, 5);
    // Longer responses scored lower here -> strongly negative correlation.
    expect(report.biasProbes.verbosityCorrelation).toBeLessThan(-0.98);
    expect(report.biasProbes.verbositySampleCount).toBe(4);
  });

  it('records a protocol audit trail with provider/model and sample counts', () => {
    const report = auditJudgeReliability([
      {
        id: 'a',
        votes: [
          {
            judgeProvider: 'anthropic',
            judgeModel: 'claude',
            pass: true,
            score: 0.9,
          },
        ],
      },
    ]);
    expect(report.auditTrail).toHaveLength(1);
    expect(report.auditTrail[0]!.judge).toBe('anthropic/claude');
    expect(report.auditTrail[0]!.provider).toBe('anthropic');
    expect(report.auditTrail[0]!.model).toBe('claude');
    expect(report.auditTrail[0]!.sampleCount).toBe(1);
  });
});

describe('judgeReliabilityCaseFromResult adapter', () => {
  it('reads multi-judge votes and sums text-content length', () => {
    const input = judgeReliabilityCaseFromResult(
      makeCaseResult({
        response: { content: [{ type: 'text', text: 'hello world' }] },
        expectations: {
          judge: {
            pass: true,
            details: '2/2',
            judgeResults: [
              {
                pass: true,
                score: 0.9,
                judgeProvider: 'anthropic',
                judgeModel: 'claude',
              },
              { pass: false, score: 0.4, judgeProvider: 'openai' },
            ],
          },
        },
      })
    );
    expect(input).not.toBeNull();
    expect(input!.id).toBe('x');
    expect(input!.responseLength).toBe(11); // 'hello world'
    expect(input!.votes).toHaveLength(2);
    expect(input!.votes[0]!.judgeProvider).toBe('anthropic');
    expect(input!.votes[1]!.score).toBe(0.4);
  });

  it('returns null for single-judge and judge-less results', () => {
    expect(
      judgeReliabilityCaseFromResult(
        makeCaseResult({
          expectations: { judge: { pass: true, score: 0.9 } },
        })
      )
    ).toBeNull();
    expect(judgeReliabilityCaseFromResult(makeCaseResult({}))).toBeNull();
  });
});

describe('integration: runEvalDataset wires judgeReliability', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('populates result.judgeReliability from a multi-judge dataset', async () => {
    // Exercise the call-site edit in evalRunner.ts end to end: a multi-judge
    // passesJudge dataset must surface an evaluator-replacement audit on the
    // runner result. Imports from the (non-new) evalRunner module.
    const { runEvalDataset } = await import('./evalRunner.js');
    const judgeModule = await import('../assertions/validators/judge.js');
    let callCount = 0;
    vi.spyOn(judgeModule, 'validateJudge').mockImplementation(async () => {
      callCount++;
      // Alternate judges so they always disagree: anthropic passes high,
      // openai fails low. This gives a deterministic audit signal.
      if (callCount % 2 === 1) {
        return {
          pass: true,
          message: 'Judge passed',
          details: {
            score: 0.9,
            reasoning: 'good',
            judgeProvider: 'anthropic',
            judgeModel: 'claude',
          },
        };
      }
      return {
        pass: false,
        message: 'Judge failed',
        details: {
          score: 0.4,
          reasoning: 'bad',
          judgeProvider: 'openai',
          judgeModel: 'gpt-4o',
        },
      };
    });

    const mcp: MCPFixtureApi = {
      client: {} as MCPFixtureApi['client'],
      authType: 'none',
      project: 'test-project',
      getServerInfo: vi.fn().mockReturnValue({ name: 'test', version: '1.0' }),
      listTools: vi.fn().mockResolvedValue([]),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'a fixed candidate response' }],
        isError: false,
      }),
    };
    const context: EvalContext = {
      mcp,
      testInfo: {
        attach: vi.fn().mockResolvedValue(undefined),
      } as unknown as EvalContext['testInfo'],
    };

    const mkCase = (id: string): EvalCase => ({
      id,
      toolName: 'test-tool',
      args: { input: 'test' },
      expect: {
        passesJudge: [
          { rubric: 'correctness', threshold: 0.7 },
          { rubric: 'completeness', threshold: 0.7 },
        ],
      },
    });
    const dataset: EvalDataset = {
      name: 'reliability-test',
      cases: [mkCase('case-1'), mkCase('case-2')],
    };

    const result = await runEvalDataset({ dataset }, context);
    vi.restoreAllMocks();

    expect(result.judgeReliability).toBeDefined();
    const audit = result.judgeReliability!;
    expect(audit.caseCount).toBe(2);
    expect(audit.judgeCount).toBe(2);
    // Both cases: anthropic pass / openai fail -> every case disagrees.
    expect(audit.evaluatorReplacementDrift.decisionDisagreementRate).toBe(1);
    expect(audit.evaluatorReplacementDrift.meanAbsScoreDelta).toBeCloseTo(
      0.5,
      5
    );
    // The rubric name flows into each judge's label, so look slices up by the
    // meaningful audit dimension (provider) rather than the composite label.
    expect(audit.perJudgeSlices).toHaveLength(2);
    const anthropicSlice = audit.perJudgeSlices.find(
      (s) => s.provider === 'anthropic'
    )!;
    const openaiSlice = audit.perJudgeSlices.find(
      (s) => s.provider === 'openai'
    )!;
    expect(anthropicSlice.passRate).toBe(1);
    expect(openaiSlice.passRate).toBe(0);
    expect(anthropicSlice.model).toBe('claude');
    // Errors are anti-correlated (always disagree) -> agreement 0.
    expect(audit.errorDependence.meanPairwiseAgreement).toBe(0);
    expect(audit.summary).toContain('evaluator-replacement drift');
  });

  it('omits judgeReliability when no multi-judge cases ran', async () => {
    const { runEvalDataset } = await import('./evalRunner.js');
    const judgeModule = await import('../assertions/validators/judge.js');
    vi.spyOn(judgeModule, 'validateJudge').mockResolvedValue({
      pass: true,
      message: 'ok',
      details: { score: 0.9, judgeProvider: 'anthropic' },
    });

    const mcp: MCPFixtureApi = {
      client: {} as MCPFixtureApi['client'],
      authType: 'none',
      project: 'test-project',
      getServerInfo: vi.fn().mockReturnValue({ name: 'test', version: '1.0' }),
      listTools: vi.fn().mockResolvedValue([]),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'response' }],
        isError: false,
      }),
    };
    const context: EvalContext = {
      mcp,
      testInfo: {
        attach: vi.fn().mockResolvedValue(undefined),
      } as unknown as EvalContext['testInfo'],
    };
    const dataset: EvalDataset = {
      name: 'single-judge-test',
      cases: [
        {
          id: 'only-case',
          toolName: 'test-tool',
          args: { input: 'test' },
          expect: { passesJudge: { rubric: 'correctness' } }, // single judge -> no audit
        },
      ],
    };

    const result = await runEvalDataset({ dataset }, context);
    vi.restoreAllMocks();

    expect(result.judgeReliability).toBeUndefined();
  });
});
