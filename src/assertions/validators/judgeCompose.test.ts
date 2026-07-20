/**
 * Integration test for the `compose` wiring in validateJudge.
 *
 * Imports the EXISTING validateJudge validator (the call site) and exercises
 * the compose branch end-to-end with createJudge mocked, proving the new
 * composed-judge module is actually invoked from the existing validator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateJudge } from './judge.js';

// Mock the judgeClient module so no real LLM calls are made. The composed
// judge resolves its base judge via createJudge, so this mock covers both the
// validator's built-in path and the composed-judge path.
vi.mock('../../judge/judgeClient.js', () => ({
  createJudge: vi.fn(),
}));

// Mock the judge registry (unused by the compose path, but validateJudge
// imports it, so it must be mocked to avoid leaking real implementations).
vi.mock('../../judge/judgeRegistry.js', () => ({
  getRegisteredJudge: vi.fn(),
}));

import { createJudge } from '../../judge/judgeClient.js';

const mockCreateJudge = vi.mocked(createJudge);

function makeMockJudge(
  results: Array<{ score?: number; pass: boolean; reasoning?: string }>
) {
  let callIndex = 0;
  return {
    evaluate: vi.fn().mockImplementation(async () => {
      const result = results[callIndex % results.length]!;
      callIndex++;
      return result;
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validateJudge — compose branch', () => {
  it('runs one judge eval per unit and aggregates via majority vote', async () => {
    const mockJudge = makeMockJudge([
      { score: 0.9, pass: true },
      { score: 0.95, pass: true },
    ]);
    mockCreateJudge.mockReturnValue(mockJudge);

    const result = await validateJudge('response', {
      compose: { preset: 'verify' },
      threshold: 0.5,
    });

    // verify preset = 2 units -> 2 evaluate calls
    expect(mockJudge.evaluate).toHaveBeenCalledTimes(2);
    expect(mockCreateJudge).toHaveBeenCalledTimes(1);
    expect(result.pass).toBe(true);
    expect(result.details?.score).toBe(1.0);
    expect(result.details?.aggregator).toBe('majority');
    expect(result.details?.unitResults).toHaveLength(2);
  });

  it('fails when the vote share is below the threshold', async () => {
    const mockJudge = makeMockJudge([
      { score: 0.9, pass: true },
      { score: 0.1, pass: false },
    ]);
    mockCreateJudge.mockReturnValue(mockJudge);

    const result = await validateJudge('response', {
      compose: { preset: 'verify' },
      threshold: 0.7,
    });

    // 1 of 2 units pass -> vote share 0.5 < 0.7
    expect(result.pass).toBe(false);
    expect(result.details?.score).toBe(0.5);
    expect(result.message).toContain('0.50');
    expect(result.message).toContain('threshold: 0.7');
  });

  it('passes vote share at exactly the majority threshold', async () => {
    const mockJudge = makeMockJudge([
      { score: 0.2, pass: false },
      { score: 0.9, pass: true },
    ]);
    mockCreateJudge.mockReturnValue(mockJudge);

    const result = await validateJudge('response', {
      compose: { preset: 'verify' },
      threshold: 0.5,
    });

    // 1 of 2 -> 0.5 >= 0.5 threshold
    expect(result.pass).toBe(true);
  });

  it('honours a custom unit set and mean aggregation', async () => {
    const mockJudge = makeMockJudge([
      { score: 0.6, pass: true },
      { score: 0.8, pass: true },
    ]);
    mockCreateJudge.mockReturnValue(mockJudge);

    const result = await validateJudge('response', {
      compose: {
        units: [
          { name: 'a', rubric: 'correctness' },
          { name: 'b', rubric: 'completeness' },
        ],
        aggregator: 'mean',
      },
      threshold: 0.7,
    });

    // mean(0.6, 0.8) = 0.7 >= 0.7
    expect(result.pass).toBe(true);
    expect(result.details?.score).toBeCloseTo(0.7, 5);
    expect(result.details?.aggregator).toBe('mean');
    const unitNames = (
      result.details?.unitResults as Array<{ unit: string }> | undefined
    )?.map((u) => u.unit);
    expect(unitNames).toEqual(['a', 'b']);
  });

  it('returns a fail result (not a throw) when compose config is invalid', async () => {
    const result = await validateJudge('response', {
      compose: {},
    });

    expect(result.pass).toBe(false);
    expect(result.message).toContain('Composed judge error');
    expect(mockCreateJudge).not.toHaveBeenCalled();
  });

  it('does not call createJudge when a judge instance is injected', async () => {
    const injected = makeMockJudge([
      { score: 1.0, pass: true },
      { score: 1.0, pass: true },
    ]);

    const result = await validateJudge('response', {
      compose: { preset: 'verify', judgeInstance: injected },
      threshold: 0.5,
    });

    expect(mockCreateJudge).not.toHaveBeenCalled();
    expect(injected.evaluate).toHaveBeenCalledTimes(2);
    expect(result.pass).toBe(true);
  });
});
