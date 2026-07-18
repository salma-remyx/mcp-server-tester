/**
 * Judge reliability audit — measurement-validity reporting for LLM-as-judge.
 *
 * Adapted from "When the Judge Changes, So Does the Measurement: Auditing
 * LLM-as-Judge Reliability" (arXiv:2607.08535v1). The paper's core contribution
 * is a measurement-validity audit: an LLM-as-judge score can move even when the
 * candidate responses stay fixed, simply because the evaluator changed, so judge
 * reports should surface dataset slices, bias probes, error-dependence estimates,
 * and a protocol audit trail.
 *
 * Mode 2 (adapted port): the paper's audit mechanism is implemented at full
 * fidelity against the multi-judge per-case results this framework already
 * produces. The paper's auxiliary empirical sweep (Qwen3 1.7B→32B scaling and
 * MiniMax M2→M2.7 API comparisons across four judgment datasets) and its pairwise
 * order-swapped position-bias protocol are substituted with target-native
 * equivalents: a single dataset-level audit over the repo's existing per-judge
 * votes, plus leniency and verbosity bias probes computable from the available
 * scores and response lengths.
 *
 * @packageDocumentation
 */

import type { EvalCaseResult } from '../types/reporter.js';
import type { EvalExpectationResult } from '../types/index.js';

/**
 * A single judge's vote on one case. Mirrors the fields the multi-judge
 * aggregation writes onto each entry of `EvalExpectationResult.judgeResults`.
 */
export interface JudgeVote {
  /** Rubric name (e.g. 'correctness') or custom judge name, when available. */
  judgeName?: string;
  /** Judge provider used (e.g. 'anthropic', 'openai'), when available. */
  judgeProvider?: string;
  /** Judge model used, when available. */
  judgeModel?: string;
  /** Whether this judge's pass threshold was met. */
  pass: boolean;
  /** Numeric judge score (0-1), when the judge emits one. */
  score?: number;
}

/**
 * One case's worth of multi-judge input to the audit.
 */
export interface JudgeReliabilityCaseInput {
  /** Case identifier. */
  id: string;
  /**
   * Character length of the candidate response that was judged, when known.
   * Used by the verbosity bias probe. Omit when the response length is unknown.
   */
  responseLength?: number;
  /** Each judge's vote for this case. Must contain at least one vote. */
  votes: JudgeVote[];
}

/**
 * Per-judge dataset slice: how a single judge voted across all cases it scored.
 */
export interface PerJudgeSlice {
  /** Stable judge label (provider/model/name joined, or 'unknown'). */
  judge: string;
  /** Provider, when any vote carried one. */
  provider?: string;
  /** Model, when any vote carried one. */
  model?: string;
  /** Number of cases this judge voted on. */
  sampleCount: number;
  /** Fraction of this judge's votes that passed (0-1). */
  passRate: number;
  /** Mean numeric score across this judge's scored votes (0-1), when any. */
  meanScore?: number;
}

/**
 * Evaluator-replacement drift: how much the measurement moves when the judge
 * changes while the candidate responses stay fixed. This is the paper's headline
 * "score can move even when the candidate responses stay fixed" signal.
 */
export interface EvaluatorReplacementDrift {
  /**
   * Mean absolute difference between judge scores within a case, averaged over
   * cases that have at least two numeric scores. Undefined when no case has two.
   */
  meanAbsScoreDelta?: number;
  /**
   * Fraction of multi-judge cases where the judges disagreed on the final
   * pass/fail decision (0-1). High values mean swapping a judge flips verdicts.
   */
  decisionDisagreementRate: number;
  /** Number of multi-judge cases that contributed. */
  sampleCount: number;
}

/**
 * Bias probes. The paper reports that stronger judges reduce but do not remove
 * position and verbosity bias; these proxies surface calibration and verbosity
 * effects that are computable from the available per-judge votes.
 */
export interface JudgeBiasProbes {
  /**
   * Leniency spread: max minus min of per-judge mean scores. Large values mean
   * judges systematically disagree on calibration (one grades easy, one hard).
   * Undefined when fewer than two judges emit numeric scores.
   */
  leniencySpread?: number;
  /**
   * Verbosity correlation: Pearson r between candidate response length and judge
   * score, pooled across scored votes that carry a response length. Positive
   * values indicate longer answers tend to score higher. Undefined when fewer
   * than two scored votes carry a response length.
   */
  verbosityCorrelation?: number;
  /** Number of scored votes that contributed to the verbosity correlation. */
  verbositySampleCount: number;
}

/**
 * Error-dependence estimate. The paper finds that repeated-sample juries add
 * little when errors are correlated — if judges fail on the same cases, agreeing
 * on more judges does not catch more failures. These agreement statistics estimate
 * that correlation directly from observed votes.
 */
