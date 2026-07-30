import { describe, it, expect } from 'vitest';
import {
  computeReadiness,
  paretoFrontier,
  wilsonLowerBound,
  READINESS_WEIGHT_PRESETS,
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
    // No host usage was recorded, so cost is unmeasured and excluded.
    expect(r.components.cost).toBeNull();
    expect(r.missingComponents).toEqual(['cost', 'quality']);
  });

  it('renormalizes weights over measured components only', () => {
    // One passing case at half the latency budget, no cost or quality data.
    // Present: success (weight 0.5, score 1) + latency (weight 0.2, score 0.5).
    // Score = (0.5*1 + 0.2*0.5) / (0.5 + 0.2) = 0.6/0.7, not diluted by
    // substituted defaults for the missing cost/quality dimensions.
    const r = computeReadiness({
      results: [makeResult({ id: 'a', pass: true, durationMs: 2_500 })],
    });
    expect(r.score).toBeCloseTo(0.6 / 0.7, 5);
    expect(r.missingComponents).toEqual(['cost', 'quality']);
  });

  it('includes quality in the blend when a judge ran', () => {
    // Same shape as above, but the judge failed: quality is measured (0) and
    // pulls the renormalized score down instead of being ignored.
    const r = computeReadiness({
      results: [
        makeResult({
          id: 'a',
          pass: true,
          durationMs: 2_500,
          expectations: { judge: { pass: false } },
        }),
      ],
    });
    // (0.5*1 + 0.2*0.5 + 0.15*0) / (0.5 + 0.2 + 0.15) = 0.6/0.85.
    expect(r.score).toBeCloseTo(0.6 / 0.85, 5);
    expect(r.missingComponents).toEqual(['cost']);
    expect(r.components.quality).toBe(0);
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

  it('applies named scenario weight presets from the paper', () => {
    const r = computeReadiness({
      results: [makeResult({ id: 'a', pass: true })],
      preset: 'sla-first',
    });
    expect(r.weights).toEqual(READINESS_WEIGHT_PRESETS['sla-first']);
    // SLA-first puts the largest single paper weight (0.30) on latency.
    expect(r.weights.latency).toBe(0.3);
    expect(r.weights.latency).toBeGreaterThan(r.weights.cost);
    expect(r.weights.latency).toBeGreaterThan(r.weights.quality);
  });

  it('lets explicit weights override the preset', () => {
    const r = computeReadiness({
      results: [makeResult({ id: 'a', pass: true })],
      preset: 'cost-first',
      weights: { cost: 0.9 },
    });
    expect(r.weights.cost).toBe(0.9);
    expect(r.weights.success).toBe(
      READINESS_WEIGHT_PRESETS['cost-first'].success
    );
  });

  it('classifies pass-rate failures as hard blockers and budget breaches as soft', () => {
    const hard = computeReadiness({
      results: [makeResult({ id: 'a', pass: false })],
    });
    expect(hard.gate.ready).toBe(false);
    expect(hard.gate.hardBlockers[0]).toContain('pass rate');
    expect(hard.gate.softBlockers).toEqual([]);
    expect(hard.gate.blockers).toEqual(hard.gate.hardBlockers);

    const soft = computeReadiness({
      results: [makeResult({ id: 'a', pass: true, durationMs: 9_000 })],
    });
    expect(soft.gate.ready).toBe(false);
    expect(soft.gate.hardBlockers).toEqual([]);
    expect(soft.gate.softBlockers[0]).toContain('p95 latency');
  });

  it('skips gate checks for unmeasured components instead of substituting defaults', () => {
    // minQuality 0.9 with no judge data: quality is unmeasured, so the gate
    // neither passes nor blocks on it — it is reported missing instead.
    const r = computeReadiness({
      results: [makeResult({ id: 'a', pass: true, durationMs: 10 })],
      thresholds: { minQuality: 0.9 },
    });
    expect(r.gate.ready).toBe(true);
    expect(r.gate.passed.some((p) => p.includes('quality'))).toBe(false);
    expect(r.missingComponents).toContain('quality');
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

  it('does not let a faster, cheaper case dominate a higher-quality one', () => {
    const results = [
      makeResult({
        id: 'fast-low-quality',
        pass: true,
        durationMs: 100,
        expectations: { judge: { pass: false } },
      }),
      makeResult({
        id: 'slow-high-quality',
        pass: true,
        durationMs: 5_000,
        expectations: { judge: { pass: true } },
      }),
    ];
    // Maximizing quality is part of the tradeoff, so both stay on the frontier.
    const frontier = paretoFrontier(results);
    expect(frontier.map((p) => p.id).sort()).toEqual(
      ['fast-low-quality', 'slow-high-quality'].sort()
    );
    expect(frontier.find((p) => p.id === 'slow-high-quality')?.quality).toBe(1);
  });

  it('lets equal-cost, equal-latency cases be dominated on quality alone', () => {
    const results = [
      makeResult({
        id: 'judged-pass',
        pass: true,
        durationMs: 100,
        expectations: { judge: { pass: true } },
      }),
      makeResult({
        id: 'judged-fail',
        pass: true,
        durationMs: 100,
        expectations: { judge: { pass: false } },
      }),
    ];
    expect(paretoFrontier(results).map((p) => p.id)).toEqual(['judged-pass']);
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
