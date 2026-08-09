import type { TestInfo } from '@playwright/test';
import type { EvalCase, EvalDataset } from './datasetTypes.js';
import type { Judge, JudgeConfig, JudgeResult } from '../judge/judgeTypes.js';
import { createJudge } from '../judge/judgeClient.js';

/**
 * Dataset-quality audit (a "benchmarking the benchmarks" pass).
 *
 * Adapted from: "Benchmarking the Benchmarks: Evaluating Benchmarks for
 * Conversational Agents" (arXiv:2608.06329). That paper proposes a
 * reference-free framework that uses LLM judges to score a benchmark along
 * three dimensions — consistency, complexity, and policy coverage — and
 * surfaces actionable diagnostics. This module applies that idea to this
 * repo's own eval datasets: each {@link EvalCase} is scored on the same three
 * dimensions through the existing {@link Judge} contract, and the results are
 * aggregated into a per-case + dataset-level audit that attaches to the MCP
 * reporter the same way {@link runConformanceChecks} does.
 *
 * What is intentionally out of scope (research-validation machinery, not the
 * core method): the paper's human-annotation agreement study and its
 * controlled quality-degrading perturbation experiment. Those validate the
 * metrics against external ground truth; here we deliver the metric itself,
 * reusing the repo's judge infra rather than porting the paper's eval harness.
 */

/**
 * The three benchmark-quality dimensions from the paper. Each case is scored
 * 0–1 on every selected dimension.
 */
export type BenchmarkDimension =
  | 'consistency'
  | 'complexity'
  | 'policy-coverage';

/** All supported dimensions, in evaluation order. */
export const BENCHMARK_DIMENSIONS: readonly BenchmarkDimension[] = [
  'consistency',
  'complexity',
  'policy-coverage',
] as const;

/**
 * Per-dimension rubrics. Written in the same 5-point scale
 * (0.0 / 0.25 / 0.5 / 0.75 / 1.0) as the built-in judge rubrics so they
 * compose with the existing {@link Judge} contract unchanged.
 */
export const BENCHMARK_DIMENSION_RUBRICS: Record<BenchmarkDimension, string> = {
  consistency:
    'Evaluate whether this single benchmark case is internally consistent and unambiguous. ' +
    'Check that the id, description, the task definition (tool + args, or scenario), and the ' +
    'stated expectations all describe the same task with no contradictions or missing pieces, ' +
    'and that a reader could determine unambiguously what is being tested. ' +
    'Score 1.0 for fully consistent and clear; ' +
    'Score 0.75 for mostly clear with one minor ambiguity; ' +
    'Score 0.5 for partially clear — the intent is guessable but key elements conflict or are vague; ' +
    'Score 0.25 for largely inconsistent or confusing; ' +
    'Score 0.0 for contradictory, malformed, or impossible to interpret.',
  complexity:
    'Evaluate whether this benchmark case has sufficient complexity to be a meaningful test ' +
    'rather than a trivial one. A good case exercises realistic reasoning, multi-step behavior, ' +
    'non-obvious argument construction, or non-trivial expectations. Penalize cases that are ' +
    'overly simplistic, near-tautological, or that any system would pass without the capability ' +
    'under test. ' +
    'Score 1.0 for appropriately challenging and discriminating; ' +
    'Score 0.75 for solid with one simplifying assumption; ' +
    'Score 0.5 for somewhat trivial — exercises the surface but little depth; ' +
    'Score 0.25 for largely trivial; ' +
    'Score 0.0 for a no-op or vacuous case that tests nothing meaningful.',
  'policy-coverage':
    'Evaluate whether this benchmark case targets a distinct, meaningful behavior or policy and ' +
    'is not redundant with the other cases in the same dataset (provided as reference context). ' +
    'A good case expands what the suite covers; a poor one duplicates an existing case or adds ' +
    'no new policy surface. ' +
    'Score 1.0 for a clearly distinct, coverage-expanding case; ' +
    'Score 0.75 for mostly distinct with minor overlap; ' +
    'Score 0.5 for partially overlapping — adds some new surface but mostly redundant; ' +
    'Score 0.25 for largely redundant with existing cases; ' +
    'Score 0.0 for a pure duplicate that adds no coverage.',
};

/** Default passing score threshold per dimension (0–1). */
export const DEFAULT_AUDIT_THRESHOLD = 0.7;

/**
 * Options for {@link runBenchmarkAudit}.
 */