export interface JudgeErrorDependenceEstimate {
  /** Fraction of multi-judge cases where every judge agreed on pass/fail (0-1). */
  unanimousAgreementRate: number;
  /**
   * Mean across-case pairwise agreement rate between judges (0-1). Values near
   * 1.0 mean errors are highly correlated and a multi-judge jury adds limited
   * signal; lower values mean judges catch different failures.
   */
  meanPairwiseAgreement: number;
  /** Number of multi-judge cases that contributed. */
  sampleCount: number;
}

/** One entry in the protocol audit trail. */
export interface JudgeAuditTrailEntry {
  /** Stable judge label. */
  judge: string;
  /** Provider, when known. */
  provider?: string;
  /** Model, when known. */
  model?: string;
  /** Number of cases this judge voted on. */
  sampleCount: number;
}

/**
 * Full reliability report for an eval run, in the shape the paper argues
 * LLM-as-judge reports should carry.
 */
export interface JudgeReliabilityReport {
  /** Number of multi-judge cases audited. */
  caseCount: number;
  /** Number of distinct judges observed. */
  judgeCount: number;
  /** Per-judge pass-rate slices (dataset slices). */
  perJudgeSlices: PerJudgeSlice[];
  /** How much the measurement moves when the judge changes. */
  evaluatorReplacementDrift: EvaluatorReplacementDrift;
  /** Bias probes. */
  biasProbes: JudgeBiasProbes;
  /** Error-dependence: are jury errors correlated? */
  errorDependence: JudgeErrorDependenceEstimate;
  /** Protocol audit trail: which judges/providers/models were used and how often. */
  auditTrail: JudgeAuditTrailEntry[];
  /** Human-readable summary flagging the measurement-validity problems. */
  summary: string;
}

/**
 * Build a stable, human-readable label for a vote, joining provider, model, and
 * name when present. Judges that carry no identifying fields collapse to
 * 'unknown' (they are indistinguishable in the recorded data).
 */
function judgeLabel(vote: JudgeVote): string {
  const parts = [vote.judgeProvider, vote.judgeModel, vote.judgeName].filter(
    (p): p is string => typeof p === 'string' && p.length > 0
  );
  return parts.length > 0 ? parts.join('/') : 'unknown';
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/**
 * Pearson correlation between two equal-length numeric series.
 * Returns undefined when there are fewer than two points or zero variance.
 */
function pearson(xs: number[], ys: number[]): number | undefined {
  if (xs.length < 2 || xs.length !== ys.length) return undefined;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : undefined;
}

/**
 * Estimate character length of a judged response for the verbosity bias probe.
 *
 * Prefers the summed length of text content blocks (the MCP text content the
 * judge actually read); falls back to the JSON length of the response when no
 * text blocks are present. Returns undefined when no response was recorded.
 */
function responseLength(response: unknown): number | undefined {
  if (response === undefined || response === null) return undefined;
  if (typeof response === 'object') {
    const r = response as { content?: unknown };
    if (Array.isArray(r.content) && r.content.length > 0) {
      let total = 0;
      let sawText = false;
      for (const block of r.content) {
        if (typeof block === 'object' && block !== null && 'text' in block) {
          const text = (block as { text?: unknown }).text;
          if (typeof text === 'string') {
            sawText = true;
            total += text.length;
          }
        }
      }
      if (sawText) return total;
    }
  }
  try {
    return JSON.stringify(response).length;
  } catch {
    return undefined;
  }
}

/**
 * Adapt an {@link EvalCaseResult} into audit input by reading the multi-judge
 * votes its aggregation already recorded. Returns null when the case has no
 * multi-judge breakdown (single judge, or no judge expectation).
 */
export function judgeReliabilityCaseFromResult(
  caseResult: EvalCaseResult
): JudgeReliabilityCaseInput | null {
  const entries = caseResult.expectations.judge?.judgeResults;
  if (!entries || entries.length === 0) return null;
  return {
    id: caseResult.id,
    responseLength: responseLength(caseResult.response),
    votes: entries.map(toVote),
  };
}

function toVote(entry: EvalExpectationResult): JudgeVote {
  return {
    judgeName: entry.judgeName,
    judgeProvider: entry.judgeProvider,
    judgeModel: entry.judgeModel,
    pass: entry.pass,
    score: typeof entry.score === 'number' ? entry.score : undefined,
  };
}

function buildPerJudgeSlices(
  cases: JudgeReliabilityCaseInput[]
): PerJudgeSlice[] {
  const groups = new Map<
    string,
    { votes: JudgeVote[]; provider?: string; model?: string }
  >();
  for (const c of cases) {
    for (const v of c.votes) {
      const label = judgeLabel(v);
      let group = groups.get(label);
      if (!group) {
        group = { votes: [], provider: v.judgeProvider, model: v.judgeModel };
        groups.set(label, group);
      }
      group.votes.push(v);
      if (group.provider === undefined && v.judgeProvider !== undefined) {
        group.provider = v.judgeProvider;
      }
      if (group.model === undefined && v.judgeModel !== undefined) {
        group.model = v.judgeModel;
      }
    }
  }

  const slices: PerJudgeSlice[] = [];
  for (const [label, group] of groups) {
    const sampleCount = group.votes.length;
    const passRate =
      sampleCount > 0
        ? group.votes.filter((v) => v.pass).length / sampleCount
        : 0;
    const scored = group.votes
      .map((v) => v.score)
      .filter((s): s is number => typeof s === 'number');
    const slice: PerJudgeSlice = { judge: label, sampleCount, passRate };
    if (group.provider !== undefined) slice.provider = group.provider;
    if (group.model !== undefined) slice.model = group.model;
    if (scored.length > 0) slice.meanScore = mean(scored);
    slices.push(slice);
  }
  // Deterministic order: by descending sample count, then label.
  slices.sort((a, b) =>
    b.sampleCount === a.sampleCount
      ? a.judge.localeCompare(b.judge)
      : b.sampleCount - a.sampleCount
  );
  return slices;
}

function meanAbsPairwiseDelta(scores: number[]): number | undefined {
  if (scores.length < 2) return undefined;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < scores.length; i++) {
    for (let j = i + 1; j < scores.length; j++) {
      sum += Math.abs(scores[i]! - scores[j]!);
      count++;
    }
  }
  return count > 0 ? sum / count : undefined;
}

