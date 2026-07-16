/**
 * Budget-aware resample-or-reroute (RoR) judge allocation.
 *
 * Adapted from "Resample or Reroute? Budget-Aware Test-Time Model Selection
 * for Large Language Models" (arXiv:2607.08665). The paper treats resampling
 * the committed model and rerouting to an alternative model as competing uses
 * of a single per-query cost budget, and proposes an online allocation policy
 * driven by estimated marginal correctness per unit cost, grounded in the
 * recoverability asymmetry between selection and sampling, with gains that
 * shrink as the verifier degrades.
 *
 * This module ports that allocation policy onto the judge-aggregation call
 * site, where each `passesJudge` config is one "model" (a provider/model pair
 * with a per-call cost and a quality prior) and `reps` is the resample count.
 * Two auxiliary components from the paper are substituted with parameter-free,
 * target-native equivalents (Mode 2 adapted port):
 *
 *   - Provider price vector          -> `estimateJudgeCallCostUsd` heuristic table.
 *   - Measured verifier quality      -> `estimateJudgeQuality` provider/model prior;
 *                                       verifier-gating is preserved by multiplying
 *                                       selection headroom by quality.
 *
 * The paper's multi-draw correctness-tensor replay over an open-weight pool is
 * intentionally out of scope: evaluation belongs in a downstream PR.
 */

import type { ProviderKind } from './judgeTypes.js';

/**
 * Structural input for cost/quality estimation. Both {@link JudgeConfig} and
 * the eval runner's `JudgeExpectConfig` satisfy this shape, so the allocator
 * reuses existing I/O rather than inventing a new data shape.
 */
export interface JudgeCostInput {
  provider?: ProviderKind;
  model?: string;
  reps?: number;
  maxBudgetUsd?: number;
}

/** Coarse per-call USD cost by provider (paper's price-vector substitute). */
const COST_BY_PROVIDER_USD: Record<ProviderKind, number> = {
  anthropic: 0.003,
  'vertex-anthropic': 0.003,
  'anthropic-agent-sdk': 0.005,
  openai: 0.005,
  google: 0.001,
};

/** Model-prefix cost overrides, checked most-specific first. */
const MODEL_COST_OVERRIDES: ReadonlyArray<{ match: RegExp; costUsd: number }> =
  [
    { match: /opus/i, costUsd: 0.012 },
    { match: /o1-|o3-|o4-/i, costUsd: 0.02 },
    { match: /gpt-4o/i, costUsd: 0.005 },
    { match: /gpt-4/i, costUsd: 0.01 },
    { match: /sonnet/i, costUsd: 0.003 },
    { match: /haiku/i, costUsd: 0.0006 },
    { match: /gemini.{0,7}pro/i, costUsd: 0.0035 },
    { match: /gemini.{0,7}flash/i, costUsd: 0.0003 },
  ];

/** Coarse verifier-quality prior by provider (0-1, 1 = perfectly reliable). */
const QUALITY_BY_PROVIDER: Record<ProviderKind, number> = {
  anthropic: 0.8,
  'vertex-anthropic': 0.8,
  'anthropic-agent-sdk': 0.82,
  openai: 0.78,
  google: 0.75,
};

/** Model-prefix quality overrides, checked most-specific first. */
const MODEL_QUALITY_OVERRIDES: ReadonlyArray<{
  match: RegExp;
  quality: number;
}> = [
  { match: /opus/i, quality: 0.9 },
  { match: /o1-|o3-|o4-/i, quality: 0.9 },
  { match: /sonnet/i, quality: 0.82 },
  { match: /gpt-4o/i, quality: 0.82 },
  { match: /gpt-4/i, quality: 0.8 },
  { match: /haiku/i, quality: 0.62 },
  { match: /gemini.{0,7}pro/i, quality: 0.82 },
  { match: /gemini.{0,7}flash/i, quality: 0.6 },
];