export interface BenchmarkAuditOptions {
  /**
   * Pre-constructed judge to use. When omitted, a judge is built via
   * {@link createJudge} using {@link judgeConfig}. Injecting a judge keeps the
   * audit deterministic and offline (useful in tests and custom pipelines).
   */
  judge?: Judge;

  /** Configuration for the default judge. Ignored when {@link judge} is set. */
  judgeConfig?: JudgeConfig;

  /**
   * Dimensions to score. Defaults to all of {@link BENCHMARK_DIMENSIONS}.
   */
  dimensions?: BenchmarkDimension[];

  /**
   * Minimum score (0–1) for a dimension to pass. A case passes only when every
   * selected dimension passes.
   * @default 0.7
   */
  threshold?: number;

  /**
   * When true, sibling-case context is passed to the judge as the reference for
   * the policy-coverage dimension (so it can assess redundancy). Disable for a
   * purely per-case view.
   * @default true
   */
  includeContext?: boolean;
}

/**
 * One dimension's score for a single case.
 */
export interface BenchmarkDimensionResult {
  /** The dimension this score describes. */
  dimension: BenchmarkDimension;
  /** Normalized score (0–1, where 1 is best). */
  score: number;
  /** Whether this dimension met {@link BenchmarkAuditOptions.threshold}. */
  pass: boolean;
  /** Judge reasoning / diagnostic for this dimension. */
  reasoning: string;
}

/**
 * Audit result for a single eval case (mirrors an individual conformance
 * check, rolled up across the selected dimensions).
 */
export interface BenchmarkCaseAudit {
  /** The {@link EvalCase.id} this result describes. */
  caseId: string;
  /** Whether every selected dimension met the threshold. */
  pass: boolean;
  /** Mean score across the selected dimensions. */
  score: number;
  /** Per-dimension results. */
  dimensions: BenchmarkDimensionResult[];
}

/**
 * Dataset-level score breakdown.
 */
export interface BenchmarkDimensionScores {
  /** Mean case score across the whole dataset. */
  overall: number;
  /** Mean score per dimension across all cases (only dimensions that ran). */
  byDimension: Partial<Record<BenchmarkDimension, number>>;
}

/**
 * Result of a benchmark audit. Mirrors the shape of
 * {@link runConformanceChecks}'s result: an overall {@link pass}, the per-item
 * {@link results} list, and a {@link scores} breakdown.
 */
export interface BenchmarkAuditResult {
  /** Whether every audited case passed. */
  pass: boolean;
  /** Per-case audit results. */
  results: BenchmarkCaseAudit[];
  /** Dataset-level score breakdown. */
  scores: BenchmarkDimensionScores;
}

/**
 * Runs a dataset-quality audit over an eval dataset.
 *
 * For each {@link EvalCase}, an LLM judge scores the case on the selected
 * {@link BenchmarkDimension | dimensions} (consistency, complexity, and
 * policy-coverage by default) through the existing {@link Judge} contract.
 * Results are aggregated into per-case and dataset-level scores. When
 * `testInfo` is provided, the audit is attached for the MCP reporter — the
 * same integration path {@link runConformanceChecks} uses.
 *
 * @param dataset - The eval dataset to audit.
 * @param options - Audit options (judge, dimensions, threshold, context).
 * @param testInfo - Optional Playwright TestInfo for reporter integration.
 * @returns Aggregated audit result with per-case and dataset-level scores.
 *
 * @example
 * ```typescript
 * import { runBenchmarkAudit } from '@gleanwork/mcp-server-tester/evals/benchmarkAudit.js';
 *
 * const audit = await runBenchmarkAudit(dataset, { threshold: 0.75 }, testInfo);
 * expect(audit.pass).toBe(true);
 * for (const result of audit.results) {
 *   console.log(result.caseId, result.score, result.pass);
 * }
 * ```
 */
