/**
 * Integration tests for continuous verification scoring.
 *
 * These exercise the LLM-as-a-Verifier continuous-scoring executor through the
 * repo's existing custom-judge registry (a NON-NEW module) to prove the
 * wiring — registration by name, retrieval, and end-to-end execution — rather
 * than only self-testing the scoring math.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted before any test runs — mocks the optional Anthropic SDK so the
// logprob-provider test never needs the real package installed.
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  const MockAnthropic = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  });
  return { default: MockAnthropic, __mockCreate: mockCreate };
});

import {
  registerJudge,
  getRegisteredJudge,
  clearJudgeRegistry,
} from './judgeRegistry.js';
import {
  FIVE_POINT_SCALE,
  TEN_POINT_SCALE,
  buildVerifierPrompt,
  computeExpectedScore,
  createAnthropicLogProbProvider,
  createVerifierScoringJudge,
  logprobToProbability,
  registerVerifierScoringJudge,
  type LogProbProvider,
  type TokenLogProb,
} from './verifierScoring.js';

beforeEach(() => {
  clearJudgeRegistry();
});

/** Builds a fake provider that returns the given distribution for any prompt. */
function fakeProvider(distribution: TokenLogProb[]): LogProbProvider {
  return vi.fn(async () => structuredClone(distribution));
}

/** logprob(0.6 / 0.3 / 0.1) → normalized 0.6 / 0.3 / 0.1 over tokens 5/4/3. */
const skewedHigh: TokenLogProb[] = [
  { token: '5', logprob: Math.log(0.6) },
  { token: '4', logprob: Math.log(0.3) },
  { token: '3', logprob: Math.log(0.1) },
];

describe('logprobToProbability', () => {
  it('converts a natural-log probability to a linear one', () => {
    expect(logprobToProbability(0)).toBeCloseTo(1, 10);
    expect(logprobToProbability(Math.log(0.25))).toBeCloseTo(0.25, 10);
  });
});

describe('computeExpectedScore', () => {
  it('weights each token by its renormalized probability', () => {
    const result = computeExpectedScore(skewedHigh, FIVE_POINT_SCALE);
    expect(result.empty).toBe(false);
    // E = 1.0*0.6 + 0.75*0.3 + 0.5*0.1 = 0.6 + 0.225 + 0.05 = 0.875
    expect(result.score).toBeCloseTo(0.875, 6);
  });

  it('returns 0.5 for a uniform distribution over the 5-point scale', () => {
    const uniform: TokenLogProb[] = FIVE_POINT_SCALE.map((s) => ({
      token: s.token,
      logprob: Math.log(0.2),
    }));
    const result = computeExpectedScore(uniform, FIVE_POINT_SCALE);
    expect(result.score).toBeCloseTo(0.5, 6);
  });

  it('flags an empty distribution and scores 0', () => {
    const result = computeExpectedScore(
      [{ token: 'unrelated', logprob: Math.log(0.9) }],
      FIVE_POINT_SCALE
    );
    expect(result.empty).toBe(true);
    expect(result.score).toBe(0);
  });

  it('TEN_POINT_SCALE spans the full [0, 1] range', () => {
    expect(TEN_POINT_SCALE).toHaveLength(10);
    const first = TEN_POINT_SCALE[0]?.score ?? Number.NaN;
    const last =
      TEN_POINT_SCALE[TEN_POINT_SCALE.length - 1]?.score ?? Number.NaN;
    expect(first).toBe(0);
    expect(last).toBeCloseTo(1, 6);
  });
});

describe('buildVerifierPrompt', () => {
  it('lists every scoring token and orients low/high', () => {
    const prompt = buildVerifierPrompt({
      criterion: 'is correct',
      candidate: '42',
      scale: FIVE_POINT_SCALE,
    });
    expect(prompt).toContain('{1, 2, 3, 4, 5}');
    expect(prompt).toContain('"1"');
    expect(prompt).toContain('"5"');
    expect(prompt).toContain('is correct');
    expect(prompt).toContain('42');
  });

  it('omits the reference block when none is provided', () => {
    const prompt = buildVerifierPrompt({
      criterion: 'is correct',
      candidate: '42',
      scale: FIVE_POINT_SCALE,
    });
    expect(prompt).not.toContain('<reference>');
  });
});

