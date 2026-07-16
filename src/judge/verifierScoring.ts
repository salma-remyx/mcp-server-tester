/**
 * Continuous (logit-based) verification scoring for custom LLM judges.
 *
 * Adapted from "LLM-as-a-Verifier: A General-Purpose Verification Framework"
 * (https://arxiv.org/abs/2607.05391v1). Where the framework's built-in judges
 * ask an LLM to emit a discrete score, this module instead reads the model's
 * logit distribution over a small set of *scoring tokens* and computes the
 * expected score `E[s] = Σ score_i · P(token_i)`. The result is continuous and
 * calibrated: small shifts in evidence move probability mass between tokens
 * and therefore the score, yielding better separation between candidates than
 * a discrete verdict.
 *
 * The paper scales verification along three axes; all three are exposed here:
 *   1. Score granularity — pass a wider `scale` (e.g. `TEN_POINT_SCALE`) for
 *      finer separation between positive and negative solutions.
 *   2. Repeated evaluation — set `reps` to average several samples and cut
 *      variance (the executor owns its pipeline, mirroring the framework's
 *      reps / judgeReps variance-reduction for the built-in judges).
 *   3. Criteria decomposition — pass `criteria` to score each sub-criterion
 *      independently and average, reducing per-judge complexity.
 *
 * This is an *adapted port* (Mode 2): the core continuous-scoring mechanism is
 * faithful, but it plugs into the repo's existing custom-judge registry
 * (`registerJudge` / `CustomJudgeExecutor`) rather than the paper's standalone
 * verifier, and uses the Anthropic Messages API `top_logprobs` as the logit
 * source instead of a bespoke inference path.
 */

import { registerJudge, type CustomJudgeExecutor } from './judgeRegistry.js';

/** A token the model may emit and the normalized score (0–1) it represents. */
export interface ScoringToken {
  token: string;
  /** Normalized score in [0, 1]; 1 is best. */
  score: number;
}

/** An ordered set of scoring tokens spanning the score range. */
export type ScoringScale = ScoringToken[];

/** A token paired with the natural-log probability the model assigned it. */
export interface TokenLogProb {
  token: string;
  /** Natural-log probability (logprob). */
  logprob: number;
}

/** Per-token breakdown of an expected-score computation. */
export interface ScoreDistributionEntry {
  token: string;
  score: number;
  /** Probability mass, renormalized over the scoring tokens. */
  probability: number;
}

export interface ExpectedScoreResult {
  /** Expected score `E[s] = Σ score_i · P(token_i)`, in [0, 1]. */
  score: number;
  /** Per-token probability breakdown. */
  distribution: ScoreDistributionEntry[];
  /** True when no scoring token was present in the model's distribution. */
  empty: boolean;
}

/**
 * A scoring-token logprob source. Decoupled from any specific model API so the
 * expected-score math is unit-testable without a live LLM call. Use
 * {@link createAnthropicLogProbProvider} for the real Anthropic Messages path.
 *
 * @param prompt - The verifier prompt (already asks for a single scoring token).
 * @param scoringTokens - The tokens whose logprobs should be reported.
 * @returns The logprob assigned to each requested token at the scoring
 *   position. Tokens absent from the model's returned distribution may be
 *   omitted (they are treated as zero probability downstream).
 */
export type LogProbProvider = (
  prompt: string,
  scoringTokens: string[]
) => Promise<TokenLogProb[]>;

/** 5-point scale: tokens "1".."5" mapped to 0.0..1.0. */
export const FIVE_POINT_SCALE: ScoringScale = [
  { token: '1', score: 0.0 },
  { token: '2', score: 0.25 },
  { token: '3', score: 0.5 },
  { token: '4', score: 0.75 },
  { token: '5', score: 1.0 },
];

/** 10-point scale: tokens "1".."10" mapped evenly across [0, 1]. */
export const TEN_POINT_SCALE: ScoringScale = Array.from(
  { length: 10 },
  (_, i) => ({ token: String(i + 1), score: i / 9 })
);

/** Converts a natural-log probability into a linear probability. */
export function logprobToProbability(logprob: number): number {
  return Math.exp(logprob);
}

/**
 * Computes the continuous expected score from a logit distribution.
 *
 * Probabilities are renormalized over the scoring tokens actually present in
 * the distribution (the paper restricts verification to the scoring tokens),
 * so the result is well-defined regardless of how the provider clipped the tail.
 */
