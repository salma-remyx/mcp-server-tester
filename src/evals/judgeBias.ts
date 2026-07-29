/**
 * Same-provider judge-bias audit and inter-judge agreement for multi-judge
 * eval cases.
 *
 * Adapted from: "Evaluating medical AI under missing information: same-provider
 * judges and human raters change apparent safety" (arxiv:2607.18828v1).
 *
 * Mode 2 (adapted port). The paper's two evaluator-facing results are kept at
 * full statistical fidelity and applied to this framework's native multi-judge
 * votes:
 *   1. Inter-judge agreement is only moderate (Fleiss' kappa ~= 0.65 in the
 *      paper) — measured here with {@link fleissKappa} over the per-case
 *      pass/fail vote matrix.
 *   2. After adjusting for each judge's general leniency, a positive
 *      same-provider association remains (the paper's vote-level logistic
 *      regression with judge fixed effects + exact permutation test) — measured
 *      here by a within-judge same-provider gap with a stratified permutation
 *      test ({@link auditJudgeBias}) that holds per-judge leniency fixed.
 *
 * What was intentionally substituted / cut (Mode 2): the medical / HealthBench
 * domain, the clinician-anchored human reference, the permissiveness-vs-human
 * comparison, and the MedQA closed-ended anchor are out of scope for this
 * testing framework — they are downstream / external artifacts. What remains is
 * the reliability lens the multi-judge aggregation previously collapsed with
 * naive AND semantics.
 */

import type {
  EvalExpectationResult,
  JudgeReliability,
  SameProviderBias,
} from '../types/index.js';
import type { EvalCaseResult } from '../types/reporter.js';

/** Default permutation iterations for the same-provider association test. */
const DEFAULT_PERMUTATION_ITERATIONS = 999;

/** Dataset-level judge-bias audit aggregated across multi-judge cases. */
export interface DatasetJudgeBias {
  /** Number of multi-judge cases that contributed votes. */
  cases: number;
  /** Total individual judge votes across all contributing cases. */
  totalVotes: number;
  /** Inter-judge agreement (Fleiss' kappa) over the pass/fail vote matrix.
   *  `null` when the matrix is degenerate (no items or no ratings). The source
   *  paper reports ~= 0.65 (moderate agreement). */
  fleissKappa: number | null;
  /** Raw (unadjusted) same-provider pass-rate gap (positive = same-provider
   *  judges more lenient). `null` when there are no same- or cross-provider
   *  votes to compare. */
  sameProviderGap: number | null;
  /** Same-provider gap after subtracting each judge's overall leniency — the
   *  analog of the paper's judge-fixed-effect logistic regression. This is what
   *  separates same-provider association from general judge severity. */
  sameProviderGapAdjusted: number | null;
  /** Two-sided permutation p-value for the adjusted gap under the null of no
   *  same-provider association (within-judge label permutation). `null` when no
   *  judge voted on both same- and cross-provider cases. */
  permutationPValue: number | null;
  /** Number of permutations used for the test (excluding the observed). */
  permutationIterations: number;
  /** Number of judges that had both same- and cross-provider votes — the
   *  informative strata for the permutation test. */
  informativeJudges: number;
}

/** Arithmetic mean; returns 0 for an empty input. */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Fleiss' kappa for categorical rater agreement across items.
 *
 * Each row is the per-category rating count for one item (for binary pass/fail,
 * a row is `[passes, fails]`). Rater counts may vary per item — Fleiss' kappa
 * handles ragged panels by design.
 *
 * Returns `1.0` when agreement is perfect (or there is a single rating per
 * item, where agreement is undefined but conventionally taken as perfect),
 * `null` when the matrix has no rated items, and a value in `(-1, 1)` otherwise.
 *
 * @param rows per-item category counts
 */
