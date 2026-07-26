/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Judge, JudgeResult } from './judgeTypes.js';

// Leaf provider factories are mocked so createJudge builds controllable
// fake judges. This lets the test exercise the REAL createJudge wiring
// (config.failover -> createFailoverJudge) and the failover logic without
// touching the network.
vi.mock('./anthropicJudge.js', () => ({
  createAnthropicJudge: vi.fn(),
}));
vi.mock('./openaiJudge.js', () => ({
  createOpenAIJudge: vi.fn(),
}));
vi.mock('./googleJudge.js', () => ({
  createGoogleJudge: vi.fn(),
}));

import { createJudge } from './judgeClient.js';
import { createAnthropicJudge } from './anthropicJudge.js';
import { createOpenAIJudge } from './openaiJudge.js';
import { createGoogleJudge } from './googleJudge.js';
import { validateJudge } from '../assertions/validators/judge.js';

/** A fake judge that records the forwarded continuity unit on its evaluate. */
function makeFakeJudge(opts: {
  throw?: boolean;
  result?: Partial<JudgeResult>;
}): { judge: Judge; evaluate: ReturnType<typeof vi.fn> } {
  const evaluate = vi.fn(
    async (
      _candidate: unknown,
      _reference: unknown,
      _rubric: string
    ): Promise<JudgeResult> => {
      if (opts.throw) {
        throw new Error('provider outage');
      }
      return {
        pass: true,
        score: 0.9,
        reasoning: 'ok',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalCostUsd: 0,
          durationMs: 1,
        },
        ...opts.result,
      };
    }
  );
  return { judge: { evaluate } as unknown as Judge, evaluate };
}

const fastBackoff = { baseMs: 0, maxMs: 0, factor: 1 };

