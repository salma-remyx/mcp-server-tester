import type { EvalCaseResult } from '../types/reporter.js';
import type { ExpectationType } from '../types/index.js';
import type {
  EvalCaseComparison,
  EvalRunComparisonResult,
} from './evalRunComparison.js';

/**
 * Reliability-gated automated scoring — adapted from Project Kaleidoscope
 * (https://arxiv.org/abs/2607.14673v1).
 *
 * Kaleidoscope's central reliability mechanism: LLM judges automate scoring
 * ONLY when their agreement with human labels meets a configured threshold.
 * When the judge is not demonstrably reliable on a rubric, automated scores
 * are withheld and the affected cases are flagged for human review instead of
 * silently trusted.
 *
 * This module implements that gate against data the framework already
 * produces. It does not reproduce Kaleidoscope's persona-based test
 * generation, human-review annotation UI, or rubric-authoring workflow — the
 * repo already hosts eval datasets, multi-iteration accuracy, built-in
 * rubrics, and a custom-judge registry. What is kept at full fidelity is the
 * gate itself: calibrate judge reliability against human labels, then permit
 * automated scoring only where that reliability is established (and, per case,
 * where the individual judges agree).
 */

/**
 * Default agreement threshold (match rate between judge and human labels)
 * above which automated scoring is permitted. 0.8 mirrors a common
 * inter-annotator reliability bar.
 */
export const DEFAULT_RELIABILITY_THRESHOLD = 0.8;

/**
 * Default minimum calibration sample size. Below this, the gate stays closed —
 * Kaleidoscope's premise is that reliability must be demonstrated on enough
 * labeled examples, not assumed.
 */
export const DEFAULT_MIN_CALIBRATION_SAMPLE = 10;

/**
 * Default per-case multi-judge consensus threshold. Even when the judge is
 * calibrated as reliable overall, a case on which the individual judges split
 * is flagged for review rather than auto-scored.
 */
export const DEFAULT_JUDGE_CONSENSUS_THRESHOLD = 0.6;

/** A single labeled observation: what the judge decided vs. the human label. */
export interface CalibrationExample {
  /** Case identifier this observation came from. */
  caseId: string;
  /** The judge's pass/fail decision for this case. */
  judgeDecision: boolean;
  /** The human reviewer's pass/fail label for this case. */
  humanLabel: boolean;
}

/** Options controlling the calibration gate. */
export interface CalibrationOptions {
  /**
   * Minimum match rate (judge vs. human) required to permit automated
   * scoring. Defaults to {@link DEFAULT_RELIABILITY_THRESHOLD}.
   */
  threshold?: number;
  /**
   * Minimum number of labeled examples required before automated scoring is
   * permitted, regardless of observed agreement. Defaults to
   * {@link DEFAULT_MIN_CALIBRATION_SAMPLE}.
   */
  minSampleSize?: number;
}

/**
 * Result of calibrating judge reliability against a set of human-labeled
 * examples.
 */
export interface ReliabilityCalibration {
  /** Number of labeled examples used. */
  sampleSize: number;
  /** Match rate between judge decisions and human labels (0–1). */
  matchRate: number;
  /** Cohen's kappa, chance-corrected agreement (−1..1). */
  cohensKappa: number;
  /** Agreement on positive (pass) cases specifically (0–1). */
  positiveAgreement: number;
  /** Fraction of examples on which judge and human disagreed (0–1). */
  disagreement: number;
  /** Threshold the gate was evaluated against. */
  threshold: number;
  /** Whether automated scoring is permitted under this calibration. */
  autoScorePermitted: boolean;
  /** Human-readable reason for the gate decision. */
  reason: string;
}

/** Whether a case's automated score can be trusted or needs human review. */
export type ScoringTrust = 'auto' | 'needs-review';

/** Per-case decision under a reliability gate. */
export interface GatedScoringDecision {
  /** Case identifier. */
  caseId: string;
  /** Whether the automated score is trusted for this case. */
  trust: ScoringTrust;
  /** The automated pass/fail when trusted, otherwise `null`. */
  automatedPass: boolean | null;
  /** Per-case judge consensus (0–1), when a multi-judge signal is present. */
  judgeConsensus: number | null;
  /** Reason for the trust decision. */
  reason: string;
}