function buildEvaluatorReplacementDrift(
  cases: JudgeReliabilityCaseInput[]
): EvaluatorReplacementDrift {
  const multiJudge = cases.filter((c) => c.votes.length >= 2);
  const sampleCount = multiJudge.length;
  if (sampleCount === 0) {
    return { decisionDisagreementRate: 0, sampleCount: 0 };
  }
  const disagreements = multiJudge.filter((c) => {
    const first = c.votes[0]!.pass;
    return c.votes.some((v) => v.pass !== first);
  }).length;

  const deltas: number[] = [];
  for (const c of multiJudge) {
    const scored = c.votes
      .map((v) => v.score)
      .filter((s): s is number => typeof s === 'number');
    const delta = meanAbsPairwiseDelta(scored);
    if (delta !== undefined) deltas.push(delta);
  }

  const drift: EvaluatorReplacementDrift = {
    decisionDisagreementRate: disagreements / sampleCount,
    sampleCount,
  };
  if (deltas.length > 0) drift.meanAbsScoreDelta = mean(deltas);
  return drift;
}

function buildBiasProbes(
  cases: JudgeReliabilityCaseInput[],
  slices: PerJudgeSlice[]
): JudgeBiasProbes {
  const meanScores = slices
    .map((s) => s.meanScore)
    .filter((s): s is number => typeof s === 'number')
    .sort((a, b) => a - b);

  const lengths: number[] = [];
  const scores: number[] = [];
  for (const c of cases) {
    if (c.responseLength === undefined) continue;
    for (const v of c.votes) {
      if (typeof v.score === 'number') {
        lengths.push(c.responseLength);
        scores.push(v.score);
      }
    }
  }

  const probes: JudgeBiasProbes = { verbositySampleCount: scores.length };
  if (meanScores.length >= 2) {
    probes.leniencySpread = meanScores[meanScores.length - 1]! - meanScores[0]!;
  }
  const r = pearson(lengths, scores);
  if (r !== undefined) probes.verbosityCorrelation = r;
  return probes;
}

function buildErrorDependence(
  cases: JudgeReliabilityCaseInput[]
): JudgeErrorDependenceEstimate {
  const multiJudge = cases.filter((c) => c.votes.length >= 2);
  const sampleCount = multiJudge.length;
  if (sampleCount === 0) {
    return {
      unanimousAgreementRate: 0,
      meanPairwiseAgreement: 0,
      sampleCount: 0,
    };
  }
  const unanimous = multiJudge.filter((c) => {
    const first = c.votes[0]!.pass;
    return c.votes.every((v) => v.pass === first);
  }).length;

  // Per-judge pass decisions keyed by case id, for pairwise agreement.
  const judgeCases = new Map<string, Map<string, boolean>>();
  for (const c of multiJudge) {
    for (const v of c.votes) {
      const label = judgeLabel(v);
      let byCase = judgeCases.get(label);
      if (!byCase) {
        byCase = new Map();
        judgeCases.set(label, byCase);
      }
      byCase.set(c.id, v.pass);
    }
  }

  const labels = [...judgeCases.keys()];
  let pairSum = 0;
  let pairCount = 0;
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = judgeCases.get(labels[i]!)!;
      const b = judgeCases.get(labels[j]!)!;
      let shared = 0;
      let agree = 0;
      for (const [caseId, passA] of a) {
        const passB = b.get(caseId);
        if (passB === undefined) continue;
        shared++;
        if (passA === passB) agree++;
      }
      if (shared > 0) {
        pairSum += agree / shared;
        pairCount++;
      }
    }
  }

  return {
    unanimousAgreementRate: unanimous / sampleCount,
    meanPairwiseAgreement: pairCount > 0 ? pairSum / pairCount : 1,
    sampleCount,
  };
}

