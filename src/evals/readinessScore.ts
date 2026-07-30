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
 * Paper-fidelity details implemented here:
 * - Missing-metric renormalization: the score blends only the dimensions that
 *   were actually measured, renormalizing weights over the present set
 *   (R = sum(w_i * m_i) / sum(w_i) for i in present), and reports which
 *   components were missing instead of silently substituting a default.
 * - Scenario weight presets (`cost-first` / `risk-first` / `sla-first`) from
 *   the paper's Table 1, mapped onto this repo's four components.
 * - A hard/soft gate distinction: the pass-rate (workflow/policy) check is the
 *   hard gate; latency, cost, and quality budget breaches are soft blockers.
 * - A Pareto frontier that maximizes per-case quality while minimizing latency
 *   and cost, per the paper's cost-utility dominance definition.
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

/** Readiness score components that can be individually present or missing. */
export type ReadinessComponent = 'success' | 'latency' | 'cost' | 'quality';

/** Named scenario weight presets from the paper's Table 1. */
export type ReadinessScenarioPreset = 'cost-first' | 'risk-first' | 'sla-first';

/**
 * Scenario weight presets from the paper's Table 1, mapped onto this repo's
 * four components: the paper's `workflow + policy` weights combine into
 * `success`, `faithfulness + retrieval hit@k` into `quality`, `cost` into
 * `cost`, and `SLA` (p95 latency) into `latency`. Each preset sums to 1.
 */
export const READINESS_WEIGHT_PRESETS: Record<
  ReadinessScenarioPreset,
  ReadinessWeights
> = {
  'cost-first': { success: 0.4, latency: 0.1, cost: 0.2, quality: 0.3 },
  'risk-first': { success: 0.4, latency: 0.15, cost: 0.1, quality: 0.35 },
  'sla-first': { success: 0.35, latency: 0.3, cost: 0.1, quality: 0.25 },
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
  /**
   * Per-case quality in [0, 1]: the judge outcome when one ran, else the
   * recorded tool recall, else null when no quality signal was measured.
   */
  quality: number | null;
}