export function computeExpectedScore(
  tokenLogProbs: TokenLogProb[],
  scale: ScoringScale
): ExpectedScoreResult {
  const probByToken = new Map<string, number>();
  for (const { token, logprob } of tokenLogProbs) {
    probByToken.set(token, logprobToProbability(logprob));
  }

  const entries: ScoreDistributionEntry[] = [];
  let total = 0;
  for (const { token, score } of scale) {
    const probability = probByToken.get(token) ?? 0;
    entries.push({ token, score, probability });
    total += probability;
  }

  if (total <= 0) {
    return { score: 0, distribution: entries, empty: true };
  }

  let expected = 0;
  for (const entry of entries) {
    entry.probability /= total;
    expected += entry.score * entry.probability;
  }

  return { score: expected, distribution: entries, empty: false };
}

/**
 * Builds the verifier prompt. Instructs the model to emit exactly one scoring
 * token so the first generated token's logit distribution is meaningful.
 */
export function buildVerifierPrompt(options: {
  criterion: string;
  candidate: unknown;
  reference?: unknown;
  scale: ScoringScale;
}): string {
  const { criterion, candidate, reference, scale } = options;
  const candidateStr =
    typeof candidate === 'string'
      ? candidate
      : JSON.stringify(candidate, null, 2);
  const referenceStr =
    reference !== null && reference !== undefined
      ? typeof reference === 'string'
        ? reference
        : JSON.stringify(reference, null, 2)
      : null;
  const tokens = scale.map((s) => s.token).join(', ');
  const lo = scale[0];
  const hi = scale[scale.length - 1];
  if (lo === undefined || hi === undefined) {
    throw new Error('buildVerifierPrompt requires a non-empty scale.');
  }

  return (
    `You are a strict verifier. Read the criterion, then emit a single token ` +
    `from this set: {${tokens}}. Token "${lo.token}" means the candidate ` +
    `completely fails the criterion; "${hi.token}" means it fully satisfies it. ` +
    `Output ONLY that one token — no explanation, no punctuation.\n\n` +
    `Criterion:\n${criterion}\n\n` +
    `<candidate>\n${candidateStr}\n</candidate>\n` +
    (referenceStr !== null
      ? `\n<reference>\n${referenceStr}\n</reference>\n`
      : '') +
    `\nSingle token:`
  );
}

/** Configuration for {@link createAnthropicLogProbProvider}. */
export interface AnthropicLogProbProviderConfig {
  /** Environment variable holding the API key. @default 'ANTHROPIC_API_KEY' */
  apiKeyEnvVar?: string;
  /** Model id. @default 'claude-sonnet-4-20250514' */
  model?: string;
  /** Max tokens. Only the scoring token matters, so 1 is enough. @default 1 */
  maxTokens?: number;
  /** Sampling temperature. >0 enables variance across reps. @default 0 */
  temperature?: number;
}

/** Options for constructing a continuous-scoring verifier judge. */
export interface VerifierScoringOptions {
  /**
   * The rubric to verify against. Ignored when `criteria` is provided.
   * Required when `criteria` is omitted.
   */
  rubric?: string;
  /**
   * Criteria decomposition: score each criterion independently and average,
   * reducing per-judge complexity. When omitted, the single `rubric` is the
   * sole criterion.
   */
  criteria?: string[];
  /** Scoring-token scale. @default FIVE_POINT_SCALE */
  scale?: ScoringScale;
  /** Logit source for the scoring token. Required (inject a fake in tests). */
  provider: LogProbProvider;
  /**
   * Repeated evaluations to average (variance reduction). Samples are
   * independent only if the provider samples at temperature > 0.
   * @default 1
   */
  reps?: number;
}

/**
 * Builds a {@link CustomJudgeExecutor} that scores a candidate continuously via
 * the LLM-as-a-Verifier logit-expectation method. Register it with
 * {@link registerVerifierScoringJudge} (or `registerJudge`) and reference it by
 * name through `toPassToolJudge({ judge: 'name' })`.
 */
