import type { EvalExpectationResult } from '../types/index.js';
import type { JudgeConsensusOptions } from '../types/index.js';

/**
 * Multi-judge consensus aggregation and Elo ranking of LLM-judge verdicts.
 *
 * Provides the consensus layer that multiple judges per eval case need:
 *  - {@link aggregateMultiJudgeVerdicts} combines per-judge pass/fail
 *    verdicts under an adjustable agreement threshold (from unanimity to
 *    majority), replacing a fixed all-must-pass rule.
 *  - {@link computeEloRankings} derives stable, interpretable candidate
 *    rankings from pairwise comparisons of judge scores, using an Elo
 *    rating system.
 *
 * Adapted from "Scalable Reliable Automated Evaluation with Large Language
 * Models" (arXiv:2607.28282). The paper obtains pairwise comparisons by
 * issuing fresh A-vs-B preference queries to multiple LLMs; here those
 * comparisons are derived instead from the per-judge scores the eval runner
 * already collects (a parameter-free proxy), so ranking adds no extra LLM
 * cost. The paper's separate competency-profile benchmark is intentionally
 * out of scope.
 */

/**
 * Result of aggregating several judges' verdicts for one expectation.
 */
export interface JudgeConsensusResult {
  /** Whether the aggregated verdict passes the configured threshold. */
  pass: boolean;
  /** Number of judges that passed. */
  passCount: number;
  /** Total number of judges. */
  total: number;
  /** `passCount / total` (0 when there are no judges). */
  passFraction: number;
  /** Human-readable summary, e.g. `2/3 judges passed`. */
  details: string;
}

/**
 * A candidate output described only by the scores (0-1) each judge gave it.
 * Used as input to Elo ranking.
 */
export interface JudgeScoredCandidate {
  /** Stable identifier for the candidate (e.g. variant id). */
  id: string;
  /** One score per judge. A candidate with no scores is treated as score 0. */
  scores: number[];
}

/**
 * A ranked candidate in an Elo leaderboard.
 */
export interface EloRankingEntry {
  id: string;
  /** Final Elo rating (higher is better). */
  rating: number;
  /** 1-based competition rank; tied ratings share the lower rank. */
  rank: number;
  /** Number of pairwise wins. */
  wins: number;
  /** Number of pairwise losses. */
  losses: number;
  /** Number of pairwise ties. */
  ties: number;
}

/**
 * Options for {@link computeEloRankings}.
 */
export interface EloRankingOptions {
  /** Starting rating for every candidate. @default 1000 */
  initialRating?: number;
  /** K-factor controlling rating volatility per comparison. @default 32 */
  kFactor?: number;
  /**
   * Difference in mean judge score at or below which a pairing counts as a
   * tie rather than a win/loss. @default 0.05
   */
  tieMargin?: number;
}

/**
 * Resolves a consensus options block into the minimum fraction of judges
 * that must pass.
 *
 * `minPassFraction` wins when set. Otherwise `'majority'` requires strictly
 * more than half to pass, and `'unanimity'` (the default) requires all.
 */
function resolveMinPassFraction(
  options: JudgeConsensusOptions | undefined,
  total: number
): number {
  if (options?.minPassFraction !== undefined) {
    return options.minPassFraction;
  }
  if (options?.mode === 'majority') {
    // Strictly more than half: ceil((total + 1) / 2) judges must pass.
    const needed = Math.floor(total / 2) + 1;
    return total > 0 ? needed / total : 1;
  }
  return 1;
}

/**
 * Aggregates several judges' verdicts for a single expectation into one
 * pass/fail result under an adjustable agreement threshold.
 *
 * Defaults to unanimity (every judge must pass), preserving the historical
 * AND semantics of multi-judge expectations. Pass `{ mode: 'majority' }` or
 * a numeric `minPassFraction` to relax the threshold.
 *
 * @param judgeResults - Per-judge results (the `judgeResults` array produced
 *   by the eval runner's multi-judge branch).
 * @param options - Consensus threshold. Omit for unanimity.
 *
 * @example
 * const out = aggregateMultiJudgeVerdicts(
 *   [{ pass: true }, { pass: true }, { pass: false }],
 *   { mode: 'majority' }
 * );
 * // out.pass === true  (2 of 3 pass, which is a majority)
 */
export function aggregateMultiJudgeVerdicts(
  judgeResults: EvalExpectationResult[],
  options?: JudgeConsensusOptions
): JudgeConsensusResult {
  const total = judgeResults.length;
  const passCount = judgeResults.filter((r) => r.pass).length;
  const passFraction = total > 0 ? passCount / total : 0;
  const minPassFraction = resolveMinPassFraction(options, total);

  const pass = total > 0 && passFraction >= minPassFraction;

  // Preserve the bare `${passCount}/${total} judges passed` summary for the
  // default (unanimity, no options) path so existing reports are unchanged;
  // annotate the summary only when a non-default threshold is in play.
  const hasCustomThreshold =
    options !== undefined &&
    (options.mode !== undefined || options.minPassFraction !== undefined);

  const details = hasCustomThreshold
    ? `${passCount}/${total} judges passed (threshold ${minPassFraction.toFixed(2)})`
    : `${passCount}/${total} judges passed`;

  return { pass, passCount, total, passFraction, details };
}