/** Result of the CI-style deployment gate. */
export interface ReadinessGateResult {
  /** True only when every applicable threshold is met. */
  ready: boolean;
  /** Human-readable reasons the gate failed (empty when ready). */
  blockers: string[];
  /** Human-readable thresholds that were met (empty when nothing ran). */
  passed: string[];
  /**
   * Hard blockers: workflow/policy failures (pass rate below threshold).
   * Per the paper, policy compliance is a hard gate — a run cannot be ready
   * with a hard blocker no matter how high the scalar score is.
   */
  hardBlockers: string[];
  /**
   * Soft blockers: latency / cost / quality budget breaches. These degrade
   * the readiness score and block the default-strict gate, but are
   * classified separately so callers can choose to enforce only hard gates.
   */
  softBlockers: string[];
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
  /**
   * Overall scenario-weighted readiness score in [0, 1], blended over the
   * measured components only (missing-metric renormalization).
   */
  score: number;
  /**
   * Per-component sub-scores in [0, 1]. A component is null when it was not
   * measured (e.g. no judge / tool-recall data for `quality`, no host usage
   * recorded for `cost`) and is excluded from the blended score.
   */
  components: {
    success: number | null;
    latency: number | null;
    cost: number | null;
    quality: number | null;
  };
  /** Components that had no measured signal and were excluded from `score`. */
  missingComponents: ReadinessComponent[];
  /** Weights used to blend `components` into `score`. */
  weights: ReadinessWeights;
  /** Raw aggregate signals. */
  signals: ReadinessSignals;
  /** Non-dominated cases on the (quality, latency, cost) tradeoff. */
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
   * Named scenario weight preset from the paper's Table 1
   * ({@link READINESS_WEIGHT_PRESETS}). Applied over the defaults; explicit
   * `weights` entries override the preset.
   */
  preset?: ReadinessScenarioPreset;
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
    ...(input.preset != null ? READINESS_WEIGHT_PRESETS[input.preset] : {}),
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
      components: { success: null, latency: null, cost: null, quality: null },
      missingComponents: ['success', 'latency', 'cost', 'quality'],
      weights,
      signals,
      paretoFrontier: [],
      gate: {
        ready: false,
        blockers: ['no eval cases ran'],
        passed: [],
        hardBlockers: ['no eval cases ran'],
        softBlockers: [],
      },
    };
  }

  // Missing-metric renormalization (the paper's core formula): a component is
  // blended into the score only when it was actually measured, and the weights
  // are renormalized over the present set. Unmeasured components are reported
  // via `missingComponents` instead of silently substituting a default score.
  const successScore: number | null = clamp01(signals.scenarioWeightedPassRate);
  const latencyScore: number | null = clamp01(
    budgetScore(signals.p95LatencyMs, thresholds.maxP95LatencyMs)
  );
  const costMeasured =
    input.totalHostUsage != null || results.some((r) => r.hostUsage != null);
  const costScore: number | null = costMeasured
    ? clamp01(budgetScore(signals.costUsd, thresholds.maxCostUsd))
    : null;
  const measuredQuality = signals.groundednessRate ?? signals.toolRecall;
  const qualityScore: number | null =
    measuredQuality != null ? clamp01(measuredQuality) : null;

  const components = {
    success: successScore,
    latency: latencyScore,
    cost: costScore,
    quality: qualityScore,
  };
  const componentKeys: ReadinessComponent[] = [
    'success',
    'latency',
    'cost',
    'quality',
  ];
  const missingComponents = componentKeys.filter((k) => components[k] == null);

  let weightedSum = 0;
  let presentWeight = 0;
  for (const key of componentKeys) {
    const componentScore = components[key];
    if (componentScore == null) continue;
    weightedSum += componentScore * weights[key];
    presentWeight += weights[key];
  }
  const score = presentWeight > 0 ? clamp01(weightedSum / presentWeight) : 0;

  const gate = evaluateGate(signals, thresholds, qualityScore, costMeasured);

  return {
    score,
    components,
    missingComponents,
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
  qualityScore: number | null,
  costMeasured: boolean
): ReadinessGateResult {
  if (signals.caseCount === 0) {
    return {
      ready: false,
      blockers: ['no eval cases ran'],
      passed: [],
      hardBlockers: ['no eval cases ran'],
      softBlockers: [],
    };
  }

  const hardBlockers: string[] = [];
  const softBlockers: string[] = [];
  const passed: string[] = [];

  // Hard gate (the paper's policy-compliance rule): workflow success uses the
  // conservative CI lower bound when available, so a shaky multi-iteration
  // result cannot sneak a flaky workflow through.
  const effectivePass =
    signals.ciLowerBound ?? signals.scenarioWeightedPassRate;
  if (effectivePass + Number.EPSILON < thresholds.minPassRate) {
    hardBlockers.push(
      `pass rate ${(effectivePass * 100).toFixed(1)}% below threshold ${(thresholds.minPassRate * 100).toFixed(1)}%` +
        (signals.ciLowerBound != null ? ' (using CI lower bound)' : '')
    );
  } else {
    passed.push(`pass rate >= ${(thresholds.minPassRate * 100).toFixed(1)}%`);
  }

  // Soft gates: budget breaches degrade the score and block the default-strict
  // gate, but are classified separately from the hard workflow/policy gate.
  // Thresholds for unmeasured components are skipped rather than evaluated
  // against a substituted default.
  if (signals.p95LatencyMs > thresholds.maxP95LatencyMs) {
    softBlockers.push(
      `p95 latency ${Math.round(signals.p95LatencyMs)}ms exceeds ${thresholds.maxP95LatencyMs}ms`
    );
  } else {
    passed.push(`p95 latency <= ${thresholds.maxP95LatencyMs}ms`);
  }

  if (costMeasured) {
    if (signals.costUsd > thresholds.maxCostUsd) {
      softBlockers.push(
        `cost $${signals.costUsd.toFixed(4)} exceeds $${thresholds.maxCostUsd}`
      );
    } else {
      passed.push(`cost <= $${thresholds.maxCostUsd}`);
    }
  }

  if (qualityScore != null) {
    if (qualityScore + Number.EPSILON < thresholds.minQuality) {
      softBlockers.push(
        `quality ${(qualityScore * 100).toFixed(1)}% below ${(thresholds.minQuality * 100).toFixed(1)}%`
      );
    } else {
      passed.push(`quality >= ${(thresholds.minQuality * 100).toFixed(1)}%`);
    }
  }

  const blockers = [...hardBlockers, ...softBlockers];
  return {
    ready: blockers.length === 0,
    blockers,
    passed,
    hardBlockers,
    softBlockers,
  };
}

/**
 * Cost-utility (Pareto) frontier over the PASSING cases, maximizing per-case
 * quality while minimizing latency and cost — the paper's dominance
 * definition. Failed cases are not deployable candidates and are excluded. A
 * passing case is on the frontier when no other passing case is at least as
 * good on every axis and strictly better on at least one. Cases with no
 * measured quality are treated as quality 0 for dominance (conservative:
 * unmeasured quality cannot dominate), but keep `quality: null` in the output.
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
      quality: caseQuality(r),
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

function caseQuality(result: EvalCaseResult): number | null {
  const judge = result.expectations.judge;
  if (judge != null) return judge.pass ? 1 : 0;
  return result.toolRecall ?? null;
}

function dominates(a: ParetoFrontierMember, b: ParetoFrontierMember): boolean {
  // All frontier members pass, so domination is (max quality, min latency,
  // min cost). Unmeasured quality counts as 0 so it cannot dominate.
  const qualityA = a.quality ?? 0;
  const qualityB = b.quality ?? 0;
  if (
    !(
      qualityA >= qualityB &&
      a.durationMs <= b.durationMs &&
      a.costUsd <= b.costUsd
    )
  ) {
    return false;
  }
  // At least one axis strictly better (otherwise they are tied, not dominating).
  return (
    qualityA > qualityB || a.durationMs < b.durationMs || a.costUsd < b.costUsd
  );
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
