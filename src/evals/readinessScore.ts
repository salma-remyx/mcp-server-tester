/**
 * Readiness scoring — turns a completed eval run into a deployment decision.
 *
 * Inspired by "LLM Readiness Harness: Evaluation, Observability, and CI Gates
 * for LLM/RAG Applications" (arXiv:2603.27355). That work aggregates workflow
 * success, groundedness, cost, and p95 latency into scenario-weighted readiness
 * scores, Pareto frontiers, and CI quality gates. This module ports that
 * *aggregation/decision* layer onto the signals this repo already collects per
 * eval case (pass / pass-rate CI / durationMs / hostUsage cost / judge +
 * tool-recall quality), without the paper's separate OpenTelemetry backend or
 * benchmark suite.
 *
 * The function is pure: it reads an array of `EvalCaseResult` and returns a
 * `ReadinessAssessment`. It is wired into `MCPReporter.buildRunData()` so every
 * generated report and externally stored run carries a readiness verdict, and it
 * is exported as a public API (`computeReadiness`) for programmatic use — the
 * same shape as `compareEvalRuns`.
 *
 * @packageDocumentation
 */

import type { EvalCaseResult } from '../types/reporter.js';
import type { UsageMetrics } from '../types/index.js';

/**
 * Per-component weights for the overall readiness score.
 * Weights are renormalized to sum to 1 before blending, so any positive scale works.
 */
export interface ReadinessWeights {
  /** Weight on the (scenario-weighted) pass rate. */
  success: number;
  /** Weight on p95 latency staying under budget. */
  latency: number;
  /** Weight on run cost staying under budget. */
  cost: number;
  /** Weight on groundedness / tool-recall quality. */
  quality: number;
}

/** Default weights — success-dominant, since a failing workflow is not ready. */
export const DEFAULT_READINESS_WEIGHTS: ReadinessWeights = {
  success: 0.5,
  latency: 0.2,
  cost: 0.15,
  quality: 0.15,
};

/**
 * Thresholds for the CI-style quality gate. Each is independent; the run is
 * "ready" only when every applicable threshold is met.
 */
export interface ReadinessThresholds {
  /**
   * Minimum scenario-weighted pass rate required to deploy.
   * @default 1.0 — mirrors the project's `accuracyThreshold` default: a CI gate
   * treats any failing case as a blocker.
   */
  minPassRate: number;
  /** Maximum allowed p95 per-case latency, in milliseconds. */
  maxP95LatencyMs: number;
  /** Maximum allowed total run cost, in USD. */
  maxCostUsd: number;
  /** Minimum required groundedness / quality score (0–1). */
  minQuality: number;
}

/** Default gate thresholds. Override per-run for project-specific SLOs. */
export const DEFAULT_READINESS_THRESHOLDS: ReadinessThresholds = {
  minPassRate: 1.0,
  maxP95LatencyMs: 5000,
  maxCostUsd: 1.0,
  minQuality: 0.0,
};

/** A single point on the efficiency (Pareto) frontier. */
export interface ParetoFrontierMember {
  /** Case ID. */
  id: string;
  /** Whether this case passed. */
  pass: boolean;
  /** Per-case latency in milliseconds. */
  durationMs: number;
  /** Per-case cost in USD (0 when no host usage was recorded). */
  costUsd: number;
}

/** Result of the CI-style deployment gate. */
export interface ReadinessGateResult {
  /** True only when every applicable threshold is met. */
  ready: boolean;
  /** Human-readable reasons the gate failed (empty when ready). */
  blockers: string[];
  /** Human-readable thresholds that were met (empty when nothing ran). */
  passed: string[];
}

