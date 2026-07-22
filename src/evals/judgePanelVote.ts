/**
 * Judge Panel Vote Aggregation
 *
 * Resolves disagreement across a panel of LLM judges by an explicit voting
 * strategy instead of only strict unanimity. Human annotation resolves
 * inter-annotator disagreement with majority voting; applying the same
 * ensemble strategy to a panel of LLM judges yields more stable pass/fail
 * verdicts than requiring every judge to agree.
 *
 * Adapted from "A Simple Ensemble Strategy for LLM Inference: Towards More
 * Stable Text Classification" (arXiv:2504.18884). The paper's core insight —
 * ensembling independent LLM verdicts by majority vote reduces per-trial
 * variability — is applied here to the existing multi-judge panel aggregation.
 * The paper's sentiment-classification experiments and reported numbers are
 * intentionally out of scope; only the aggregation primitive is ported.
 */

/**
 * How a multi-judge panel resolves disagreement into a single verdict.
 * - `unanimous`: every judge must pass (strict AND; the prior behavior).
 * - `majority`: a strict majority of judges must pass (> half the panel).
 */
export type JudgeVoteStrategy = 'unanimous' | 'majority';

/** Default strategy — preserves the prior strict-unanimity behavior. */
export const DEFAULT_JUDGE_VOTE_STRATEGY: JudgeVoteStrategy = 'unanimous';

/** Minimal shape needed to vote: whether an individual judge passed. */
export interface JudgeVoteEntry {
  pass: boolean;
}

/** Outcome of aggregating a judge panel under a voting strategy. */
export interface JudgePanelVoteResult {
  /** Aggregated pass/fail verdict for the whole panel. */
  pass: boolean;
  /** Number of judges that passed. */
  passCount: number;
  /** Total number of judges in the panel. */
  total: number;
  /** The strategy that produced this verdict. */
  strategy: JudgeVoteStrategy;
  /** Human-readable summary, e.g. `2/3 judges passed (majority)`. */
  details: string;
}

/**
 * Aggregates a panel of judge results into a single verdict using the given
 * voting strategy.
 *
 * `majority` requires a strict majority (`passCount * 2 > total`), so an even
 * split on an even-sized panel fails — there is no majority to break the tie,
 * matching how majority voting treats a deadlock among annotators. `unanimous`
 * requires every judge to pass and reproduces the previous `.every()` behavior.
 *
 * @param results - Per-judge results (only `pass` is read).
 * @param strategy - Voting strategy. @default 'unanimous'
 * @returns The aggregated verdict with vote counts and a summary string.
 */
export function aggregateJudgePanel(
  results: ReadonlyArray<JudgeVoteEntry>,
  strategy: JudgeVoteStrategy = DEFAULT_JUDGE_VOTE_STRATEGY
): JudgePanelVoteResult {
  const total = results.length;
  const passCount = results.filter((r) => r.pass).length;

  const pass =
    strategy === 'majority' ? passCount * 2 > total : passCount === total;

  return {
    pass,
    passCount,
    total,
    strategy,
    details: `${passCount}/${total} judges passed (${strategy})`,
  };
}
