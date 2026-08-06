/**
 * Unit tests for rubric calibration (CalibratedRubric-adapted):
 * Beta–Bernoulli agreement posterior measurability + submodular bank assembly.
 *
 * Reference values are computed analytically from the regularized incomplete
 * beta function for small integer Beta parameters.
 */

import { describe, it, expect } from 'vitest';
import {
  betaCdf,
  computeRubricMeasurability,
  assembleRubricBank,
} from './rubricCalibration.js';

describe('betaCdf (regularized incomplete beta)', () => {
  it('returns the uniform CDF for Beta(1, 1)', () => {
    expect(betaCdf(1, 1, 0.5)).toBeCloseTo(0.5, 9);
    expect(betaCdf(1, 1, 0.25)).toBeCloseTo(0.25, 9);
  });

  it('matches closed-form values for small integer Beta parameters', () => {
    // Beta(2,2) CDF at 0.7 = 3x^2(1-x) + x^3 = 0.784
    expect(betaCdf(2, 2, 0.7)).toBeCloseTo(0.784, 6);
    // Beta(3,1) CDF at 0.7 = x^3 = 0.343
    expect(betaCdf(3, 1, 0.7)).toBeCloseTo(0.343, 6);
    // Beta(3,3) CDF at 0.7 = 10x^3(1-x)^2 + 5x^4(1-x) + x^5 = 0.83692
    expect(betaCdf(3, 3, 0.7)).toBeCloseTo(0.83692, 5);
  });

  it('clamps to the [0,1] boundaries', () => {
    expect(betaCdf(2, 5, 0)).toBe(0);
    expect(betaCdf(2, 5, 1)).toBe(1);
  });

  it('satisfies Beta symmetry I_x(a,b) = 1 - I_{1-x}(b,a)', () => {
    expect(betaCdf(2, 5, 0.3) + betaCdf(5, 2, 0.7)).toBeCloseTo(1, 9);
  });

  it('throws on non-positive parameters', () => {
    expect(() => betaCdf(0, 1, 0.5)).toThrow();
    expect(() => betaCdf(1, 0, 0.5)).toThrow();
  });
});

describe('computeRubricMeasurability', () => {
  it('flags a consistent rubric as measurable', () => {
    // [0.8, 0.8] at threshold 0.7 ⇒ Beta(3,1), measurability = 1 - 0.343 = 0.657
    const m = computeRubricMeasurability([0.8, 0.8], {
      agreementThreshold: 0.7,
    });
    expect(m.reps).toBe(2);
    expect(m.agreementRate).toBeCloseTo(1.0, 9);
    expect(m.measurability).toBeCloseTo(0.657, 3);
    expect(m.posteriorMean).toBeCloseTo(0.75, 9); // 3 / (3 + 1)
    expect(m.measurable).toBe(true);
    expect(m.credibleInterval.lower).toBeLessThanOrEqual(m.posteriorMean);
    expect(m.credibleInterval.upper).toBeGreaterThanOrEqual(m.posteriorMean);
  });

  it('flags a disagreeing rubric as non-measurable', () => {
    // [0.1, 0.9] at threshold 0.7 ⇒ 1 agreement of 2 ⇒ Beta(2,2),
    // measurability = 1 - 0.784 = 0.216
    const m = computeRubricMeasurability([0.1, 0.9], {
      agreementThreshold: 0.7,
    });
    expect(m.agreementRate).toBeCloseTo(0.5, 9);
    expect(m.measurability).toBeCloseTo(0.216, 3);
    expect(m.measurable).toBe(false);
  });

  it('returns non-measurable for fewer reps than minReps', () => {
    // Single consistent rep is not enough redundancy.
    const m = computeRubricMeasurability([0.8], {
      agreementThreshold: 0.7,
      minReps: 2,
    });
    expect(m.reps).toBe(1);
    expect(m.measurable).toBe(false);
  });

  it('handles empty input as maximally uncertain and non-measurable', () => {
    const m = computeRubricMeasurability([]);
    expect(m.reps).toBe(0);
    expect(m.measurable).toBe(false);
    expect(m.measurability).toBeGreaterThanOrEqual(0);
    expect(m.measurability).toBeLessThanOrEqual(1);
  });

  it('becomes more measurable as redundancy grows for an agreeing rubric', () => {
    const small = computeRubricMeasurability([0.8, 0.8]);
    const large = computeRubricMeasurability([0.8, 0.8, 0.8, 0.8]);
    expect(large.measurability).toBeGreaterThan(small.measurability);
    expect(large.measurable).toBe(true);
  });
});

describe('assembleRubricBank', () => {
  it('selects up to maxSize rubrics by weighted marginal coverage', () => {
    const result = assembleRubricBank(
      [
        { id: 'a', scores: [0.9, 0.9, 0.9] },
        { id: 'b', scores: [0.2, 0.2, 0.2] },
        { id: 'c', scores: [0.5, 0.5, 0.5] },
      ],
      { maxSize: 2, bins: 10, agreementThreshold: 0.7 }
    );
    expect(result.selected).toBe(2);
    expect(result.considered).toBe(3);
    expect(result.bank).toHaveLength(2);
    expect(result.coverage).toBeGreaterThanOrEqual(0);
    expect(result.coverage).toBeLessThanOrEqual(1);
  });

  it('prefers a measurable rubric over a flaky one with broader coverage', () => {
    // 'reliable' covers 1 bin but is highly measurable (weight ≈ 0.83);
    // 'flaky' covers 3 bins but is barely measurable (weight ≈ 0.16).
    // Weighted marginal gain still favors the reliable rubric.
    const result = assembleRubricBank(
      [
        { id: 'reliable', scores: [0.8, 0.8, 0.8, 0.8] },
        { id: 'flaky', scores: [0.8, 0.1, 0.9, 0.1] },
      ],
      { maxSize: 1, bins: 10, agreementThreshold: 0.7 }
    );
    expect(result.bank).toEqual(['reliable']);
  });

  it('returns an empty bank for no candidates', () => {
    const result = assembleRubricBank([], { maxSize: 5 });
    expect(result.bank).toEqual([]);
    expect(result.selected).toBe(0);
    expect(result.considered).toBe(0);
    expect(result.coverage).toBe(0);
  });

  it('stops early once capability-range coverage saturates', () => {
    // All candidates cover the same single bin; after the first pick there is
    // no positive marginal coverage, so the bank should not grow to maxSize.
    const result = assembleRubricBank(
      [
        { id: 'a', scores: [0.9, 0.9, 0.9] },
        { id: 'b', scores: [0.9, 0.9, 0.9] },
        { id: 'c', scores: [0.9, 0.9, 0.9] },
      ],
      { maxSize: 10, bins: 10, agreementThreshold: 0.7 }
    );
    expect(result.selected).toBe(1);
    // All candidates share one bin, so a single rubric covers the entire
    // observed capability range (coverage is relative to observed bins).
    expect(result.coverage).toBeCloseTo(1.0, 6);
  });
});