export async function runBenchmarkAudit(
  dataset: EvalDataset,
  options: BenchmarkAuditOptions = {},
  testInfo?: TestInfo
): Promise<BenchmarkAuditResult> {
  const {
    judge,
    judgeConfig,
    dimensions = [...BENCHMARK_DIMENSIONS],
    threshold = DEFAULT_AUDIT_THRESHOLD,
    includeContext = true,
  } = options;

  const activeJudge = judge ?? createJudge(judgeConfig ?? {});
  const results: BenchmarkCaseAudit[] = [];

  for (const evalCase of dataset.cases) {
    const candidate = serializeCase(evalCase);
    const dimensionResults: BenchmarkDimensionResult[] = [];

    for (const dimension of dimensions) {
      const rubric = BENCHMARK_DIMENSION_RUBRICS[dimension];
      const reference =
        dimension === 'policy-coverage' && includeContext
          ? serializeCoverageContext(dataset, evalCase.id)
          : null;
      const judgeResult = await activeJudge.evaluate(
        candidate,
        reference,
        rubric
      );
      dimensionResults.push(
        toDimensionResult(dimension, judgeResult, threshold)
      );
    }

    results.push({
      caseId: evalCase.id,
      pass: dimensionResults.every((d) => d.pass),
      score: mean(dimensionResults.map((d) => d.score)),
      dimensions: dimensionResults,
    });
  }

  const byDimension = meanByDimension(results, dimensions);
  const scores: BenchmarkDimensionScores = {
    overall: mean(results.map((r) => r.score)),
    byDimension,
  };
  const result: BenchmarkAuditResult = {
    pass: results.every((r) => r.pass),
    results,
    scores,
  };

  if (testInfo) {
    await testInfo.attach('mcp-benchmark-audit', {
      contentType: 'application/json',
      body: JSON.stringify(
        {
          operation: 'benchmarkAudit',
          dataset: dataset.name,
          pass: result.pass,
          dimensions,
          overallScore: scores.overall,
          byDimension: scores.byDimension,
          results,
        },
        null,
        2
      ),
    });
  }

  return result;
}

/**
 * Normalizes a {@link JudgeResult} into a dimension score. Judges may omit the
 * numeric `score`; in that case derive a coarse 1.0/0.0 from the boolean
 * `pass` so the audit still works with any judge implementation.
 */
function toDimensionResult(
  dimension: BenchmarkDimension,
  judgeResult: JudgeResult,
  threshold: number
): BenchmarkDimensionResult {
  const score = judgeResult.score ?? (judgeResult.pass ? 1 : 0);
  return {
    dimension,
    score,
    pass: score >= threshold,
    reasoning: judgeResult.reasoning ?? '',
  };
}

/** Arithmetic mean of a list of numbers (0 for an empty list). */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Mean score per dimension across all cases that produced one. */
function meanByDimension(
  results: BenchmarkCaseAudit[],
  dimensions: BenchmarkDimension[]
): Partial<Record<BenchmarkDimension, number>> {
  const byDimension: Partial<Record<BenchmarkDimension, number>> = {};
  for (const dimension of dimensions) {
    const scores = results
      .map((r) => r.dimensions.find((d) => d.dimension === dimension)?.score)
      .filter((s): s is number => typeof s === 'number');
    byDimension[dimension] = mean(scores);
  }
  return byDimension;
}

/** Renders the expectation block as a compact, human-readable summary. */
function summarizeExpect(expect: EvalCase['expect']): string {
  if (!expect) return '(no expectations)';
  const keys = Object.keys(expect);
  return keys.length > 0 ? keys.join(', ') : '(no expectations)';
}

/** Serializes a case into the candidate text the judge evaluates. */
function serializeCase(evalCase: EvalCase): string {
  const lines: string[] = [`id: ${evalCase.id}`];
  if (evalCase.description) lines.push(`description: ${evalCase.description}`);
  lines.push(`mode: ${evalCase.mode ?? 'direct'}`);
  if (evalCase.scenario) lines.push(`scenario: ${evalCase.scenario}`);
  if (evalCase.toolName) {
    lines.push(`tool: ${evalCase.toolName}`);
    if (evalCase.args) lines.push(`args: ${JSON.stringify(evalCase.args)}`);
  }
  lines.push(`expectations: ${summarizeExpect(evalCase.expect)}`);
  if (evalCase.tags && evalCase.tags.length > 0) {
    lines.push(`tags: ${evalCase.tags.join(', ')}`);
  }
  if (evalCase.canonicalAnswer) {
    lines.push(`canonicalAnswer: ${evalCase.canonicalAnswer}`);
  }
  return lines.join('\n');
}

/**
 * Renders the dataset context (minus the case under evaluation) as the
 * reference for the policy-coverage dimension, so the judge can assess
 * redundancy against sibling cases.
 */
function serializeCoverageContext(
  dataset: EvalDataset,
  exceptId: string
): string {
  const siblings = dataset.cases
    .filter((c) => c.id !== exceptId)
    .map((c) => {
      const label = c.description ?? c.scenario ?? c.toolName ?? c.id;
      return `- ${c.id}: ${label}`;
    });
  return [
    `dataset: ${dataset.name} (${dataset.cases.length} cases total)`,
    'sibling cases (assess redundancy against these):',
    siblings.length > 0 ? siblings.join('\n') : '- (none)',
  ].join('\n');
}
