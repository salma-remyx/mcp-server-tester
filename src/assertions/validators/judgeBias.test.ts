/**
 * Judge Bias Probe Tests
 *
 * Covers the bias-probe validators (verbosity, position, leniency) and —
 * importantly — the integration: `validateJudge` (existing module) with the
 * opt-in `biasProbe` flag, proving the new code is wired into the judge path.
 * The judge calls external LLM APIs so createJudge is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateJudge } from './judge.js';
import {
  validateJudgeBias,
  probeVerbosityBias,
  probePositionBias,
  computeLeniencyIndex,
  makeVerboseVariant,
} from './judgeBias.js';
import type { Judge } from '../../judge/judgeTypes.js';

// Mock the judgeClient module so no real LLM calls are made
vi.mock('../../judge/judgeClient.js', () => ({
  createJudge: vi.fn(),
}));

import { createJudge } from '../../judge/judgeClient.js';

const mockCreateJudge = vi.mocked(createJudge);

/**
 * Returns a judge whose evaluate() yields `results` in call order, then the
 * last result for any extra calls.
 */
function makeSequenceJudge(
  results: Array<{ score?: number; pass?: boolean; reasoning?: string }>
): Judge {
  let i = 0;
  const evaluate = vi.fn().mockImplementation(async () => {
    const r = results[i] ?? results[results.length - 1];
    i += 1;
    return r;
  });
  return { evaluate } as unknown as Judge;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validateJudge biasProbe integration (existing call site)', () => {
  it('runs the verbosity probe and attaches details.judgeBias when biasProbe is true', async () => {
    // Call order: [main eval, probe original, probe verbose]
    const judge = makeSequenceJudge([
      { score: 0.6, pass: false },
      { score: 0.4 },
      { score: 0.8 },
    ]);
    mockCreateJudge.mockReturnValue(judge);

    const result = await validateJudge('short answer', {
      rubric: { text: 'Is it good?' },
      biasProbe: true,
    });

    // main + 2 probe evaluations
    expect(judge.evaluate).toHaveBeenCalledTimes(3);
    expect(result.details?.judgeBias).toBeDefined();
    const verbosity = (
      result.details!.judgeBias as {
        verbosity: { delta: number; biased: boolean };
      }
    ).verbosity;
    expect(verbosity.delta).toBeCloseTo(0.4, 5);
    expect(verbosity.biased).toBe(true);
  });

  it('does not run the probe or attach judgeBias when biasProbe is unset', async () => {
    const judge = makeSequenceJudge([{ score: 0.8, pass: true }]);
    mockCreateJudge.mockReturnValue(judge);

    const result = await validateJudge('short answer', {
      rubric: { text: 'Is it good?' },
    });

    expect(judge.evaluate).toHaveBeenCalledTimes(1);
    expect(result.details?.judgeBias).toBeUndefined();
  });

  it('honors a custom tolerance on the bias probe', async () => {
    // delta 0.05 — below default tolerance (0.1) but above a custom 0.01
    const judge = makeSequenceJudge([
      { score: 0.8, pass: true },
      { score: 0.8 },
      { score: 0.85 },
    ]);
    mockCreateJudge.mockReturnValue(judge);

    const result = await validateJudge('answer', {
      rubric: { text: 'Is it good?' },
      biasProbe: { tolerance: 0.01 },
    });

    const verbosity = (
      result.details!.judgeBias as { verbosity: { biased: boolean } }
    ).verbosity;
    expect(verbosity.biased).toBe(true);
  });
});

describe('probeVerbosityBias', () => {
  it('flags bias when the padded variant scores higher', async () => {
    const judge = makeSequenceJudge([{ score: 0.3 }, { score: 0.9 }]);

    const result = await probeVerbosityBias('answer text', {
      rubric: { text: 'Is it good?' },
      judge,
    });

    expect(result.originalScore).toBe(0.3);
    expect(result.verboseScore).toBe(0.9);
    expect(result.delta).toBeCloseTo(0.6, 5);
    expect(result.biased).toBe(true);
    expect(result.verboseLength).toBeGreaterThan(result.originalLength);
  });

  it('does not flag bias when scores are equal', async () => {
    const judge = makeSequenceJudge([{ score: 0.5 }, { score: 0.5 }]);

    const result = await probeVerbosityBias('answer text', {
      rubric: 'correctness',
      judge,
    });

    expect(result.delta).toBe(0);
    expect(result.biased).toBe(false);
  });
});

