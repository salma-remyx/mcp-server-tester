import { z } from 'zod';

/**
 * Zod schema for validating judge LLM responses.
 * Ensures the response has the required structure before it is used.
 */
export const JudgeResponseSchema = z.object({
  pass: z.boolean(),
  score: z.number().min(0).max(1),
  reasoning: z.string(),
});

/**
 * The validated shape returned by a judge LLM.
 */
export type JudgeResponse = z.infer<typeof JudgeResponseSchema>;

/**
 * Usage metrics from Claude Agent SDK response
 */
export interface UsageMetrics {
  /**
   * Number of input tokens consumed
   */
  inputTokens: number;

  /**
   * Number of output tokens generated
   */
  outputTokens: number;

  /**
   * Total cost in USD
   */
  totalCostUsd: number;

  /**
   * Execution duration in milliseconds
   */
  durationMs: number;

  /**
   * API call duration in milliseconds (excluding network overhead)
   */
  durationApiMs?: number;

  /**
   * Number of tokens read from cache
   */
  cacheReadInputTokens?: number;

  /**
   * Number of tokens written to cache
   */
  cacheCreationInputTokens?: number;
}

/** Valid LLM judge provider kinds. */
export type ProviderKind =
  | 'anthropic'
  | 'vertex-anthropic'
  | 'anthropic-agent-sdk'
  | 'openai'
  | 'google';

/**
 * Configuration for an LLM judge
 */
export interface JudgeConfig {
  /**
   * LLM provider to use
   * @default 'anthropic'
   */
  provider?: ProviderKind;

  /**
   * Environment variable name containing the API key
   * @default 'ANTHROPIC_API_KEY'
   */
  apiKeyEnvVar?: string;

  /**
   * Model to use for judging
   * @default 'claude-sonnet-4-20250514'
   */
  model?: string;

  /**
   * Maximum tokens for response
   * @default 1000
   */
  maxTokens?: number;

  /**
   * Temperature (0-1, lower is more deterministic)
   * @default 0.0
   */
  temperature?: number;

  /**
   * Maximum budget in USD for the judge evaluation
   * @default 0.10
   */
  maxBudgetUsd?: number;

  /**
   * Maximum size (in bytes) for tool output before failing the test
   * When set, the judge will fail if the candidate response exceeds this size
   */
  maxToolOutputSize?: number;

  /**
   * Stateful failover chain. When set, this config's own `provider`/`model`
   * is the primary and `fallbacks` are tried in order on outage/rate-limit,
   * forwarding the full continuity unit (candidate + reference + rubric) to
   * each fallback. Adapted from ContinuityBench (arXiv:2607.15899v1).
   */
  failover?: FailoverConfig;
}

/**
 * Exponential backoff schedule (applied with full jitter) between failover
 * attempts. Jitter de-correlates concurrent retries to avoid cascading retry
 * storms against strict-limit fallback APIs.
 */
export interface FailoverBackoffConfig {
  /** Base delay in ms. @default 100 */
  baseMs?: number;
  /** Maximum delay cap in ms. @default 2000 */
  maxMs?: number;
  /** Backoff multiplier. @default 2 */
  factor?: number;
}

/**
 * Stateful failover configuration. The judge's own provider acts as the
 * primary; fallbacks are tried in sequence — forwarding the continuity unit —
 * until one succeeds. Each result carries Continuity Preservation Rate (CPR)
 * and Continuity Latency Overhead (CLO) via {@link FailoverMetrics}.
 */
export interface FailoverConfig {
  /** Ordered fallback providers tried after the primary errors. */
  fallbacks: JudgeConfig[];
  /** Max providers to try. @default primary + all fallbacks */
  maxAttempts?: number;
  /** Backoff schedule between attempts. */
  backoff?: FailoverBackoffConfig;
}

/**
 * Result from LLM judge evaluation
 */
export interface JudgeResult {
  /**
   * Whether the evaluation passed
   */
  pass: boolean;

  /**
   * Numeric score (0-1, where 1 is best)
   */
  score?: number;

  /**
   * Reasoning/explanation from the judge
   */
  reasoning?: string;

  /**
   * Usage metrics from the Claude Agent SDK
   */
  usage?: UsageMetrics;

  /**
   * Size of the candidate response in bytes (for maxToolOutputSize tracking)
   */
  candidateSizeBytes?: number;

  /**
   * Whether the candidate exceeded maxToolOutputSize
   */
  exceedsMaxToolOutputSize?: boolean;

  /**
   * Standard deviation of individual rep scores.
   * Only populated when the judge was run with reps > 1.
   */
  scoreStdDev?: number;

  /**
   * True when the standard deviation across reps exceeds 0.2, indicating
   * that the rubric may be ambiguous or the judge is non-deterministic.
   * Only populated when the judge was run with reps > 1.
   */
  highVariance?: boolean;

  /**
   * Individual scores from each judge rep.
   * Only populated when the judge was run with reps > 1.
   */
  scores?: number[];

  /**
   * Stateful failover metrics (CPR + CLO) when the judge ran with a
   * `failover` chain. Carries which provider actually served the request.
   */
  failover?: FailoverMetrics;
}

/**
 * Continuity / failover metrics adapted from ContinuityBench.
 *
 * - CPR (Continuity Preservation Rate): 1 when the continuity unit was
 *   preserved across a failover and yielded a valid result; 0 when every
 *   provider errored (continuity lost). Aggregate over `failoverOccurred`
 *   events for the benchmark CPR.
 * - CLO (Continuity Latency Overhead): extra ms spent on retries/backoff
 *   relative to the successful call itself — the latency cost of preserving
 *   continuity.
 */
export interface FailoverMetrics {
  /** True if the primary errored and a fallback served the request. */
  failoverOccurred: boolean;
  /** Provider that actually produced the result (failover provenance). */
  servingProvider?: ProviderKind;
  /** Model that actually produced the result (failover provenance). */
  servingModel?: string;
  /** Number of providers tried. */
  attempts: number;
  /** Continuity Preservation Rate for this request (0 or 1). */
  cpr: number;
  /** Continuity Latency Overhead in ms. */
  cloMs: number;
}

export type { BuiltInRubric, RubricSpec } from './rubrics.js';
export { BUILT_IN_RUBRICS, resolveRubric, isBuiltInRubric } from './rubrics.js';

/**
 * LLM judge client interface
 */
export interface Judge {
  /**
   * Evaluates a candidate response against a reference
   *
   * @param candidate - The actual response to evaluate
   * @param reference - The expected/reference response (or null if not applicable)
   * @param rubric - The evaluation rubric/criteria
   * @returns Evaluation result with usage metrics
   */
  evaluate(
    candidate: unknown,
    reference: unknown,
    rubric: string
  ): Promise<JudgeResult>;
}
