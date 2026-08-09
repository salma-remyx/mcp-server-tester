/**
 * Benchmark audit integration tests.
 *
 * These tests exercise `runBenchmarkAudit` against the *existing* judge
 * contract (`Judge` / `JudgeResult` from `../judge/judgeTypes.js`) and the
 * *existing* eval-dataset model (`EvalDataset` from `./datasetTypes.js`),
 * proving the new capability composes that infrastructure rather than
 * standing alone. `createJudge` is mocked so no real LLM calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TestInfo } from '@playwright/test';

// Non-new modules the new capability composes — importing these is the
// integration anchor required by the testing convention.
import type { EvalDataset } from './datasetTypes.js';
import type { Judge, JudgeResult } from '../judge/judgeTypes.js';

// Mock the judge factory so no real LLM calls are made.
vi.mock('../judge/judgeClient.js', () => ({
  createJudge: vi.fn(),
}));

import { createJudge } from '../judge/judgeClient.js';
import { runBenchmarkAudit, BENCHMARK_DIMENSIONS } from './benchmarkAudit.js';

const mockCreateJudge = vi.mocked(createJudge);

/**
 * Builds a fake judge that returns a distinct, deterministic `JudgeResult`
 * per dimension, identified by the rubric text it receives. The returned
 * values conform to the real `JudgeResult` contract.
 */
function makeDimensionJudge(): Judge {
  const judge: Judge = {
    evaluate: vi.fn(
      async (
        _candidate: unknown,
        _reference: unknown,
        rubric: string
      ): Promise<JudgeResult> => {
        if (rubric.includes('redundan')) {
          return { pass: true, score: 0.75, reasoning: 'coverage-reason' };
        }
        if (rubric.includes('complex')) {
          return { pass: false, score: 0.5, reasoning: 'complexity-reason' };
        }
        return { pass: true, score: 0.8, reasoning: 'consistency-reason' };
      }
    ),
  };
  return judge;
}