describe('createVerifierScoringJudge (registry integration)', () => {
  it('throws when neither rubric nor criteria is provided', () => {
    expect(() =>
      createVerifierScoringJudge({ provider: fakeProvider([]) })
    ).toThrow('either `rubric` or `criteria`');
  });

  it('registers under a name, is retrievable, and returns a calibrated score', async () => {
    registerVerifierScoringJudge('llm-verifier', {
      rubric: 'Does the answer solve the problem?',
      provider: fakeProvider(skewedHigh),
    });

    // Retrieved through the EXISTING registry — proves the wiring.
    const executor = getRegisteredJudge('llm-verifier');
    const result = await executor('candidate response');

    expect(result.score).toBeCloseTo(0.875, 6);
    expect(result.reasoning).toContain('LLM-as-a-Verifier');
    expect(result.reasoning).toContain('5-point');
  });

  it('is callable through a manually registered executor too', async () => {
    const executor = createVerifierScoringJudge({
      rubric: 'is grounded',
      provider: fakeProvider([
        { token: '1', logprob: Math.log(0.7) },
        { token: '2', logprob: Math.log(0.3) },
      ]),
    });
    registerJudge('manual-verifier', executor);

    const retrieved = getRegisteredJudge('manual-verifier');
    const result = await retrieved('candidate');
    // E = 0.0*0.7 + 0.25*0.3 = 0.075
    expect(result.score).toBeCloseTo(0.075, 6);
  });

  it('averages across criteria (criteria decomposition)', async () => {
    let call = 0;
    const provider: LogProbProvider = vi.fn(async () => {
      call += 1;
      // Criterion 0 skews high (0.875), criterion 1 skews low (0.075).
      return call === 1
        ? structuredClone(skewedHigh)
        : [
            { token: '1', logprob: Math.log(0.7) },
            { token: '2', logprob: Math.log(0.3) },
          ];
    });

    const executor = createVerifierScoringJudge({
      criteria: ['is correct', 'is concise'],
      provider,
    });
    const result = await executor('candidate');

    expect(provider).toHaveBeenCalledTimes(2);
    // mean of 0.875 and 0.075
    expect(result.score).toBeCloseTo(0.475, 6);
  });

  it('averages across reps (variance reduction)', async () => {
    let call = 0;
    const provider: LogProbProvider = vi.fn(async () => {
      call += 1;
      return call % 2 === 1
        ? structuredClone(skewedHigh) // 0.875
        : [
            { token: '1', logprob: Math.log(0.7) }, // 0.075
            { token: '2', logprob: Math.log(0.3) },
          ];
    });

    const executor = createVerifierScoringJudge({
      rubric: 'is correct',
      provider,
      reps: 2,
    });
    const result = await executor('candidate');

    expect(provider).toHaveBeenCalledTimes(2);
    expect(result.score).toBeCloseTo(0.475, 6);
  });
});

describe('createAnthropicLogProbProvider', () => {
  async function getMockCreate(): Promise<ReturnType<typeof vi.fn>> {
    const mod = (await import('@anthropic-ai/sdk' as string)) as {
      __mockCreate: ReturnType<typeof vi.fn>;
    };
    return mod.__mockCreate;
  }

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('extracts scoring-token logprobs from the Messages logprobs payload', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: '5',
          logprobs: [
            {
              token: '5',
              logprob: Math.log(0.6),
              top_logprobs: [
                { token: '5', logprob: Math.log(0.6) },
                { token: '4', logprob: Math.log(0.3) },
                { token: '3', logprob: Math.log(0.1) },
              ],
            },
          ],
        },
      ],
    });

    const provider = createAnthropicLogProbProvider({});
    const tokens = FIVE_POINT_SCALE.map((s) => s.token);
    const result = await provider('prompt', tokens);

    // Only the requested scoring tokens present in the payload are returned.
    const logOf = (token: string): number =>
      result.find((r) => r.token === token)?.logprob ?? Number.NaN;
    expect(logOf('5')).toBeCloseTo(Math.log(0.6), 6);
    expect(logOf('4')).toBeCloseTo(Math.log(0.3), 6);
    expect(logOf('3')).toBeCloseTo(Math.log(0.1), 6);
    // Tokens absent from the model's distribution are omitted.
    expect(result.find((r) => r.token === '1')).toBeUndefined();

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        logprobs: true,
        top_logprobs: 20,
      })
    );
  });
});