const DEFAULT_CALL_COST_USD = 0.005;
const DEFAULT_QUALITY = 0.75;
/** Floor on marginal-correctness-per-USD below which an action is not worth taking. */
const EPSILON = 1e-9;

function clampUnit(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function providerOrDefault(provider: ProviderKind | undefined): ProviderKind {
  return provider ?? 'anthropic';
}

/**
 * Estimates the USD cost of a single judge evaluation call. Parameter-free
 * heuristic substituting the paper's provider price vector.
 */
export function estimateJudgeCallCostUsd(input: JudgeCostInput): number {
  const model = input.model ?? '';
  for (const { match, costUsd } of MODEL_COST_OVERRIDES) {
    if (match.test(model)) return costUsd;
  }
  const provider = providerOrDefault(input.provider);
  return COST_BY_PROVIDER_USD[provider] ?? DEFAULT_CALL_COST_USD;
}

/**
 * Estimates a judge's verifier quality (0-1) from its provider/model.
 * Parameter-free prior substituting the paper's measured verifier quality.
 */
export function estimateJudgeQuality(input: JudgeCostInput): number {
  const model = input.model ?? '';
  for (const { match, quality } of MODEL_QUALITY_OVERRIDES) {
    if (match.test(model)) return quality;
  }
  const provider = providerOrDefault(input.provider);
  return QUALITY_BY_PROVIDER[provider] ?? DEFAULT_QUALITY;
}

/** Expected score standard deviation for a judge of reliability `quality` (Bernoulli std). */
function expectedScoreStdDev(quality: number): number {
  const q = clampUnit(quality);
  return Math.sqrt(q * (1 - q));
}

/** Population standard deviation of observed scores; 0 when fewer than 2 values. */
function sampleStdDev(scores: ReadonlyArray<number>): number {
  if (scores.length < 2) return 0;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance =
    scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
  return Math.sqrt(variance);
}

/**
 * Marginal reduction in the standard error of the judged score from one more
 * rep, given `repsAlready` reps are done (>= 1). Embodies the recoverability
 * asymmetry: resampling value decays as 1/sqrt(n) and vanishes once the
 * observed variance is gone (the first rep only establishes an estimate, so it
 * contributes no variance reduction and returns 0).
 */
function standardErrorReduction(sd: number, repsAlready: number): number {
  if (repsAlready < 1 || sd <= 0) return 0;
  return sd * (1 / Math.sqrt(repsAlready) - 1 / Math.sqrt(repsAlready + 1));
}

export type RoRAction = 'resample' | 'reroute' | 'stop';

/** A candidate judge the committed model could reroute to. */
export interface RoRAlternative {
  judge: JudgeCostInput;
  costUsd: number;
  quality: number;
}

/** Inputs to the online resample-or-reroute decision for one unit of budget. */
export interface RoRState {
  /** Per-call cost of the committed judge (USD). */
  committedCostUsd: number;
  /** Quality prior (0-1) of the committed judge; also the verifier-quality gate. */
  committedQuality: number;
  /** Reps already run on the committed judge. */
  committedReps: number;
  /** Observed rep scores (0-1) for the committed judge, if any. */
  committedScores?: number[];
  /** Candidate judges to reroute to. */
  alternatives: RoRAlternative[];
  /** Remaining per-query budget in USD. */
  remainingBudgetUsd: number;
}

/** The policy's decision for the next unit of budget. */
export interface RoRDecision {
  action: RoRAction;
  /** Present when `action === 'reroute'`. */
  rerouteJudge?: JudgeCostInput;
  /** Estimated marginal correctness per USD of the chosen action. */
  marginalCorrectnessPerUsd: number;
  rationale: string;
}

/**
 * Online resample-or-reroute allocation policy (the paper's core mechanism).
 *
 * Picks the next unit of budget by comparing the estimated marginal
 * correctness per unit cost of resampling the committed judge against
 * rerouting to the best alternative. Resampling value is the standard-error
 * reduction of the judged score (decaying in reps); rerouting value is the
 * selection headroom scaled by the committed judge's quality (verifier gating).
 * Returns `stop` when no affordable action has positive marginal value.
 */
export function chooseRoRAction(state: RoRState): RoRDecision {
  const {
    committedCostUsd,
    committedQuality,
    committedReps,
    committedScores,
    alternatives,
    remainingBudgetUsd,
  } = state;

  const observedSd =
    committedScores !== undefined && committedScores.length >= 2
      ? sampleStdDev(committedScores)
      : expectedScoreStdDev(committedQuality);
  const resampleGain = standardErrorReduction(observedSd, committedReps);
  const resamplePerUsd =
    committedCostUsd > 0 && remainingBudgetUsd >= committedCostUsd
      ? resampleGain / committedCostUsd
      : 0;

  let bestAlt: RoRAlternative | null = null;
  let bestReroutePerUsd = 0;
  for (const alt of alternatives) {
    if (alt.costUsd <= 0 || remainingBudgetUsd < alt.costUsd) continue;
    const headroom = Math.max(0, alt.quality - committedQuality);
    if (headroom <= 0) continue;
    const perUsd = (headroom * committedQuality) / alt.costUsd;
    if (perUsd > bestReroutePerUsd) {
      bestReroutePerUsd = perUsd;
      bestAlt = alt;
    }
  }

  if (bestAlt !== null && bestReroutePerUsd > resamplePerUsd + EPSILON) {
    const headroom = Math.max(0, bestAlt.quality - committedQuality);
    return {
      action: 'reroute',
      rerouteJudge: bestAlt.judge,
      marginalCorrectnessPerUsd: bestReroutePerUsd,
      rationale:
        `Reroute to stronger judge (selection headroom ${headroom.toFixed(3)} ` +
        `gated by verifier quality ${committedQuality.toFixed(2)}; ` +
        `${bestReroutePerUsd.toExponential(2)} correctness/USD vs resample ` +
        `${resamplePerUsd.toExponential(2)}).`,
    };
  }

  if (resampleGain > EPSILON && remainingBudgetUsd >= committedCostUsd) {
    return {
      action: 'resample',
      marginalCorrectnessPerUsd: resamplePerUsd,
      rationale:
        `Resample committed judge (SE reduction ${resampleGain.toFixed(4)} at ` +
        `${committedReps} reps; ${resamplePerUsd.toExponential(2)} correctness/USD).`,
    };
  }

  return {
    action: 'stop',
    marginalCorrectnessPerUsd: 0,
    rationale:
      'Stop: no affordable action has positive marginal correctness per unit cost.',
  };
}

/** Input to {@link planJudgeBudget}. */
export interface JudgeBudgetPlanInput {
  /** Configured judges, in declared order. */
  judges: ReadonlyArray<JudgeCostInput>;
  /** Default reps when a judge does not specify its own. */
  defaultReps: number;
  /**
   * Shared per-query budget in USD. When undefined, each judge keeps its own
   * reps and no budget-aware allocation runs (preserves existing behavior).
   */
  budgetUsd?: number;
  /** Override the verifier-quality gate (defaults to each judge's own quality). */
  verifierQuality?: number;
}

/** Budget-aware allocation plan, parallel to the input judges array. */
export interface JudgeBudgetPlan {
  /** Effective reps per judge. */
  reps: number[];
  /** Estimated total spend in USD at the planned reps. */
  estimatedSpendUsd: number;
  /**
   * True when budget pressure left at least one judge below its requested
   * reps — i.e. the allocator engaged in resample/reroute trade-offs rather
   * than honoring every request. False when the budget was ample or unset.
   */
  reallocated: boolean;
  /** Human-readable trace of allocation decisions. */
  trace: string[];
}

function totalSpend(
  reps: ReadonlyArray<number>,
  judges: ReadonlyArray<JudgeCostInput>
): number {
  let total = 0;
  for (let i = 0; i < reps.length; i++) {
    const judge = judges[i];
    total += (reps[i] ?? 0) * (judge ? estimateJudgeCallCostUsd(judge) : 0);
  }
  return total;
}

/**
 * Allocates a per-query budget across the configured judges by estimated
 * marginal correctness per unit cost — the synchronous application of the
 * online RoR policy at plan time.
 *
 * Every configured judge always receives at least one rep (listed judges are
 * never dropped, preserving AND-semantics); extra reps are funded greedily by
 * marginal correctness per USD. With no budget set, returns each judge's own
 * reps unchanged (existing fixed-reps behavior). "Rerouting" emerges
 * naturally: a stronger judge's rep is worth more per dollar, so budget
 * pressure shifts spend from weaker judges toward stronger ones.
 */
export function planJudgeBudget(input: JudgeBudgetPlanInput): JudgeBudgetPlan {
  const { judges, defaultReps, budgetUsd, verifierQuality } = input;

  if (judges.length === 0) {
    return { reps: [], estimatedSpendUsd: 0, reallocated: false, trace: [] };
  }

  const requestedReps = judges.map((j) => Math.max(1, j.reps ?? defaultReps));

  // No budget set -> identity (preserves existing fixed-reps behavior).
  if (budgetUsd === undefined) {
    return {
      reps: requestedReps,
      estimatedSpendUsd: totalSpend(requestedReps, judges),
      reallocated: false,
      trace: ['No per-query budget set; using each judge’s own reps.'],
    };
  }

  const profiled = judges.map((j) => ({
    costUsd: estimateJudgeCallCostUsd(j),
    quality: verifierQuality ?? estimateJudgeQuality(j),
    requested: Math.max(1, j.reps ?? defaultReps),
  }));

  // Baseline: every listed judge runs at least once (never drop a judge).
  const reps = profiled.map(() => 1);
  const baselineSpend = profiled.reduce((sum, p) => sum + p.costUsd, 0);
  let remaining = budgetUsd - baselineSpend;
  const trace: string[] = [
    `Baseline: 1 rep per judge (${profiled.length} judges, ` +
      `$${baselineSpend.toFixed(4)}); remaining budget $${remaining.toFixed(4)}.`,
  ];

  const MAX_REPS_PER_JUDGE = 32;

  // Greedy: fund the marginal rep with the highest expected correctness per USD.
  while (remaining > 0) {
    let bestIndex = -1;
    let bestPerUsd = 0;
    let bestGain = 0;
    for (let i = 0; i < profiled.length; i++) {
      const p = profiled[i]!;
      const current = reps[i]!;
      if (current >= p.requested || current >= MAX_REPS_PER_JUDGE) continue;
      if (remaining < p.costUsd) continue;
      const sd = expectedScoreStdDev(p.quality);
      const gain = standardErrorReduction(sd, current) * p.quality;
      const perUsd = gain / p.costUsd;
      if (perUsd > bestPerUsd) {
        bestPerUsd = perUsd;
        bestIndex = i;
        bestGain = gain;
      }
    }
    if (bestIndex < 0 || bestGain <= EPSILON) break;
    const p = profiled[bestIndex]!;
    reps[bestIndex] = reps[bestIndex]! + 1;
    remaining -= p.costUsd;
    trace.push(
      `+1 rep judge[${bestIndex}] (gain ${bestGain.toFixed(4)}, ` +
        `${bestPerUsd.toExponential(2)} correctness/USD); remaining ` +
        `$${remaining.toFixed(4)}.`
    );
  }

  // The budget was binding when at least one judge could not reach its
  // requested reps — the allocator traded off resample vs reroute spend.
  const reallocated = profiled.some((p, i) => reps[i]! < p.requested);
  if (reallocated) {
    trace.push(
      'Budget binding: at least one judge ran below its requested reps.'
    );
  }

  return {
    reps,
    estimatedSpendUsd: totalSpend(reps, judges),
    reallocated,
    trace,
  };
}