function makeDataset(): EvalDataset {
  return {
    name: 'audit-fixture',
    description: 'two cases for the audit',
    cases: [
      {
        id: 'case-a',
        toolName: 'get_weather',
        args: { city: 'London' },
        expect: { containsText: ['temperature'] },
      },
      {
        id: 'case-b',
        mode: 'mcp_host',
        scenario: 'Find recent docs about planning',
        expect: { toolsTriggered: { calls: [{ name: 'search' }] } },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runBenchmarkAudit', () => {
  describe('dimension scoring and aggregation', () => {
    it('scores every case on every dimension and aggregates per-case + dataset scores', async () => {
      const judge = makeDimensionJudge();
      const dataset = makeDataset();

      const result = await runBenchmarkAudit(dataset, { judge });

      // Two cases, each scored on the default three dimensions.
      expect(result.results).toHaveLength(2);
      expect(result.scores.byDimension.consistency).toBe(0.8);
      expect(result.scores.byDimension.complexity).toBe(0.5);
      expect(result.scores.byDimension['policy-coverage']).toBe(0.75);

      // Per-case: mean of [0.8, 0.5, 0.75] = 2.05/3, fails because complexity
      // (0.5) is below the default 0.7 threshold.
      const expectedCaseScore = 2.05 / 3;
      for (const caseResult of result.results) {
        expect(caseResult.dimensions).toHaveLength(3);
        expect(caseResult.score).toBeCloseTo(expectedCaseScore, 5);
        expect(caseResult.pass).toBe(false);
        const complexity = caseResult.dimensions.find(
          (d) => d.dimension === 'complexity'
        );
        expect(complexity?.pass).toBe(false);
        const consistency = caseResult.dimensions.find(
          (d) => d.dimension === 'consistency'
        );
        expect(consistency?.pass).toBe(true);
      }

      // Overall pass is false because every case failed, and the overall
      // score is the mean of the per-case scores.
      expect(result.pass).toBe(false);
      expect(result.scores.overall).toBeCloseTo(expectedCaseScore, 5);

      // 2 cases x 3 dimensions = 6 judge evaluations.
      expect(judge.evaluate).toHaveBeenCalledTimes(6);
    });

    it('passes when every dimension of every case meets the threshold', async () => {
      const judge: Judge = {
        evaluate: vi.fn(
          async (): Promise<JudgeResult> => ({
            pass: true,
            score: 0.9,
            reasoning: 'strong case',
          })
        ),
      };

      const result = await runBenchmarkAudit(makeDataset(), { judge });

      expect(result.pass).toBe(true);
      expect(result.scores.overall).toBe(0.9);
      expect(result.scores.byDimension.consistency).toBe(0.9);
    });

    it('derives a coarse score from judge.pass when score is omitted', async () => {
      const judge: Judge = {
        evaluate: vi.fn(
          async (): Promise<JudgeResult> => ({
            pass: true,
            reasoning: 'no numeric score',
          })
        ),
      };

      const result = await runBenchmarkAudit(makeDataset(), { judge });

      expect(result.scores.overall).toBe(1);
      expect(result.results[0]?.dimensions[0]?.score).toBe(1);
    });
  });

  describe('reporter attachment', () => {
    it('attaches a JSON audit to the reporter when testInfo is provided', async () => {
      const judge = makeDimensionJudge();
      const attach = vi.fn();
      const testInfo = { attach } as unknown as TestInfo;

      const result = await runBenchmarkAudit(
        makeDataset(),
        { judge },
        testInfo
      );

      expect(attach).toHaveBeenCalledTimes(1);
      const [name, attachment] = attach.mock.calls[0]!;
      expect(name).toBe('mcp-benchmark-audit');
      expect(attachment.contentType).toBe('application/json');
      const body = JSON.parse(attachment.body as string) as Record<
        string,
        unknown
      >;
      expect(body['operation']).toBe('benchmarkAudit');
      expect(body['dataset']).toBe('audit-fixture');
      expect(body['pass']).toBe(result.pass);
      expect(body['dimensions']).toEqual([...BENCHMARK_DIMENSIONS]);
      expect((body['results'] as unknown[]).length).toBe(2);
    });

    it('does not attach when testInfo is omitted', async () => {
      const judge = makeDimensionJudge();
      const result = await runBenchmarkAudit(makeDataset(), { judge });
      expect(result.results).toHaveLength(2);
      expect(judge.evaluate).toHaveBeenCalledTimes(6);
    });
  });

  describe('dimension selection', () => {
    it('only scores the selected dimensions', async () => {
      const judge = makeDimensionJudge();

      const result = await runBenchmarkAudit(makeDataset(), {
        judge,
        dimensions: ['consistency'],
      });

      for (const caseResult of result.results) {
        expect(caseResult.dimensions).toHaveLength(1);
        expect(caseResult.dimensions[0]?.dimension).toBe('consistency');
      }
      // With only consistency (0.8 >= 0.7), every case passes.
      expect(result.pass).toBe(true);
      expect(result.scores.byDimension).toEqual({ consistency: 0.8 });
      expect(judge.evaluate).toHaveBeenCalledTimes(2);
    });
  });

  describe('threshold', () => {
    it('fails dimensions that fall below a raised threshold', async () => {
      const judge = makeDimensionJudge();

      const result = await runBenchmarkAudit(makeDataset(), {
        judge,
        threshold: 0.85,
      });

      // 0.8 consistency is now below 0.85, so no dimension passes.
      const first = result.results[0]!;
      expect(first.pass).toBe(false);
      const consistency = first.dimensions.find(
        (d) => d.dimension === 'consistency'
      );
      expect(consistency?.pass).toBe(false);
    });
  });

  describe('judge resolution', () => {
    it('builds a judge via createJudge when none is injected', async () => {
      const judge = makeDimensionJudge();
      mockCreateJudge.mockReturnValue(judge);

      const result = await runBenchmarkAudit(makeDataset());

      expect(mockCreateJudge).toHaveBeenCalledTimes(1);
      expect(judge.evaluate).toHaveBeenCalledTimes(6);
      expect(result.results).toHaveLength(2);
    });

    it('does not call createJudge when a judge is injected', async () => {
      const judge = makeDimensionJudge();
      mockCreateJudge.mockReturnValue(judge);

      await runBenchmarkAudit(makeDataset(), { judge });

      expect(mockCreateJudge).not.toHaveBeenCalled();
    });
  });
});
