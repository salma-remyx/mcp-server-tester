import { describe, it, expect } from 'vitest';
import {
  computeReadiness,
  paretoFrontier,
  wilsonLowerBound,
} from './readinessScore.js';
import type { EvalCaseResult } from '../types/reporter.js';

function makeResult(
  overrides: Partial<EvalCaseResult> & { id: string }
): EvalCaseResult {
  return {
    datasetName: 'ds',
    toolName: 'search',
    source: 'eval',
    pass: true,
    expectations: {},
    durationMs: 100,
    ...overrides,
  };
}

describe('computeReadiness', () => {
  it('scores 0 and blocks the gate when no cases ran', () => {
    const r = computeReadiness({ results: [] });
    expect(r.score).toBe(0);
    expect(r.gate.ready).toBe(false);
    expect(r.gate.blockers).toEqual(['no eval cases ran']);
  });

  it('is READY when all cheap cases pass and budgets hold', () => {
    const r = computeReadiness({
      results: [
        makeResult({ id: 'a', pass: true, durationMs: 50 }),
        makeResult({ id: 'b', pass: true, durationMs: 80 }),
      ],
    });
    expect(r.signals.passRate).toBe(1);
    // High but not exactly 1: small latency consumes a sliver of the budget.
    expect(r.score).toBeGreaterThan(0.95);
    expect(r.gate.ready).toBe(true);
    expect(r.components.success).toBe(1);
    expect(r.components.cost).toBe(1);
  });

  it('scenario-weights cases by tag, then by dataset', () => {
    const r = computeReadiness({
      results: [
        makeResult({ id: 'critical', pass: false, tags: ['prod'] }),
        makeResult({ id: 'trivial', pass: true, tags: ['experimental'] }),
        makeResult({ id: 'untagged', pass: true }),
      ],
      scenarioWeights: { prod: 10, experimental: 1 },
    });
    // Weighted pass = (0*10 + 1*1 + 1*1) / (10 + 1 + 1) = 2/12.
    expect(r.signals.scenarioWeightedPassRate).toBeCloseTo(2 / 12, 5);
    // Unweighted pass rate is 2/3.
    expect(r.signals.passRate).toBeCloseTo(2 / 3, 5);
    expect(r.gate.ready).toBe(false);
  });

  it('uses the CI lower bound to gate flaky multi-iteration cases', () => {
    // 7/10 passes -> point estimate 0.7, but a wide Wilson lower bound < 1.0.
    const r = computeReadiness({
      results: [
        makeResult({
          id: 'flaky',
          pass: true,
          assertionPassRate: 0.7,
          assertionPassRateCI: { lower: 0.35, upper: 0.93 },
        }),
      ],
    });
    expect(r.signals.ciLowerBound).toBeCloseTo(0.35, 5);
    // Default minPassRate is 1.0, so the conservative lower bound blocks it.
    expect(r.gate.ready).toBe(false);
    expect(r.gate.blockers[0]).toContain('CI lower bound');
  });

  it('derives groundedness from judge expectation outcomes', () => {
    const r = computeReadiness({
      results: [
        makeResult({
          id: 'a',
          pass: true,
          expectations: { judge: { pass: true } },
        }),
        makeResult({
          id: 'b',
          pass: true,
          expectations: { judge: { pass: false } },
        }),
      ],
    });
    expect(r.signals.groundednessRate).toBe(0.5);
    expect(r.components.quality).toBe(0.5);
  });

  it('honors custom weights and thresholds', () => {
    const r = computeReadiness({
      results: [makeResult({ id: 'a', pass: true, durationMs: 1_000 })],
      weights: { success: 1, latency: 0, cost: 0, quality: 0 },
      thresholds: {
        minPassRate: 1.0,
        maxP95LatencyMs: 2_000,
        maxCostUsd: 0,
        minQuality: 0,
      },
    });
    // Only success contributes; cost budget 0 with 0 cost still scores 1.
    expect(r.score).toBe(1);
    expect(r.gate.ready).toBe(true);
  });

  it('aggregates cost from totalHostUsage when provided', () => {
    const r = computeReadiness({
      results: [makeResult({ id: 'a', pass: true })],
      totalHostUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalCostUsd: 0.25,
        durationMs: 100,
      },
    });
    expect(r.signals.costUsd).toBe(0.25);
  });
});

describe('paretoFrontier', () => {
  it('keeps non-dominated passing cases and drops dominated ones + failures', () => {
    const results = [
      makeResult({ id: 'cheap-fast-pass', pass: true, durationMs: 100 }),
      makeResult({ id: 'expensive-slow-pass', pass: true, durationMs: 5_000 }),
      makeResult({ id: 'fail', pass: false, durationMs: 50 }),
    ];
    const frontier = paretoFrontier(results).map((p) => p.id);
    // cheap-fast-pass dominates expensive-slow-pass; the failure is excluded.
    expect(frontier).toEqual(['cheap-fast-pass']);
  });

  it('keeps both passing points when neither dominates the other', () => {
    const results = [
      makeResult({
        id: 'fast-pricy',
        pass: true,
        durationMs: 100,
        hostUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalCostUsd: 0.1,
          durationMs: 100,
        },
      }),
      makeResult({
        id: 'slow-cheap',
        pass: true,
        durationMs: 5_000,
        hostUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalCostUsd: 0.01,
          durationMs: 100,
        },
      }),
    ];
    // One is faster but costlier; the other cheaper but slower -> neither dominates.
    const frontier = paretoFrontier(results).map((p) => p.id);
    expect(frontier.sort()).toEqual(['fast-pricy', 'slow-cheap'].sort());
  });
});

describe('wilsonLowerBound', () => {
  it('returns null below the minimum sample size', () => {
    expect(wilsonLowerBound(1, 1)).toBeNull();
  });

  it('shrinks toward 0 for low pass counts', () => {
    expect(wilsonLowerBound(0, 10)).toBeLessThan(0.2);
    expect(wilsonLowerBound(0, 10)).toBeGreaterThanOrEqual(0);
  });

  it('approaches 1 for unanimous passes', () => {
    expect(wilsonLowerBound(100, 100)).toBeGreaterThan(0.9);
  });
});