/**
 * A run-comparison view in which only reliability-gated cases contribute to
 * the pass-rate delta. Adapted from Kaleidoscope's reliability-gated scoring
 * applied to regression detection across runs.
 */
export interface GatedComparisonView {
  /** Label of the baseline run. */
  baselineLabel: string;
  /** Label of the candidate run. */
  candidateLabel: string;
  /** Baseline pass rate computed from trusted cases only, when any exist. */
  gatedBaselinePassRate: number | null;
  /** Candidate pass rate computed from trusted cases only, when any exist. */
  gatedCandidatePassRate: number | null;
  /** Candidate minus baseline pass rate over trusted cases, when computable. */
  gatedDeltaPassRate: number | null;
  /** Ungated delta, surfaced so gated vs. ungated can be compared directly. */
  ungatedDeltaPassRate: number;
  /** Case IDs whose automated scores are trusted. */
  trustedCaseIds: string[];
  /** Case IDs flagged for human review. */
  needsReviewCaseIds: string[];
  /** Regressions (passed→failed) whose outcome survives the gate. */
  trustedRegressions: EvalCaseComparison[];
  /** Improvements (failed→passed) whose outcome survives the gate. */
  trustedImprovements: EvalCaseComparison[];
}

/**
 * Calibrate judge reliability against human labels and decide whether
 * automated scoring may be trusted.
 *
 * The gate is permitted only when (a) enough labeled examples were provided
 * and (b) the judge's match rate against those labels meets the threshold.
 */
export function calibrateJudgeReliability(
  examples: CalibrationExample[],
  options?: CalibrationOptions
): ReliabilityCalibration {
  const threshold = options?.threshold ?? DEFAULT_RELIABILITY_THRESHOLD;
  const minSampleSize =
    options?.minSampleSize ?? DEFAULT_MIN_CALIBRATION_SAMPLE;

  const sampleSize = examples.length;

  if (sampleSize === 0) {
    return noSampleCalibration(threshold);
  }

  let bothPass = 0;
  let judgePassHumanFail = 0;
  let judgeFailHumanPass = 0;
  let bothFail = 0;

  for (const example of examples) {
    if (example.judgeDecision && example.humanLabel) bothPass += 1;
    else if (example.judgeDecision && !example.humanLabel)
      judgePassHumanFail += 1;
    else if (!example.judgeDecision && example.humanLabel)
      judgeFailHumanPass += 1;
    else bothFail += 1;
  }

  const matches = bothPass + bothFail;
  const matchRate = matches / sampleSize;
  const disagreement = 1 - matchRate;

  const humanPositive = bothPass + judgeFailHumanPass;
  const judgePositive = bothPass + judgePassHumanFail;
  const positiveAgreement =
    humanPositive + judgePositive > 0
      ? bothPass / (humanPositive + judgePositive)
      : matchRate;

  const cohensKappa = computeCohensKappa(
    bothPass,
    judgePassHumanFail,
    judgeFailHumanPass,
    bothFail
  );

  if (sampleSize < minSampleSize) {
    return {
      sampleSize,
      matchRate,
      cohensKappa,
      positiveAgreement,
      disagreement,
      threshold,
      autoScorePermitted: false,
      reason: `Insufficient calibration sample (${sampleSize} < ${minSampleSize}); human review required.`,
    };
  }

  const autoScorePermitted = matchRate >= threshold;
  const reason = autoScorePermitted
    ? `Judge agreement ${matchRate.toFixed(3)} >= threshold ${threshold.toFixed(3)}; automated scoring permitted.`
    : `Judge agreement ${matchRate.toFixed(3)} < threshold ${threshold.toFixed(3)}; human review required.`;

  return {
    sampleSize,
    matchRate,
    cohensKappa,
    positiveAgreement,
    disagreement,
    threshold,
    autoScorePermitted,
    reason,
  };
}

