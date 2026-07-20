/**
 * Composed Judge — scaling judge-time compute by composing modular reasoning
 * units and aggregating their verdicts.
 *
 * Adapted from "Verdict: A Library for Scaling Judge-Time Compute"
 * (https://arxiv.org/abs/2502.18018v1). The paper's core mechanism —
 * permutation (distinct evaluation units) → reflection (a judge eval per
 * unit) → vote (aggregation of the unit verdicts) — is implemented here at
 * full fidelity. The auxiliary LLM runtime is NOT ported: each unit reuses
 * the repo's existing `Judge` / `createJudge` infrastructure. No bespoke
 * benchmark suite is included (evaluation belongs downstream).
 *
 * Distinct from the existing `reps` loop (which mean-averages identical
 * rubric calls) and from confidence-gated aggregation: composition runs
 * *distinct* perspectives and aggregates *discrete* verdicts.
 */

import type { Judge, JudgeConfig } from './judgeTypes.js';
import type { RubricSpec } from './rubrics.js';
import { resolveRubric } from './rubrics.js';
import { createJudge } from './judgeClient.js';
import type { CustomJudgeResult } from './judgeRegistry.js';

/**
 * A single reasoning unit: a named evaluation perspective and its rubric.
 * The set of units is the "permutation" — the distinct angles the composed
 * judge reasons over before voting.
 */
export interface JudgeUnit {
  /** Label for the unit, surfaced in per-unit reasoning for interpretability. */
  name: string;
  /** Rubric for this unit: a built-in name or a custom { text } object. */
  rubric: RubricSpec;
}

/**
 * Strategy for combining unit verdicts into a single score.
 *
 * - `majority` — score is the fraction of units that pass (vote share).
 *   Set the caller's threshold to `0.5` for strict-majority semantics.
 * - `mean` — score is the mean of the per-unit scores.
 */
export type ComposeAggregator = 'majority' | 'mean';

/**
 * One unit's verdict, surfaced in the composed result for interpretability
 * (a Verdict selling point: the aggregate is decomposable into its parts).
 */
export interface ComposeUnitResult {
  /** Name of the unit that produced this verdict. */
  unit: string;
  /** Whether the unit's judge eval passed. */
  pass: boolean;
  /** Normalized score (0–1) from the unit's judge eval. */
  score: number;
  /** Optional reasoning from the unit's judge eval. */
  reasoning?: string;
}

/**
 * Result of a composed judge. Extends {@link CustomJudgeResult} with the
 * per-unit breakdown and the aggregator used, so a composed judge is also
 * registerable via `registerJudge()` (it satisfies the executor contract).
 */
export interface ComposedJudgeResult extends CustomJudgeResult {
  /** Per-unit verdicts, for interpretability. */
  unitResults: ComposeUnitResult[];
  /** Aggregation strategy used to derive `score`. */
  aggregator: ComposeAggregator;
}

/**
 * Named presets bundling complementary units into a ready-made permutation set.
 *
 * - `verify` — verification-oriented: correctness + groundedness.
 * - `quality` — broad quality: correctness + completeness + instruction-following.
 */
export type ComposePreset = 'verify' | 'quality';

export const COMPOSE_PRESETS: Record<ComposePreset, JudgeUnit[]> = {
  verify: [
    { name: 'correctness', rubric: 'correctness' },
    { name: 'groundedness', rubric: 'groundedness' },
  ],
  quality: [
    { name: 'correctness', rubric: 'correctness' },
    { name: 'completeness', rubric: 'completeness' },
    { name: 'instruction-following', rubric: 'instruction-following' },
  ],
};

/**
 * Configuration for {@link createComposedJudge}.
 */
export interface JudgeComposeConfig {
  /**
   * Units to compose. Exactly one of `units` or `preset` is required.
   * If both are supplied, `units` wins.
   */
  units?: JudgeUnit[];
  /** Named preset of units. Ignored when `units` is supplied. */
  preset?: ComposePreset;
  /** Aggregation strategy. @default 'majority' */
  aggregator?: ComposeAggregator;
  /**
   * Base judge configuration (provider, model, temperature, …) forwarded to
   * `createJudge` for each unit's eval.
   */
  judge?: JudgeConfig;
  /**
   * Inject a base judge directly — useful for tests or for reusing a custom
   * `Judge`. When set, `judge` config is ignored.
   */
  judgeInstance?: Judge;
}