/**
 * Extracts numeric judge scores (0-1) from per-judge results, dropping any
 * entries without a usable score.
 */
export function scoresFromJudgeResults(
  judgeResults: EvalExpectationResult[]
): number[] {
  return judgeResults
    .map((r) => r.score)
    .filter((s): s is number => typeof s === 'number' && !Number.isNaN(s));
}

function meanScore(candidate: JudgeScoredCandidate): number {
  const { scores } = candidate;
  if (scores.length === 0) {
    return 0;
  }
  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
}

/**
 * Ranks candidate outputs from multi-judge scores using an Elo rating system.
 *
 * Each unordered pair of candidates is compared by mean judge score; the
 * winner gains rating and the loser loses it (ties split the update). After a
 * single round-robin pass, candidates are sorted by rating into a stable,
 * interpretable leaderboard. Comparisons are derived from existing judge
 * scores rather than fresh pairwise LLM queries, so ranking is free.
 *
 * @param candidates - One entry per candidate output, each carrying the
 *   scores its judges assigned.
 * @param options - Elo tuning knobs.
 * @returns Ranking entries sorted best-first.
 *
 * @example
 * const board = computeEloRankings([
 *   { id: 'v1', scores: [0.9, 0.85] },
 *   { id: 'v2', scores: [0.6, 0.55] },
 * ]);
 * // board[0].id === 'v1'  (higher mean score wins)
 */
export function computeEloRankings(
  candidates: JudgeScoredCandidate[],
  options: EloRankingOptions = {}
): EloRankingEntry[] {
  const initialRating = options.initialRating ?? 1000;
  const kFactor = options.kFactor ?? 32;
  const tieMargin = options.tieMargin ?? 0.05;

  const ratings = new Map<string, number>();
  const wins = new Map<string, number>();
  const losses = new Map<string, number>();
  const ties = new Map<string, number>();

  for (const candidate of candidates) {
    ratings.set(candidate.id, initialRating);
    wins.set(candidate.id, 0);
    losses.set(candidate.id, 0);
    ties.set(candidate.id, 0);
  }

  for (let a = 0; a < candidates.length; a++) {
    for (let b = a + 1; b < candidates.length; b++) {
      const candidateA = candidates[a]!;
      const candidateB = candidates[b]!;
      const scoreA = meanScore(candidateA);
      const scoreB = meanScore(candidateB);

      let actualA: number;
      let actualB: number;
      if (scoreA > scoreB + tieMargin) {
        actualA = 1;
        actualB = 0;
        wins.set(candidateA.id, wins.get(candidateA.id)! + 1);
        losses.set(candidateB.id, losses.get(candidateB.id)! + 1);
      } else if (scoreA < scoreB - tieMargin) {
        actualA = 0;
        actualB = 1;
        losses.set(candidateA.id, losses.get(candidateA.id)! + 1);
        wins.set(candidateB.id, wins.get(candidateB.id)! + 1);
      } else {
        actualA = 0.5;
        actualB = 0.5;
        ties.set(candidateA.id, ties.get(candidateA.id)! + 1);
        ties.set(candidateB.id, ties.get(candidateB.id)! + 1);
      }

      const ratingA = ratings.get(candidateA.id)!;
      const ratingB = ratings.get(candidateB.id)!;
      const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
      const expectedB = 1 - expectedA;
      ratings.set(candidateA.id, ratingA + kFactor * (actualA - expectedA));
      ratings.set(candidateB.id, ratingB + kFactor * (actualB - expectedB));
    }
  }

  const entries: EloRankingEntry[] = candidates.map((candidate) => ({
    id: candidate.id,
    rating: ratings.get(candidate.id)!,
    wins: wins.get(candidate.id)!,
    losses: losses.get(candidate.id)!,
    ties: ties.get(candidate.id)!,
    rank: 1,
  }));

  entries.sort((x, y) => y.rating - x.rating);

  // Competition ranking: tied ratings (within a tiny epsilon) share a rank.
  for (let i = 0; i < entries.length; i++) {
    const shared =
      i > 0 && Math.abs(entries[i]!.rating - entries[i - 1]!.rating) < 1e-9;
    entries[i]!.rank = shared ? entries[i - 1]!.rank : i + 1;
  }

  return entries;
}

/**
 * A candidate output that carries its raw per-judge results, ready to be
 * ranked by {@link rankCandidatesByJudgeResults}.
 */
export interface JudgeRankedCandidate {
  id: string;
  judgeResults: EvalExpectationResult[];
}

/**
 * Convenience wrapper around {@link computeEloRankings} that derives each
 * candidate's scores directly from the `EvalExpectationResult[]` shape the
 * eval runner produces, so real multi-judge outputs can be ranked as-is.
 *
 * @param candidates - One entry per candidate output.
 * @param options - Elo tuning knobs.
 */
export function rankCandidatesByJudgeResults(
  candidates: JudgeRankedCandidate[],
  options?: EloRankingOptions
): EloRankingEntry[] {
  return computeEloRankings(
    candidates.map((candidate) => ({
      id: candidate.id,
      scores: scoresFromJudgeResults(candidate.judgeResults),
    })),
    options
  );
}