/**
 * Build a calibration set from completed eval case results plus a map of
 * human labels keyed by case ID. The judge decision for each case is read
 * from its `judge` expectation when present, falling back to the case's
 * overall `pass` status.
 */
export function buildCalibrationFromCases(
  cases: EvalCaseResult[],
  humanLabels: Record<string, boolean>,
  options?: { judgeExpectationKey?: ExpectationType }
): CalibrationExample[] {
  const judgeKey = options?.judgeExpectationKey ?? 'judge';
  const examples: CalibrationExample[] = [];

  for (const caseResult of cases) {
    const humanLabel = humanLabels[caseResult.id];
    if (humanLabel === undefined) continue;

    const judgeExpectation = caseResult.expectations[judgeKey];
    const judgeDecision =
      judgeExpectation && typeof judgeExpectation.pass === 'boolean'
        ? judgeExpectation.pass
        : caseResult.pass;

    examples.push({
      caseId: caseResult.id,
      judgeDecision,
      humanLabel,
    });
  }

  return examples;
}

/**
 * Per-case multi-judge consensus: the fraction of individual judges that
 * agreed with the majority outcome. Returns `null` when no per-judge
 * breakdown is present (e.g. a single-judge eval), in which case there is no
 * internal-disagreement signal to act on.
 */
export function judgeConsensus(caseResult: EvalCaseResult): number | null {
  const judgeExpectation = caseResult.expectations.judge;
  const votes = judgeExpectation?.judgeResults;
  if (!votes || votes.length === 0) return null;

  const passVotes = votes.filter(
    (vote) => vote.pass === true || (vote.score ?? 0) >= 0.5
  ).length;
  const majority = Math.max(passVotes, votes.length - passVotes);
  return majority / votes.length;
}

/**
 * Decide whether a single case's automated score can be trusted under a
 * reliability gate. When the overall calibration is unreliable, every case
 * needs review. When it is reliable, a case still needs review if its
 * individual judges disagree below the per-case consensus threshold.
 */
export function gateCaseScoring(
  caseResult: EvalCaseResult,
  calibration: ReliabilityCalibration,
  options?: { judgeConsensusThreshold?: number }
): GatedScoringDecision {
  const consensusThreshold =
    options?.judgeConsensusThreshold ?? DEFAULT_JUDGE_CONSENSUS_THRESHOLD;

  if (!calibration.autoScorePermitted) {
    return {
      caseId: caseResult.id,
      trust: 'needs-review',
      automatedPass: null,
      judgeConsensus: judgeConsensus(caseResult),
      reason: 'Judge not calibrated as reliable; human review required.',
    };
  }

  const consensus = judgeConsensus(caseResult);
  if (consensus !== null && consensus < consensusThreshold) {
    return {
      caseId: caseResult.id,
      trust: 'needs-review',
      automatedPass: null,
      judgeConsensus: consensus,
      reason: `Per-case judge consensus ${consensus.toFixed(3)} < ${consensusThreshold.toFixed(3)}; human review required.`,
    };
  }

  const judgeExpectation = caseResult.expectations.judge;
  const automatedPass =
    judgeExpectation && typeof judgeExpectation.pass === 'boolean'
      ? judgeExpectation.pass
      : caseResult.pass;

  return {
    caseId: caseResult.id,
    trust: 'auto',
    automatedPass,
    judgeConsensus: consensus,
    reason: 'Automated score trusted under reliability gate.',
  };
}

/**
 * Apply a reliability gate to an eval run comparison, producing the gated
 * view Kaleidoscope recommends for regression detection: pass-rate deltas
 * and improvement/regression buckets computed only from cases whose
 * automated scores are trusted, with everything else routed to human review.
 *
 * This is the direct answer to "how does gated scoring change the detection
 * of performance shifts vs. traditional ungated scoring" — the ungated delta
 * is surfaced alongside the gated one so the two can be compared.
 */