/**
 * A composed judge executor. Returns a richer result than the base
 * {@link CustomJudgeExecutor} (per-unit breakdown), but is structurally
 * compatible with it — so a composed judge can be registered by name.
 */
export type ComposedJudgeExecutor = (
  candidate: unknown,
  reference?: unknown
) => Promise<ComposedJudgeResult>;

function resolveUnits(config: JudgeComposeConfig): JudgeUnit[] {
  if (config.units !== undefined) {
    if (config.units.length === 0) {
      throw new Error('JudgeComposeConfig.units must be a non-empty array');
    }
    return config.units;
  }
  if (config.preset !== undefined) {
    return COMPOSE_PRESETS[config.preset];
  }
  throw new Error(
    'JudgeComposeConfig requires either "units" or "preset" to be set'
  );
}

function aggregateScores(
  results: ComposeUnitResult[],
  aggregator: ComposeAggregator
): number {
  if (results.length === 0) return 0;
  if (aggregator === 'mean') {
    const sum = results.reduce((acc, r) => acc + r.score, 0);
    return sum / results.length;
  }
  // majority: vote share = fraction of units that pass
  const passes = results.filter((r) => r.pass).length;
  return passes / results.length;
}

function formatReasoning(
  results: ComposeUnitResult[],
  aggregator: ComposeAggregator,
  score: number
): string {
  const lines = results.map(
    (r) => `  - ${r.unit}: ${r.pass ? 'PASS' : 'FAIL'} (${r.score.toFixed(2)})`
  );
  return (
    `${aggregator} aggregation over ${results.length} unit(s) -> score ${score.toFixed(2)}:\n` +
    lines.join('\n')
  );
}

/**
 * Creates a composed (Verdict-style) judge that runs each unit as a separate
 * judge eval and aggregates the verdicts.
 *
 * The base judge is resolved lazily (on first eval) via `createJudge` unless
 * one is injected, so constructing the executor does not require an API key.
 *
 * @param config - Units/preset, aggregator, and base-judge configuration
 * @returns A composed judge executor
 *
 * @example
 * ```typescript
 * import { createComposedJudge, registerJudge } from '@gleanwork/mcp-server-tester';
 *
 * // Register a composed judge by name, then reference it in eval fixtures
 * registerJudge('verify-strict', createComposedJudge({ preset: 'verify' }));
 *
 * // Or use programmatically:
 * const executor = createComposedJudge({
 *   preset: 'quality',
 *   aggregator: 'majority',
 * });
 * const { score, unitResults } = await executor(candidateResponse, reference);
 * ```
 */
export function createComposedJudge(
  config: JudgeComposeConfig
): ComposedJudgeExecutor {
  const units = resolveUnits(config);
  const aggregator: ComposeAggregator = config.aggregator ?? 'majority';

  // Lazily resolve the base judge so construction is side-effect free.
  const getJudge = (): Judge =>
    config.judgeInstance ?? createJudge(config.judge ?? {});

  return async function composedJudge(
    candidate: unknown,
    reference?: unknown
  ): Promise<ComposedJudgeResult> {
    const judge = getJudge();
    const unitResults: ComposeUnitResult[] = [];

    for (const unit of units) {
      const result = await judge.evaluate(
        candidate,
        reference ?? null,
        resolveRubric(unit.rubric)
      );
      const score = result.score ?? (result.pass ? 1.0 : 0.0);
      unitResults.push({
        unit: unit.name,
        pass: result.pass,
        score,
        reasoning: result.reasoning,
      });
    }

    const score = aggregateScores(unitResults, aggregator);
    const reasoning = formatReasoning(unitResults, aggregator, score);

    return { score, reasoning, unitResults, aggregator };
  };
}