/** Raw aggregate signals the score is derived from, exposed for transparency. */
export interface ReadinessSignals {
  /** Unweighted pass rate (passed / total), or 0 when no cases ran. */
  passRate: number;
  /** Scenario-weighted pass rate (cases weighted by `scenarioWeights`). */
  scenarioWeightedPassRate: number;
  /** 95th-percentile per-case latency in milliseconds. */
  p95LatencyMs: number;
  /** Median per-case latency in milliseconds. */
  p50LatencyMs: number;
  /** Total run cost in USD. */
  costUsd: number;
  /** Fraction of judge expectations that passed (when any ran). */
  groundednessRate: number | null;
  /** Mean tool recall across cases that recorded it (when any ran). */
  toolRecall: number | null;
  /**
   * Worst-case lower bound of the pass-rate CI across multi-iteration cases
   * (when any iteration data is present). The gate treats this as the
   * conservative estimate of true pass rate.
   */
  ciLowerBound: number | null;
  /** Number of cases the signals were aggregated from. */
  caseCount: number;
}

/** A complete deployment-decision assessment for one eval run. */
export interface ReadinessAssessment {
  /** Overall scenario-weighted readiness score in [0, 1]. */
  score: number;
  /** Per-component sub-scores in [0, 1]. */
  components: {
    success: number;
    latency: number;
    cost: number;
    quality: number;
  };
  /** Weights used to blend `components` into `score`. */
  weights: ReadinessWeights;
  /** Raw aggregate signals. */
  signals: ReadinessSignals;
  /** Non-dominated cases on the (pass, latency, cost) tradeoff. */
  paretoFrontier: ParetoFrontierMember[];
  /** CI-style deployment gate. */
  gate: ReadinessGateResult;
}

/** Input to {@link computeReadiness}. */
export interface ReadinessInput {
  /** Per-case eval results for the run. */
  results: EvalCaseResult[];
  /** Aggregate host usage for the run, when available. */
  totalHostUsage?: UsageMetrics;
  /** Component weights. Defaults to {@link DEFAULT_READINESS_WEIGHTS}. */
  weights?: Partial<ReadinessWeights>;
  /**
   * Scenario weights keyed by case tag (falling back to dataset name).
   * Higher-weighted scenarios count more toward the success score and gate.
   */
  scenarioWeights?: Record<string, number>;
  /** Gate thresholds. Defaults to {@link DEFAULT_READINESS_THRESHOLDS}. */
  thresholds?: Partial<ReadinessThresholds>;
}

const Z_95 = 1.96;

/**
 * Computes a deployment-decision readiness assessment from completed eval
 * results, without running any evals or touching the filesystem.
 *
 * The assessment combines a scenario-weighted readiness score, an efficiency
 * (Pareto) frontier over cases, and a CI-style quality gate that respects the
 * pass-rate confidence interval of multi-iteration cases.
 */
export function computeReadiness(input: ReadinessInput): ReadinessAssessment {
  const weights: ReadinessWeights = {
    ...DEFAULT_READINESS_WEIGHTS,
    ...(input.weights ?? {}),
  };
  const thresholds: ReadinessThresholds = {
    ...DEFAULT_READINESS_THRESHOLDS,
    ...(input.thresholds ?? {}),
  };
  const scenarioWeights = input.scenarioWeights ?? {};

  const results = input.results;
  const signals = aggregateSignals(
    results,
    scenarioWeights,
    input.totalHostUsage
  );

  // Nothing ran: not ready by definition. Avoid the misleading non-zero score
  // that empty latency/cost/quality signals would otherwise produce.
  if (signals.caseCount === 0) {
    return {
      score: 0,
      components: { success: 0, latency: 0, cost: 0, quality: 0 },
      weights,
      signals,
      paretoFrontier: [],
      gate: { ready: false, blockers: ['no eval cases ran'], passed: [] },
    };
  }

  const successScore = signals.scenarioWeightedPassRate;
  const latencyScore = budgetScore(
    signals.p95LatencyMs,
    thresholds.maxP95LatencyMs
  );
  const costScore = budgetScore(signals.costUsd, thresholds.maxCostUsd);
  const qualityScore = clamp01(
    signals.groundednessRate ?? signals.toolRecall ?? 1.0
  );

  const totalWeight =
    weights.success + weights.latency + weights.cost + weights.quality;
  const score =
    totalWeight > 0
      ? clamp01(
          (successScore * weights.success +
            latencyScore * weights.latency +
            costScore * weights.cost +
            qualityScore * weights.quality) /
            totalWeight
        )
      : 0;

  const gate = evaluateGate(signals, thresholds, qualityScore);

  return {
    score,
    components: {
      success: clamp01(successScore),
      latency: clamp01(latencyScore),
      cost: clamp01(costScore),
      quality: qualityScore,
    },
    weights,
    signals,
    paretoFrontier: paretoFrontier(results),
    gate,
  };
}