describe('probePositionBias', () => {
  it('flags bias when swapping roles changes the preference asymmetrically', async () => {
    // Both orders favor the candidate role → asymmetry = 0.7 + 0.7 - 1 = 0.4
    const judge = makeSequenceJudge([{ score: 0.7 }, { score: 0.7 }]);

    const result = await probePositionBias('answer A', {
      rubric: { text: 'Is it good?' },
      reference: 'answer B',
      judge,
    });

    expect(result.asymmetry).toBeCloseTo(0.4, 5);
    expect(result.biased).toBe(true);
  });

  it('does not flag bias when the judge is symmetric', async () => {
    // 0.6 + 0.4 - 1 = 0 → symmetric
    const judge = makeSequenceJudge([{ score: 0.6 }, { score: 0.4 }]);

    const result = await probePositionBias('answer A', {
      rubric: { text: 'Is it good?' },
      reference: 'answer B',
      judge,
      tolerance: 0.1,
    });

    expect(result.asymmetry).toBeCloseTo(0, 5);
    expect(result.biased).toBe(false);
  });

  it('throws when no reference answer is provided', async () => {
    const judge = makeSequenceJudge([{ score: 0.5 }, { score: 0.5 }]);

    await expect(
      probePositionBias('answer A', {
        rubric: { text: 'Is it good?' },
        judge,
      })
    ).rejects.toThrow('reference');
  });
});

describe('computeLeniencyIndex', () => {
  it('returns 0 for an empty score set', () => {
    expect(computeLeniencyIndex([])).toBe(0);
  });

  it('is positive (lenient) when scores skew high', () => {
    expect(computeLeniencyIndex([0.8, 0.9])).toBeCloseTo(0.35, 5);
  });

  it('is negative (harsh) when scores skew low', () => {
    expect(computeLeniencyIndex([0.1, 0.2])).toBeCloseTo(-0.35, 5);
  });

  it('clamps to [-0.5, 0.5] at the extremes', () => {
    expect(computeLeniencyIndex([1, 1, 1])).toBe(0.5);
    expect(computeLeniencyIndex([0, 0])).toBe(-0.5);
  });
});

describe('makeVerboseVariant', () => {
  it('lengthens the text while preserving the original prefix', () => {
    const original = 'The temperature is 15 degrees.';
    const verbose = makeVerboseVariant(original, 2);

    expect(verbose.startsWith(original)).toBe(true);
    expect(verbose.length).toBeGreaterThan(original.length);
  });

  it('returns empty input unchanged', () => {
    expect(makeVerboseVariant('')).toBe('');
  });
});

describe('validateJudgeBias', () => {
  it('passes when the verbosity probe is within tolerance', async () => {
    const judge = makeSequenceJudge([{ score: 0.7 }, { score: 0.7 }]);

    const result = await validateJudgeBias('answer', {
      rubric: { text: 'Is it good?' },
      judge,
    });

    expect(result.pass).toBe(true);
    expect(result.details?.verbosity).toBeDefined();
  });

  it('fails and reports the offending probe when bias exceeds tolerance', async () => {
    const judge = makeSequenceJudge([{ score: 0.2 }, { score: 0.9 }]);

    const result = await validateJudgeBias('answer', {
      rubric: { text: 'Is it good?' },
      judge,
    });

    expect(result.pass).toBe(false);
    expect(result.message).toContain('verbosity');
  });

  it('fails with a clear message when the position probe lacks a reference', async () => {
    const judge = makeSequenceJudge([{ score: 0.5 }, { score: 0.5 }]);

    const result = await validateJudgeBias('answer', {
      rubric: { text: 'Is it good?' },
      judge,
      probes: ['position'],
    });

    expect(result.pass).toBe(false);
    expect(result.message).toContain('reference');
  });

  it('runs both probes when a reference is provided', async () => {
    // verbosity: 0.4, 0.4 (delta 0, not biased); position: 0.6, 0.4 (symmetric)
    const judge = makeSequenceJudge([
      { score: 0.4 },
      { score: 0.4 },
      { score: 0.6 },
      { score: 0.4 },
    ]);

    const result = await validateJudgeBias('answer A', {
      rubric: { text: 'Is it good?' },
      reference: 'answer B',
      judge,
      probes: ['verbosity', 'position'],
    });

    expect(result.pass).toBe(true);
    expect(result.details?.verbosity).toBeDefined();
    expect(result.details?.position).toBeDefined();
  });
});