export function createVerifierScoringJudge(
  options: VerifierScoringOptions
): CustomJudgeExecutor {
  const {
    rubric,
    criteria,
    scale = FIVE_POINT_SCALE,
    provider,
    reps = 1,
  } = options;

  const resolvedCriteria: string[] | null =
    criteria !== undefined && criteria.length > 0
      ? criteria
      : rubric !== undefined
        ? [rubric]
        : null;

  if (resolvedCriteria === null) {
    throw new Error(
      'createVerifierScoringJudge requires either `rubric` or `criteria`.'
    );
  }

  const tokens = scale.map((s) => s.token);

  return async (candidate, reference) => {
    const criterionScores: number[] = [];

    for (const criterion of resolvedCriteria) {
      const prompt = buildVerifierPrompt({
        criterion,
        candidate,
        reference: reference ?? null,
        scale,
      });

      const repScores: number[] = [];
      for (let i = 0; i < reps; i++) {
        const tokenLogProbs = await provider(prompt, tokens);
        const result = computeExpectedScore(tokenLogProbs, scale);
        repScores.push(result.score);
      }

      criterionScores.push(
        repScores.reduce((sum, s) => sum + s, 0) / repScores.length
      );
    }

    const score =
      criterionScores.reduce((sum, s) => sum + s, 0) / criterionScores.length;

    return {
      score,
      reasoning:
        `LLM-as-a-Verifier continuous score (expected over a ${tokens.length}-point ` +
        `scale, ${reps} rep${reps === 1 ? '' : 's'}, ${resolvedCriteria.length} ` +
        `criterion${resolvedCriteria.length === 1 ? '' : 'a'}): mean=${score.toFixed(3)}`,
    };
  };
}

/**
 * Convenience wrapper: builds a continuous-scoring verifier judge and registers
 * it under `name` in the custom-judge registry. This is the integration call
 * site — it wires the verifier into the existing {@link registerJudge} registry
 * so it can be referenced via `toPassToolJudge({ judge: name })`.
 */
export function registerVerifierScoringJudge(
  name: string,
  options: VerifierScoringOptions
): void {
  registerJudge(name, createVerifierScoringJudge(options));
}

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
/**
 * Builds a {@link LogProbProvider} backed by the Anthropic Messages API with
 * `top_logprobs` enabled. Requires the `@anthropic-ai/sdk` package and an API
 * key. Tokens absent from the model's returned top-logprobs are omitted (treated
 * as zero probability), which is a safe approximation for small scales whose
 * scoring tokens dominate the distribution.
 */
export function createAnthropicLogProbProvider(
  config: AnthropicLogProbProviderConfig = {}
): LogProbProvider {
  const apiKeyEnvVar = config.apiKeyEnvVar ?? 'ANTHROPIC_API_KEY';
  const model = config.model ?? 'claude-sonnet-4-20250514';
  const maxTokens = config.maxTokens ?? 1;
  const temperature = config.temperature ?? 0.0;

  return async (prompt, scoringTokens) => {
    const apiKey = process.env[apiKeyEnvVar];
    if (!apiKey) {
      throw new Error(
        `Anthropic verifier requires the ${apiKeyEnvVar} environment variable.`
      );
    }

    let sdk: any;
    try {
      // @ts-expect-error - optional dependency: npm install @anthropic-ai/sdk
      sdk = await import('@anthropic-ai/sdk');
    } catch (err) {
      throw new Error(
        'Anthropic verifier requires the `@anthropic-ai/sdk` package. ' +
          'Install it with: npm install @anthropic-ai/sdk\n' +
          `Original error: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const client = new sdk.default({ apiKey });
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      logprobs: true,
      top_logprobs: 20,
      messages: [{ role: 'user', content: prompt }],
    });

    // Merge logprobs across every text position (robust to leading-space or
    // multi-token artifacts), keeping the highest logprob per token.
    const positions: any[] = (response.content as any[]).flatMap(
      (block: any) => (Array.isArray(block.logprobs) ? block.logprobs : [])
    );

    const best = new Map<string, number>();
    for (const position of positions) {
      const candidates: any[] = Array.isArray(position?.top_logprobs)
        ? position.top_logprobs
        : [];
      if (
        typeof position?.token === 'string' &&
        typeof position?.logprob === 'number'
      ) {
        candidates.push({ token: position.token, logprob: position.logprob });
      }
      for (const entry of candidates) {
        const token: string =
          typeof entry?.token === 'string' ? entry.token.trim() : '';
        const logprob: number =
          typeof entry?.logprob === 'number' ? entry.logprob : Number.NaN;
        if (token === '' || Number.isNaN(logprob)) {
          continue;
        }
        const prev = best.get(token);
        if (prev === undefined || logprob > prev) {
          best.set(token, logprob);
        }
      }
    }

    return scoringTokens
      .filter((t) => best.has(t))
      .map((t) => ({ token: t, logprob: best.get(t) as number }));
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