function buildSummary(
  caseCount: number,
  judgeCount: number,
  drift: EvaluatorReplacementDrift,
  bias: JudgeBiasProbes,
  dependence: JudgeErrorDependenceEstimate,
  trail: JudgeAuditTrailEntry[]
): string {
  if (caseCount === 0) {
    return 'No multi-judge cases — run passesJudge with 2+ judges to audit evaluator-replacement reliability.';
  }
  const parts: string[] = [
    `${judgeCount} judge${judgeCount === 1 ? '' : 's'} audited across ${caseCount} multi-judge case${caseCount === 1 ? '' : 's'}.`,
  ];
  parts.push(
    `Decisions disagreed on ${Math.round(drift.decisionDisagreementRate * 100)}% of cases` +
      (drift.meanAbsScoreDelta !== undefined
        ? ` (mean |score delta| ${drift.meanAbsScoreDelta.toFixed(2)})`
        : '') +
      ' — evaluator-replacement drift.'
  );
  parts.push(
    `Mean pairwise judge agreement ${(dependence.meanPairwiseAgreement * 100).toFixed(0)}%` +
      (dependence.meanPairwiseAgreement >= 0.9
        ? ' — errors look correlated, so a multi-judge jury adds limited signal.'
        : ' — judges catch different failures.')
  );
  const biasBits: string[] = [];
  if (bias.leniencySpread !== undefined) {
    biasBits.push(`leniency spread ${bias.leniencySpread.toFixed(2)}`);
  }
  if (bias.verbosityCorrelation !== undefined) {
    biasBits.push(
      `verbosity r ${bias.verbosityCorrelation.toFixed(2)} (n=${bias.verbositySampleCount})`
    );
  }
  if (biasBits.length > 0) parts.push(`Bias probes: ${biasBits.join(', ')}.`);
  parts.push(
    `Audit trail: ${trail
      .map((t) => `${t.judge} (${t.sampleCount})`)
      .join(', ')}.`
  );
  return parts.join(' ');
}

/**
 * Audit the reliability of an LLM-as-judge measurement across multi-judge cases.
 *
 * Pure and side-effect free: takes the per-judge votes already aggregated by the
 * eval runner and returns a measurement-validity report in the shape the paper
 * argues LLM-as-judge reports should carry (dataset slices, bias probes,
 * error-dependence estimates, and a protocol audit trail).
 *
 * Use after {@link runEvalDataset} with cases that configure `passesJudge` as an
 * array of two or more judges, or feed it any list of {@link JudgeReliabilityCaseInput}.
 */
export function auditJudgeReliability(
  cases: JudgeReliabilityCaseInput[]
): JudgeReliabilityReport {
  const filtered = cases.filter(
    (c) => Array.isArray(c.votes) && c.votes.length > 0
  );
  const caseCount = filtered.length;

  const perJudgeSlices = buildPerJudgeSlices(filtered);
  const judgeCount = perJudgeSlices.length;
  const drift = buildEvaluatorReplacementDrift(filtered);
  const biasProbes = buildBiasProbes(filtered, perJudgeSlices);
  const errorDependence = buildErrorDependence(filtered);
  const auditTrail: JudgeAuditTrailEntry[] = perJudgeSlices.map((s) => {
    const entry: JudgeAuditTrailEntry = {
      judge: s.judge,
      sampleCount: s.sampleCount,
    };
    if (s.provider !== undefined) entry.provider = s.provider;
    if (s.model !== undefined) entry.model = s.model;
    return entry;
  });

  return {
    caseCount,
    judgeCount,
    perJudgeSlices,
    evaluatorReplacementDrift: drift,
    biasProbes,
    errorDependence,
    auditTrail,
    summary: buildSummary(
      caseCount,
      judgeCount,
      drift,
      biasProbes,
      errorDependence,
      auditTrail
    ),
  };
}