function aggregateSignals(
  results: EvalCaseResult[],
  scenarioWeights: Record<string, number>,
  totalHostUsage: UsageMetrics | undefined
): ReadinessSignals {
  const caseCount = results.length;

  if (caseCount === 0) {
    return {
      passRate: 0,
      scenarioWeightedPassRate: 0,
      p95LatencyMs: 0,
      p50LatencyMs: 0,
      costUsd: totalCost(results, totalHostUsage),
      groundednessRate: null,
      toolRecall: null,
      ciLowerBound: null,
      caseCount: 0,
    };
  }

  const passed = results.filter((r) => r.pass).length;
  const passRate = passed / caseCount;

  let weightedPass = 0;
  let weightedTotal = 0;
  for (const r of results) {
    const key = scenarioKey(r, scenarioWeights);
    const w = scenarioWeights[key] ?? 1;
    weightedTotal += w;
    if (r.pass) weightedPass += w;
  }
  const scenarioWeightedPassRate =
    weightedTotal > 0 ? weightedPass / weightedTotal : 0;

  const latencies = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const p95LatencyMs = percentile(latencies, 0.95);
  const p50LatencyMs = percentile(latencies, 0.5);

  const judgeCases = results.filter((r) => r.expectations.judge != null);
  const groundednessRate =
    judgeCases.length > 0
      ? judgeCases.filter((r) => r.expectations.judge?.pass).length /
        judgeCases.length
      : null;

  const recallCases = results.filter((r) => r.toolRecall != null);
  const toolRecall =
    recallCases.length > 0
      ? recallCases.reduce((acc, r) => acc + (r.toolRecall ?? 0), 0) /
        recallCases.length
      : null;

  const ciCases = results.filter((r) => r.assertionPassRateCI != null);
  const ciLowerBound =
    ciCases.length > 0
      ? Math.min(...ciCases.map((r) => r.assertionPassRateCI?.lower ?? 1))
      : null;

  return {
    passRate,
    scenarioWeightedPassRate,
    p95LatencyMs,
    p50LatencyMs,
    costUsd: totalCost(results, totalHostUsage),
    groundednessRate,
    toolRecall,
    ciLowerBound,
    caseCount,
  };
}

function scenarioKey(
  result: EvalCaseResult,
  scenarioWeights: Record<string, number>
): string {
  const tags = result.tags ?? [];
  const tagged = tags.find((t) => scenarioWeights[t] != null);
  return tagged ?? result.datasetName;
}

function totalCost(
  results: EvalCaseResult[],
  totalHostUsage: UsageMetrics | undefined
): number {
  const perCase = results.reduce(
    (acc, r) => acc + (r.hostUsage?.totalCostUsd ?? 0),
    0
  );
  const aggregate = totalHostUsage?.totalCostUsd ?? 0;
  // Prefer the explicit aggregate when present (reporter passes run-level usage);
  // otherwise fall back to summing per-case usage.
  return aggregate > 0 ? aggregate : perCase;
}

/**
 * Linear budget score: 1.0 when the value is 0, 0.0 once it reaches `budget`,
 * clamped to [0, 1]. Values are "lower is better" (latency, cost).
 */
function budgetScore(value: number, budget: number): number {
  if (budget <= 0) return value <= 0 ? 1 : 0;
  return clamp01(1 - value / budget);
}

