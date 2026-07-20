/**
 * Unit tests for the composed (Verdict-style) judge.
 *
 * The base Judge is injected as a mock, so no real LLM calls are made and
 * createJudge is not exercised here (the integration test covers the
 * validateJudge wiring, including createJudge).
 */

import { describe, it, expect, vi } from 'vitest';
import type { Judge, JudgeResult } from './judgeTypes.js';
import {
  createComposedJudge,
  COMPOSE_PRESETS,
  type JudgeUnit,
} from './judgeCompose.js';

function makeMockJudge(
  results: Array<{ score?: number; pass: boolean; reasoning?: string }>
): Judge {
  let callIndex = 0;
  return {
    evaluate: vi.fn().mockImplementation(async (): Promise<JudgeResult> => {
      const result = results[callIndex % results.length]!;
      callIndex++;
      return result;
    }),
  };
}

const UNITS: JudgeUnit[] = [
  { name: 'correctness', rubric: 'correctness' },
  { name: 'groundedness', rubric: 'groundedness' },
  { name: 'completeness', rubric: 'completeness' },
];

describe('createComposedJudge', () => {
  describe('majority aggregation', () => {
    it('scores 1.0 when every unit passes', async () => {
      const judge = makeMockJudge([
        { score: 0.9, pass: true },
        { score: 0.95, pass: true },
        { score: 1.0, pass: true },
      ]);
      const executor = createComposedJudge({
        units: UNITS,
        aggregator: 'majority',
        judgeInstance: judge,
      });

      const result = await executor('candidate');

      expect(result.score).toBe(1.0);
      expect(result.unitResults).toHaveLength(3);
      expect(result.aggregator).toBe('majority');
    });

    it('scores the fraction of passing units (vote share)', async () => {
      const judge = makeMockJudge([
        { score: 0.9, pass: true },
        { score: 0.2, pass: false },
        { score: 0.95, pass: true },
      ]);
      const executor = createComposedJudge({
        units: UNITS,
        aggregator: 'majority',
        judgeInstance: judge,
      });

      const result = await executor('candidate');

      // 2 of 3 units pass
      expect(result.score).toBeCloseTo(2 / 3, 5);
      expect(result.unitResults.map((r) => r.pass)).toEqual([
        true,
        false,
        true,
      ]);
    });

    it('defaults to majority aggregator', async () => {
      const judge = makeMockJudge([{ score: 1.0, pass: true }]);
      const executor = createComposedJudge({
        units: UNITS,
        judgeInstance: judge,
      });

      const result = await executor('candidate');

      expect(result.aggregator).toBe('majority');
    });
  });

  describe('mean aggregation', () => {
    it('scores the mean of the per-unit scores', async () => {
      const judge = makeMockJudge([
        { score: 0.9, pass: true },
        { score: 0.3, pass: false },
        { score: 0.6, pass: false },
      ]);
      const executor = createComposedJudge({
        units: UNITS,
        aggregator: 'mean',
        judgeInstance: judge,
      });

      const result = await executor('candidate');

      expect(result.score).toBeCloseTo((0.9 + 0.3 + 0.6) / 3, 5);
    });
  });

  describe('per-unit behavior', () => {
    it('calls evaluate once per unit with the resolved rubric', async () => {
      const judge = makeMockJudge([{ score: 1.0, pass: true }]);
      const executor = createComposedJudge({
        units: UNITS,
        judgeInstance: judge,
      });

      await executor('candidate', 'reference');

      expect(judge.evaluate).toHaveBeenCalledTimes(3);
      // Each call passes the candidate, reference, and a resolved rubric string
      for (const call of vi.mocked(judge.evaluate).mock.calls) {
        expect(call[0]).toBe('candidate');
        expect(call[1]).toBe('reference');
        expect(typeof call[2]).toBe('string');
      }
    });

    it('falls back to pass-boolean score when score is undefined', async () => {
      const judge = makeMockJudge([
        { pass: true },
        { pass: false },
        { pass: true },
      ]);
      const executor = createComposedJudge({
        units: UNITS,
        aggregator: 'mean',
        judgeInstance: judge,
      });

      const result = await executor('candidate');

      // pass:true -> 1.0, pass:false -> 0.0, pass:true -> 1.0 => mean 2/3
      expect(result.score).toBeCloseTo(2 / 3, 5);
    });

    it('embeds per-unit verdicts in reasoning for interpretability', async () => {
      const judge = makeMockJudge([
        { score: 0.9, pass: true, reasoning: 'looks correct' },
        { score: 0.1, pass: false, reasoning: 'unsupported' },
      ]);
      const executor = createComposedJudge({
        units: [UNITS[0]!, UNITS[1]!],
        judgeInstance: judge,
      });

      const result = await executor('candidate');

      expect(result.reasoning).toContain('correctness');
      expect(result.reasoning).toContain('groundedness');
      expect(result.reasoning).toContain('PASS');
      expect(result.reasoning).toContain('FAIL');
    });
  });

  describe('presets', () => {
    it('resolves the verify preset to correctness + groundedness', async () => {
      const judge = makeMockJudge([{ score: 1.0, pass: true }]);
      const executor = createComposedJudge({
        preset: 'verify',
        judgeInstance: judge,
      });

      const result = await executor('candidate');

      expect(result.unitResults.map((r) => r.unit)).toEqual([
        'correctness',
        'groundedness',
      ]);
      expect(judge.evaluate).toHaveBeenCalledTimes(2);
    });

    it('resolves the quality preset to three units', async () => {
      const judge = makeMockJudge([{ score: 1.0, pass: true }]);
      const executor = createComposedJudge({
        preset: 'quality',
        judgeInstance: judge,
      });

      const result = await executor('candidate');

      expect(result.unitResults).toHaveLength(3);
      expect(COMPOSE_PRESETS.quality).toHaveLength(3);
    });

    it('prefers explicit units over preset when both are set', async () => {
      const judge = makeMockJudge([{ score: 1.0, pass: true }]);
      const executor = createComposedJudge({
        units: [UNITS[0]!],
        preset: 'quality',
        judgeInstance: judge,
      });

      const result = await executor('candidate');

      expect(result.unitResults).toHaveLength(1);
    });
  });

  describe('validation', () => {
    it('throws when neither units nor preset is provided', () => {
      expect(() => createComposedJudge({})).toThrow(
        /either "units" or "preset"/
      );
    });

    it('throws when units is an empty array', () => {
      expect(() =>
        createComposedJudge({ units: [], judgeInstance: makeMockJudge([]) })
      ).toThrow(/non-empty array/);
    });
  });

  describe('registry compatibility', () => {
    it('returns a result assignable to the CustomJudgeExecutor contract', async () => {
      const judge = makeMockJudge([{ score: 0.8, pass: true }]);
      const executor = createComposedJudge({
        preset: 'verify',
        judgeInstance: judge,
      });

      const result = await executor('candidate');

      // The minimal contract: a numeric score and optional reasoning
      expect(typeof result.score).toBe('number');
      expect(typeof result.reasoning).toBe('string');
    });
  });
});