export function applyReliabilityGate(
  comparison: EvalRunComparisonResult,
  calibration: ReliabilityCalibration,
  options?: { judgeConsensusThreshold?: number }
): GatedComparisonView {
  const trustedCaseIds: string[] = [];
  const needsReviewCaseIds: string[] = [];
  const trustedByCandidate = new Map<string, boolean>();

  for (const comparisonCase of comparison.cases) {
    const candidate = comparisonCase.candidate;
    if (!candidate) continue;

    const decision = gateCaseScoring(candidate, calibration, options);
    if (decision.trust === 'auto' && decision.automatedPass !== null) {
      trustedCaseIds.push(candidate.id);
      trustedByCandidate.set(candidate.id, decision.automatedPass);
    } else {
      needsReviewCaseIds.push(candidate.id);
    }
  }

  const trustedPassRates = computeTrustedPassRates(
    comparison,
    trustedByCandidate
  );

  const trustedRegressions = filterTrusted(
    comparison.regressedCases,
    trustedByCandidate
  );
  const trustedImprovements = filterTrusted(
    comparison.improvedCases,
    trustedByCandidate
  );

  return {
    baselineLabel: comparison.baselineLabel,
    candidateLabel: comparison.candidateLabel,
    gatedBaselinePassRate: trustedPassRates.baseline,
    gatedCandidatePassRate: trustedPassRates.candidate,
    gatedDeltaPassRate: trustedPassRates.delta,
    ungatedDeltaPassRate: comparison.deltaPassRate,
    trustedCaseIds,
    needsReviewCaseIds,
    trustedRegressions,
    trustedImprovements,
  };
}

/**
 * Compute Cohen's kappa from a 2x2 confusion matrix of
 * (judgeDecision, humanLabel) counts.
 *
 * kappa = (po - pe) / (1 - pe), where po is observed agreement and pe is the
 * agreement expected by chance. The 0/0 edge case (single-class data) returns
 * the observed agreement, since chance agreement is undefined there.
 */
function computeCohensKappa(
  bothPass: number,
  judgePassHumanFail: number,
  judgeFailHumanPass: number,
  bothFail: number
): number {
  const total = bothPass + judgePassHumanFail + judgeFailHumanPass + bothFail;
  if (total === 0) return 0;

  const observed = (bothPass + bothFail) / total;
  const judgePositiveRate = (bothPass + judgePassHumanFail) / total;
  const humanPositiveRate = (bothPass + judgeFailHumanPass) / total;
  const expected =
    judgePositiveRate * humanPositiveRate +
    (1 - judgePositiveRate) * (1 - humanPositiveRate);

  if (expected >= 1) return observed;
  return (observed - expected) / (1 - expected);
}

function noSampleCalibration(threshold: number): ReliabilityCalibration {
  return {
    sampleSize: 0,
    matchRate: 0,
    cohensKappa: 0,
    positiveAgreement: 0,
    disagreement: 1,
    threshold,
    autoScorePermitted: false,
    reason: 'No labeled calibration examples provided; human review required.',
  };
}

function computeTrustedPassRates(
  comparison: EvalRunComparisonResult,
  trustedByCandidate: Map<string, boolean>
): {
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
} {
  if (trustedByCandidate.size === 0) {
    return { baseline: null, candidate: null, delta: null };
  }

  let baselinePassed = 0;
  let candidatePassed = 0;
  let counted = 0;

  for (const comparisonCase of comparison.cases) {
    const candidateId = comparisonCase.candidate?.id;
    if (candidateId === undefined || !trustedByCandidate.has(candidateId)) {
      continue;
    }
    counted += 1;
    if (comparisonCase.baseline?.pass) baselinePassed += 1;
    if (trustedByCandidate.get(candidateId)) candidatePassed += 1;
  }

  if (counted === 0) {
    return { baseline: null, candidate: null, delta: null };
  }

  const baseline = baselinePassed / counted;
  const candidate = candidatePassed / counted;
  return { baseline, candidate, delta: candidate - baseline };
}

function filterTrusted(
  cases: EvalCaseComparison[],
  trustedByCandidate: Map<string, boolean>
): EvalCaseComparison[] {
  return cases.filter(
    (comparisonCase) =>
      comparisonCase.candidate !== undefined &&
      trustedByCandidate.has(comparisonCase.candidate.id)
  );
}
