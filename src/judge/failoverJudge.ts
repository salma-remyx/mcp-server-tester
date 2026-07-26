/**
 * Stateful, history-forwarding failover judge for multi-provider LLM routing.
 *
 * Adapted (Mode 2) from:
 *   ContinuityBench: A Benchmark and Systems Study of Stateful Failover in
 *   Multi-Provider LLM Routing (arXiv:2607.15899v1).
 *
 * ContinuityBench shows that stateless failover preserves uptime but silently
 * discards conversation history when a provider errors or rate-limits, and
 * proposes a stateful proxy that forwards the full conversation to a backup
 * provider — measured by Continuity Preservation Rate (CPR) and Continuity
 * Latency Overhead (CLO) — with asynchronous exponential backoff + jitter to
 * avoid cascading retry storms.
 *
 * Adaptation: single-shot judge evaluations carry no multi-turn history, so
 * the "continuity unit" forwarded across providers is the full judge request
 * (candidate + reference + rubric). The standalone continuity-bench harness is
 * intentionally out of scope; CPR/CLO are exposed on each {@link JudgeResult}
 * so they can be aggregated downstream.
 *
 * Components kept at full fidelity from the paper: ordered multi-provider
 * failover chain, history-forwarding of the continuity unit, jittered
 * exponential backoff between attempts, and the CPR/CLO metrics. Component cut
 * as a target-native substitution: the separate benchmark/eval framework.
 */
import type {
  FailoverBackoffConfig,
  Judge,
  JudgeConfig,
  JudgeResult,
} from './judgeTypes.js';

/** Ordered chain of providers to try on outage / rate-limit. */
export interface FailoverJudgeConfig {
  /** Primary provider config (its own `provider`/`model`); tried first. */
  primary: JudgeConfig;
  /** Ordered fallback providers tried after the primary errors. */
  fallbacks: JudgeConfig[];
  /** Maximum providers to try. Defaults to the primary plus every fallback. */
  maxAttempts?: number;
  /** Exponential backoff schedule applied between attempts. */
  backoff?: FailoverBackoffConfig;
}

/** Build dependency: factory that materializes each provider judge. */
export interface FailoverJudgeDeps {
  createJudge: (config: JudgeConfig) => Judge;
}

/** Resolved backoff schedule with defaults filled in. */
type ResolvedBackoff = Required<FailoverBackoffConfig>;

function resolveBackoff(
  config: FailoverBackoffConfig | undefined
): ResolvedBackoff {
  return {
    baseMs: config?.baseMs ?? 100,
    maxMs: config?.maxMs ?? 2000,
    factor: config?.factor ?? 2,
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with full jitter: a uniform sample in `[0, cap]` where
 * `cap = min(base * factor ** retryIndex, maxMs)`. Full jitter de-correlates
 * concurrent retries, preventing the cascading retry storms ContinuityBench
 * identifies against strict-limit fallback APIs.
 */
function jitteredBackoff(retryIndex: number, backoff: ResolvedBackoff): number {
  const exponential = backoff.baseMs * backoff.factor ** retryIndex;
  const cap = Math.min(exponential, backoff.maxMs);
  return Math.round(Math.random() * cap);
}

/**
 * Strips the `failover` field from a config before it is handed to a sub-judge,
 * so a primary cannot recurse into itself (the sub-judge is a plain provider).
 */
function stripFailover(config: JudgeConfig): JudgeConfig {
  if (config.failover === undefined) {
    return config;
  }
  const { failover: _omit, ...rest } = config;
  return rest;
}

/**
 * Creates a stateful, history-forwarding failover judge.
 *
 * On each `evaluate`, the primary provider is tried first; if it throws
 * (outage or rate-limit), the full continuity unit (candidate + reference +
 * rubric) is forwarded to the next fallback after a jittered backoff, until
 * one succeeds. If every provider errors, a failed result with `cpr: 0` is
 * returned rather than throwing, so sibling judges in a multi-judge
 * `Promise.all` are not killed by a single exhausted chain.
 *
 * Sub-providers are built with `deps.createJudge`. In production, pass the real
 * `createJudge`; tests inject fakes to control per-provider behavior.
 *
 * @param config - Failover chain configuration
 * @param deps   - Judge factory used to build each provider judge
 * @returns A {@link Judge} that fails over across providers
 */
export function createFailoverJudge(
  config: FailoverJudgeConfig,
  deps: FailoverJudgeDeps
): Judge {
  const backoff = resolveBackoff(config.backoff);

  const chain: { config: JudgeConfig; judge: Judge }[] = [
    {
      config: config.primary,
      judge: deps.createJudge(stripFailover(config.primary)),
    },
    ...config.fallbacks.map((cfg) => ({
      config: cfg,
      judge: deps.createJudge(stripFailover(cfg)),
    })),
  ];

  const maxAttempts = Math.min(
    config.maxAttempts ?? chain.length,
    chain.length
  );

  return {
    async evaluate(
      candidate: unknown,
      reference: unknown,
      rubric: string
    ): Promise<JudgeResult> {
      const startedAt = Date.now();
      const errors: unknown[] = [];

      for (let i = 0; i < maxAttempts; i++) {
        if (i > 0) {
          await sleep(jitteredBackoff(i - 1, backoff));
        }

        const entry = chain[i]!;
        const callStart = Date.now();
        try {
          const result = await entry.judge.evaluate(
            candidate,
            reference,
            rubric
          );
          const callMs = Date.now() - callStart;
          const elapsedMs = Date.now() - startedAt;
          const failoverOccurred = i > 0;

          return {
            ...result,
            failover: {
              failoverOccurred,
              servingProvider: entry.config.provider,
              servingModel: entry.config.model,
              attempts: i + 1,
              // The forwarded continuity unit yielded a valid result.
              cpr: 1,
              // Overhead of preserving continuity: everything but the
              // successful call itself (prior retries + backoff).
              cloMs: Math.max(elapsedMs - callMs, 0),
            },
          };
        } catch (err) {
          errors.push(err);
        }
      }

      // Every provider errored — continuity lost. Return a failed result
      // (with cpr: 0) instead of throwing, so a multi-judge Promise.all is
      // not killed by one exhausted chain.
      const lastError = errors[errors.length - 1];
      const elapsedMs = Date.now() - startedAt;
      return {
        pass: false,
        score: 0,
        reasoning:
          `All ${errors.length} failover providers errored. ` +
          `Last error: ${
            lastError instanceof Error ? lastError.message : String(lastError)
          }`,
        failover: {
          failoverOccurred: maxAttempts > 0,
          attempts: maxAttempts,
          cpr: 0,
          cloMs: elapsedMs,
        },
      };
    },
  };
}