export function fleissKappa(rows: Array<ReadonlyArray<number>>): number | null {
  const items: number[][] = [];
  let categories = 0;
  for (const row of rows) {
    if (!row.some((count) => count > 0)) continue;
    items.push([...row]);
    categories = Math.max(categories, row.length);
  }
  if (items.length === 0 || categories === 0) return null;

  const categoryTotals = new Array<number>(categories).fill(0);
  let totalRatings = 0;
  let ratedItems = 0;
  let pBar = 0;
  for (const row of items) {
    const n = row.reduce((sum, count) => sum + count, 0);
    if (n <= 1) continue; // agreement undefined for a single rater
    ratedItems += 1;
    totalRatings += n;
    let sumSq = 0;
    for (let j = 0; j < categories; j++) {
      const count = row[j] ?? 0;
      categoryTotals[j] = (categoryTotals[j] ?? 0) + count;
      sumSq += count * count;
    }
    pBar += (sumSq - n) / (n * (n - 1));
  }

  if (ratedItems === 0 || totalRatings === 0) return null;
  pBar /= ratedItems;
  if (pBar >= 1) return 1; // perfect observed agreement

  let pE = 0;
  for (let j = 0; j < categories; j++) {
    const p = categoryTotals[j]! / totalRatings;
    pE += p * p;
  }
  if (pE >= 1) return 0; // no category variation -> agreement not informative
  return (pBar - pE) / (1 - pE);
}

/**
 * Compute per-case inter-judge agreement and the same-provider leniency flag.
 *
 * Returns `null` when fewer than 2 judges voted. The same-provider signal is
 * `null` when `candidateHostProvider` is unknown or no cross-provider judge
 * voted.
 *
 * @param judgeResults per-judge results for one case
 * @param candidateHostProvider provider of the candidate host under test
 */
export function computeJudgeReliability(
  judgeResults: EvalExpectationResult[],
  candidateHostProvider?: string
): JudgeReliability | null {
  const judges = judgeResults.filter(
    (result): result is EvalExpectationResult =>
      result !== undefined && result !== null
  );
  if (judges.length < 2) return null;

  const total = judges.length;
  const passCount = judges.filter((result) => result.pass).length;
  const failCount = total - passCount;
  const majority = Math.max(passCount, failCount);
  const agreement = majority / total;

  let category: JudgeReliability['category'];
  if (passCount === total || failCount === total) {
    category = 'unanimous';
  } else if (agreement > 0.5) {
    category = 'majority';
  } else {
    category = 'split';
  }

  let sameProvider: SameProviderBias | null = null;
  if (candidateHostProvider) {
    const same = judges.filter(
      (result) => result.judgeProvider === candidateHostProvider
    );
    const cross = judges.filter(
      (result) => result.judgeProvider !== candidateHostProvider
    );
    if (same.length > 0 && cross.length > 0) {
      const sameProviderPassRate = mean(
        same.map((result) => (result.pass ? 1 : 0))
      );
      const crossProviderPassRate = mean(
        cross.map((result) => (result.pass ? 1 : 0))
      );
      sameProvider = {
        candidateProvider: candidateHostProvider,
        sameProviderJudges: same.length,
        crossProviderJudges: cross.length,
        sameProviderPassRate,
        crossProviderPassRate,
        gap: sameProviderPassRate - crossProviderPassRate,
        biasFlag: sameProviderPassRate > crossProviderPassRate,
      };
    }
  }

  return {
    judgeCount: total,
    passCount,
    failCount,
    agreement,
    category,
    sameProvider,
  };
}

interface JudgeVote {
  /** Identity used to estimate general leniency (judge fixed effect). */
  judgeId: string;
  /** Provider used to label same- vs cross-provider. */
  provider: string;
  sameProvider: boolean;
  /** 1 = pass, 0 = fail. */
  pass: number;
}

/** Deterministic mulberry32 PRNG so permutation p-values are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Audit same-provider judge bias and inter-judge agreement across a whole run.
 *
 * Walks the multi-judge `passesJudge` results in `caseResults`, then computes:
 *   - Fleiss' kappa over the per-case pass/fail vote matrix.
 *   - The same-provider pass-rate gap, raw and leniency-adjusted (subtracting
 *     each judge's overall pass rate — the judge-fixed-effect analog).
 *   - A two-sided within-judge permutation p-value for the adjusted gap, which
 *     holds per-judge leniency fixed and tests only the same-provider label.
 *
 * Returns `null` when no case contributed multi-judge votes with a known
 * candidate provider.
 *
 * @param caseResults results from {@link runEvalDataset}
 * @param options.iterations permutation iterations (default 999)
 */