describe('createJudge failover wiring (ContinuityBench adapted port)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails over to a fallback when the primary errors, forwarding the continuity unit', async () => {
    const primary = makeFakeJudge({ throw: true });
    const fallback = makeFakeJudge({});
    vi.mocked(createAnthropicJudge).mockReturnValue(primary.judge);
    vi.mocked(createOpenAIJudge).mockReturnValue(fallback.judge);

    // createJudge is the existing call-site module; failover routes through it.
    const judge = createJudge({
      provider: 'anthropic',
      model: 'claude-sonnet',
      failover: {
        fallbacks: [{ provider: 'openai', model: 'gpt-4' }],
        backoff: fastBackoff,
      },
    });

    const result = await judge.evaluate('candidate', 'reference', 'rubric');

    // Primary was attempted once and threw.
    expect(primary.evaluate).toHaveBeenCalledTimes(1);
    // Fallback received the FULL continuity unit (history-forwarding).
    expect(fallback.evaluate).toHaveBeenCalledWith(
      'candidate',
      'reference',
      'rubric'
    );

    expect(result.pass).toBe(true);
    expect(result.failover).toBeDefined();
    expect(result.failover?.failoverOccurred).toBe(true);
    expect(result.failover?.servingProvider).toBe('openai');
    expect(result.failover?.servingModel).toBe('gpt-4');
    expect(result.failover?.attempts).toBe(2);
    expect(result.failover?.cpr).toBe(1); // continuity preserved
    expect(result.failover?.cloMs).toBeGreaterThanOrEqual(0);
  });

  it('does not fail over when the primary succeeds', async () => {
    const primary = makeFakeJudge({});
    const fallback = makeFakeJudge({});
    vi.mocked(createAnthropicJudge).mockReturnValue(primary.judge);
    vi.mocked(createOpenAIJudge).mockReturnValue(fallback.judge);

    const judge = createJudge({
      provider: 'anthropic',
      failover: {
        fallbacks: [{ provider: 'openai' }],
        backoff: fastBackoff,
      },
    });

    const result = await judge.evaluate('candidate', 'reference', 'rubric');

    expect(primary.evaluate).toHaveBeenCalledTimes(1);
    expect(fallback.evaluate).not.toHaveBeenCalled();
    expect(result.failover?.failoverOccurred).toBe(false);
    expect(result.failover?.servingProvider).toBe('anthropic');
    expect(result.failover?.cpr).toBe(1);
    expect(result.failover?.cloMs).toBe(0);
  });

  it('walks the chain across multiple failing fallbacks', async () => {
    const primary = makeFakeJudge({ throw: true });
    const openai = makeFakeJudge({ throw: true });
    const google = makeFakeJudge({});
    vi.mocked(createAnthropicJudge).mockReturnValue(primary.judge);
    vi.mocked(createOpenAIJudge).mockReturnValue(openai.judge);
    vi.mocked(createGoogleJudge).mockReturnValue(google.judge);

    const judge = createJudge({
      provider: 'anthropic',
      failover: {
        fallbacks: [{ provider: 'openai' }, { provider: 'google' }],
        backoff: fastBackoff,
      },
    });

    const result = await judge.evaluate('candidate', 'reference', 'rubric');

    expect(result.pass).toBe(true);
    expect(result.failover?.failoverOccurred).toBe(true);
    expect(result.failover?.servingProvider).toBe('google');
    expect(result.failover?.attempts).toBe(3);
    expect(google.evaluate).toHaveBeenCalledWith(
      'candidate',
      'reference',
      'rubric'
    );
  });

  it('returns a failed result (cpr: 0) instead of throwing when all providers error', async () => {
    const primary = makeFakeJudge({ throw: true });
    const fallback = makeFakeJudge({ throw: true });
    vi.mocked(createAnthropicJudge).mockReturnValue(primary.judge);
    vi.mocked(createOpenAIJudge).mockReturnValue(fallback.judge);

    const judge = createJudge({
      provider: 'anthropic',
      failover: {
        fallbacks: [{ provider: 'openai' }],
        backoff: fastBackoff,
      },
    });

    const result = await judge.evaluate('candidate', 'reference', 'rubric');

    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
    expect(result.failover?.cpr).toBe(0); // continuity lost
    expect(result.failover?.attempts).toBe(2);
    expect(result.reasoning).toMatch(/errored/i);
  });

  it('respects maxAttempts to cap the chain early', async () => {
    const primary = makeFakeJudge({ throw: true });
    vi.mocked(createAnthropicJudge).mockReturnValue(primary.judge);

    const judge = createJudge({
      provider: 'anthropic',
      failover: {
        fallbacks: [{ provider: 'openai' }, { provider: 'google' }],
        maxAttempts: 1,
        backoff: fastBackoff,
      },
    });

    const result = await judge.evaluate('candidate', 'reference', 'rubric');

    // Only the primary was tried; fallbacks never reached.
    expect(result.pass).toBe(false);
    expect(result.failover?.attempts).toBe(1);
    expect(result.failover?.cpr).toBe(0);
  });

  it('surfaces failover provenance + metrics through validateJudge details', async () => {
    const primary = makeFakeJudge({ throw: true });
    const fallback = makeFakeJudge({});
    vi.mocked(createAnthropicJudge).mockReturnValue(primary.judge);
    vi.mocked(createOpenAIJudge).mockReturnValue(fallback.judge);

    const validation = await validateJudge('candidate', {
      rubric: { text: 'Is this correct?' },
      provider: 'anthropic',
      failover: {
        fallbacks: [{ provider: 'openai', model: 'gpt-4' }],
        backoff: fastBackoff,
      },
    });

    expect(validation.pass).toBe(true);
    // Serving-provider provenance, not the configured primary.
    expect(validation.details?.judgeProvider).toBe('openai');
    expect(validation.details?.judgeModel).toBe('gpt-4');
    expect((validation.details as any)?.failover?.failoverOccurred).toBe(true);
    expect((validation.details as any)?.failover?.cpr).toBe(1);
  });
});
