/**
 * Multi-judge consensus — degrees of agreement across LLM judges.
 *
 * Adapted from "Disagree and Commit: Degrees of Argumentation-based
 * Agreements" (arXiv:2501.01992).
 *
 * The paper's central contribution is that an agreement between autonomous
 * agents need not be total: a *partial degree of agreement* — a scalar in
 * [0, 1] — is sufficient to commit to a decision, provided it clears a
 * threshold. The original work derives that degree from formal
 * argumentation semantics (Dung-style acceptability of arguments within an
 * agreement scenario).
 *
 * This module ports that core idea — the degree-of-agreement scalar and the
 * threshold-to-commit rule — onto the target's multi-LLM-judge path, where
 * each judge plays the role of one "agent" issuing a verdict. The
 * argumentation framework is the auxiliary piece the repo cannot host; it
 * is replaced by the judges' own pass/score verdicts. The aggregation
 * operators (unanimous / majority / mean / median / min) are the policy
 * choices for collapsing per-judge verdicts into a single degree of
 * agreement.
 *
 * The default policy is 'unanimous', which reproduces the eval runner's prior
 * AND-aggregation exactly (every judge must pass) so existing behavior is
 * preserved unless a case opts into a partial-agreement policy.
 */

import type { EvalExpectationResult } from '../types/index.js';

/**
 * How multiple judge verdicts collapse into one commit decision.
 *
 * - `unanimous` — every judge must pass. The historical default; reproduces
 *   prior AND semantics.
 * - `majority` — strictly more than half of the judges must pass.
 * - `mean` — the mean of the judges' scores must meet `threshold`.
 * - `median` — the median of the judges' scores must meet `threshold`.
 * - `min` — the lowest judge score must meet `threshold`. The continuous
 *   analogue of unanimous: no single judge can sink the decision, but a
 *   borderline-passing judge (e.g. 0.71) can still carry it.
 *
 * For `mean` / `median` / `min`, a judge without a numeric score contributes
 * its pass/fail verdict as 1.0 / 0.0.
 */
export type JudgeConsensusPolicy =
  | 'unanimous'
  | 'majority'
  | 'mean'
  | 'median'
  | 'min';

/**
 * Per-expectation consensus configuration. Set on `EvalExpectBlock.judgeConsensus`.
 */
export interface JudgeConsensusOptions {
  /** Aggregation policy. @default 'unanimous' */
  policy?: JudgeConsensusPolicy;
  /** Minimum degree of agreement required to pass, for mean/median/min. @default 0.7 */
  threshold?: number;
}

/**
 * The degree of agreement a set of judges reached, and whether it commits.
 */
export interface JudgeConsensusResult {
  /** Whether the aggregated verdict passes (commits). */
  pass: boolean;
  /** Human-readable summary for the expectation result. */
  details: string;
  /** Degree of agreement in [0, 1] — the paper's central scalar. */
  agreement: number;
}

const DEFAULT_POLICY: JudgeConsensusPolicy = 'unanimous';
const DEFAULT_THRESHOLD = 0.7;

/**
 * Resolves a judge's numeric score, falling back to its pass/fail verdict
 * expressed on the 0-1 scale when no continuous score is present.
 */
function judgeScore(result: EvalExpectationResult): number {
  return typeof result.score === 'number' ? result.score : result.pass ? 1 : 0;
}

function mean(values: number[]): number {
  return values.reduce((total, v) => total + v, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Aggregates per-judge results into a single degree-of-agreement verdict.
 *
 * @param judgeResults - One result per judge (the entries that would populate
 *   `EvalExpectationResult.judgeResults`).
 * @param options - Consensus policy and threshold. Defaults reproduce the
 *   runner's prior unanimous-AND behavior.
 * @returns The agreement degree, the commit (pass) decision, and a summary.
 *
 * @example
 * ```typescript
 * const consensus = resolveJudgeConsensus(judgeResults, {
 *   policy: 'majority',
 * });
 * // consensus.agreement === 0.66 (2 of 3 judges passed)
 * // consensus.pass === true  (a majority agreed → commit)
 * ```
 */
export function resolveJudgeConsensus(
  judgeResults: EvalExpectationResult[],
  options?: JudgeConsensusOptions
): JudgeConsensusResult {
  const policy = options?.policy ?? DEFAULT_POLICY;
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const total = judgeResults.length;

  if (total === 0) {
    return { pass: false, details: '0/0 judges passed', agreement: 0 };
  }

  const passCount = judgeResults.filter((r) => r.pass).length;
  const passFraction = passCount / total;

  // Verdict-based policies operate on the pass/fail signal.
  if (policy === 'unanimous') {
    return {
      pass: passCount === total,
      // Keep this summary identical to the runner's historical output so the
      // default path is byte-for-byte preserved.
      details: `${passCount}/${total} judges passed`,
      agreement: passFraction,
    };
  }

  if (policy === 'majority') {
    const pass = passCount > total / 2;
    return {
      pass,
      details: `${passCount}/${total} judges passed · majority (${(passFraction * 100).toFixed(0)}% > 50%)`,
      agreement: passFraction,
    };
  }

  // Score-based policies: mean / median / min.
  const scores = judgeResults.map(judgeScore);
  const aggregate =
    policy === 'mean'
      ? mean(scores)
      : policy === 'median'
        ? median(scores)
        : Math.min(...scores);
  const pass = aggregate >= threshold;
  return {
    pass,
    details: `${passCount}/${total} judges passed · ${policy} agreement ${aggregate.toFixed(2)} ${pass ? '>=' : '<'} ${threshold}`,
    agreement: aggregate,
  };
}