export function auditJudgeBias(
  caseResults: EvalCaseResult[],
  options?: { iterations?: number }
): DatasetJudgeBias | null {
  const iterations = options?.iterations ?? DEFAULT_PERMUTATION_ITERATIONS;
  const votes: JudgeVote[] = [];
  const kappaRows: number[][] = [];

  for (const caseResult of caseResults) {
    const judge = caseResult.expectations?.judge;
    const judgeResults = judge?.judgeResults;
    if (!judgeResults || judgeResults.length < 2) continue;

    const passes = judgeResults.filter((result) => result.pass).length;
    kappaRows.push([passes, judgeResults.length - passes]);

    const candidateProvider = caseResult.request?.mcpHostConfig?.provider;
    if (!candidateProvider) continue; // cannot label same-provider without it
    for (const result of judgeResults) {
      const provider = result.judgeProvider;
      if (!provider) continue; // unlabeled judge — cannot classify
      votes.push({
        judgeId: result.judgeModel ?? provider,
        provider,
        sameProvider: provider === candidateProvider,
        pass: result.pass ? 1 : 0,
      });
    }
  }

  if (kappaRows.length === 0) return null;
  const kappa = fleissKappa(kappaRows);

  const sameVotes = votes.filter((vote) => vote.sameProvider);
  const crossVotes = votes.filter((vote) => !vote.sameProvider);

  let sameProviderGap: number | null = null;
  let sameProviderGapAdjusted: number | null = null;
  let permutationPValue: number | null = null;
  let informativeJudges = 0;

  if (sameVotes.length > 0 && crossVotes.length > 0) {
    const sameRate = mean(sameVotes.map((vote) => vote.pass));
    const crossRate = mean(crossVotes.map((vote) => vote.pass));
    sameProviderGap = sameRate - crossRate;

    // Per-judge leniency = judge's overall pass rate (the "general severity"
    // the paper adjusts away before measuring the same-provider effect).
    const leniencyByJudge = new Map<string, number>();
    const groupedByJudge = new Map<string, number[]>();
    for (const vote of votes) {
      const arr = groupedByJudge.get(vote.judgeId) ?? [];
      arr.push(vote.pass);
      groupedByJudge.set(vote.judgeId, arr);
    }
    for (const [judgeId, passes] of groupedByJudge) {
      leniencyByJudge.set(judgeId, mean(passes));
    }

    const residual = (vote: JudgeVote): number =>
      vote.pass - (leniencyByJudge.get(vote.judgeId) ?? 0);

    const sameAdjusted = mean(sameVotes.map(residual));
    const crossAdjusted = mean(crossVotes.map(residual));
    sameProviderGapAdjusted = sameAdjusted - crossAdjusted;

    // Informative strata: judges that voted on both same- and cross-provider
    // cases — only these can be permuted to test the within-judge effect.
    const strata: JudgeVote[][] = [];
    const strataByJudge = new Map<string, JudgeVote[]>();
    for (const vote of votes) {
      const arr = strataByJudge.get(vote.judgeId) ?? [];
      arr.push(vote);
      strataByJudge.set(vote.judgeId, arr);
    }
    for (const group of strataByJudge.values()) {
      const hasSame = group.some((vote) => vote.sameProvider);
      const hasCross = group.some((vote) => !vote.sameProvider);
      if (hasSame && hasCross) {
        informativeJudges += 1;
        strata.push(group);
      }
    }

    if (informativeJudges > 0) {
      const observedAbs = Math.abs(sameProviderGapAdjusted);
      const rand = mulberry32(0x1a2b3c4d);
      let asExtreme = 0;
      for (let it = 0; it < iterations; it++) {
        let sameSum = 0;
        let sameN = 0;
        let crossSum = 0;
        let crossN = 0;
        for (const stratum of strata) {
          const k = stratum.filter((vote) => vote.sameProvider).length;
          const residuals = stratum.map(residual);
          // Fisher-Yates shuffle, then label the first k as "same-provider".
          for (let i = residuals.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            const tmp = residuals[i]!;
            residuals[i] = residuals[j]!;
            residuals[j] = tmp;
          }
          for (let i = 0; i < residuals.length; i++) {
            if (i < k) {
              sameSum += residuals[i]!;
              sameN += 1;
            } else {
              crossSum += residuals[i]!;
              crossN += 1;
            }
          }
        }
        const permutedGap =
          sameN > 0 && crossN > 0 ? sameSum / sameN - crossSum / crossN : 0;
        if (Math.abs(permutedGap) >= observedAbs) asExtreme += 1;
      }
      permutationPValue = (asExtreme + 1) / (iterations + 1);
    }
  }

  return {
    cases: kappaRows.length,
    totalVotes: votes.length,
    fleissKappa: kappa,
    sameProviderGap,
    sameProviderGapAdjusted,
    permutationPValue,
    permutationIterations: iterations,
    informativeJudges,
  };
}