function evaluateGate(
  signals: ReadinessSignals,
  thresholds: ReadinessThresholds,
  qualityScore: number
): ReadinessGateResult {
  if (signals.caseCount === 0) {
    return { ready: false, blockers: ['no eval cases ran'], passed: [] };
  }

  const blockers: string[] = [];
  const passed: string[] = [];

  // Pass-rate gate uses the conservative CI lower bound when available, so a
  // shaky multi-iteration result cannot sneak a flaky workflow through.
  const effectivePass =
    signals.ciLowerBound ?? signals.scenarioWeightedPassRate;
  if (effectivePass + Number.EPSILON < thresholds.minPassRate) {
    blockers.push(
      `pass rate ${(effectivePass * 100).toFixed(1)}% below threshold ${(thresholds.minPassRate * 100).toFixed(1)}%` +
        (signals.ciLowerBound != null ? ' (using CI lower bound)' : '')
    );
  } else {
    passed.push(`pass rate >= ${(thresholds.minPassRate * 100).toFixed(1)}%`);
  }

  if (signals.p95LatencyMs > thresholds.maxP95LatencyMs) {
    blockers.push(
      `p95 latency ${Math.round(signals.p95LatencyMs)}ms exceeds ${thresholds.maxP95LatencyMs}ms`
    );
  } else {
    passed.push(`p95 latency <= ${thresholds.maxP95LatencyMs}ms`);
  }

  if (signals.costUsd > thresholds.maxCostUsd) {
    blockers.push(
      `cost $${signals.costUsd.toFixed(4)} exceeds $${thresholds.maxCostUsd}`
    );
  } else {
    passed.push(`cost <= $${thresholds.maxCostUsd}`);
  }

  if (qualityScore + Number.EPSILON < thresholds.minQuality) {
    blockers.push(
      `quality ${(qualityScore * 100).toFixed(1)}% below ${(thresholds.minQuality * 100).toFixed(1)}%`
    );
  } else {
    passed.push(`quality >= ${(thresholds.minQuality * 100).toFixed(1)}%`);
  }

  return { ready: blockers.length === 0, blockers, passed };
}

/**
 * Efficiency (Pareto) frontier over the PASSING cases on the (minimize latency,
 * minimize cost) tradeoff. Failed cases are not deployable candidates and are
 * excluded. A passing case is on the frontier when no other passing case is at
 * least as cheap and at least as fast, and strictly better on at least one axis.
 */
export function paretoFrontier(
  results: EvalCaseResult[]
): ParetoFrontierMember[] {
  const points = results
    .filter((r) => r.pass)
    .map((r) => ({
      id: r.id,
      pass: r.pass,
      durationMs: r.durationMs,
      costUsd: r.hostUsage?.totalCostUsd ?? 0,
    }));

  return points
    .filter((a) => !points.some((b) => b !== a && dominates(b, a)))
    .sort((x, y) => {
      // Passed cases first, then cheaper, then faster.
      if (x.pass !== y.pass) return x.pass ? -1 : 1;
      if (x.costUsd !== y.costUsd) return x.costUsd - y.costUsd;
      return x.durationMs - y.durationMs;
    });
}

function dominates(a: ParetoFrontierMember, b: ParetoFrontierMember): boolean {
  // All frontier members pass, so domination is purely (latency, cost).
  if (!(a.durationMs <= b.durationMs && a.costUsd <= b.costUsd)) return false;
  // At least one axis strictly better (otherwise they are tied, not dominating).
  return a.durationMs < b.durationMs || a.costUsd < b.costUsd;
}

/** Nearest-rank percentile over a pre-sorted ascending array. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0] ?? 0;
  const rank = Math.ceil(p * sortedAsc.length);
  const idx = Math.min(Math.max(rank, 1), sortedAsc.length) - 1;
  return sortedAsc[idx] ?? 0;
}

/** 95% Wilson score interval lower bound for a proportion. */
export function wilsonLowerBound(passes: number, total: number): number | null {
  if (total < 2) return null;
  const z2 = Z_95 * Z_95;
  const n = total + z2;
  const pHat = (passes + z2 / 2) / n;
  const margin = Z_95 * Math.sqrt((pHat * (1 - pHat)) / n);
  return Math.max(0, pHat - margin);
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
