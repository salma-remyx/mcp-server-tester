import { describe, expect, it } from 'vitest';
import type { EvalCaseResult } from '../types/reporter.js';
import type { EvalRunnerResult } from './evalRunner.js';
import { compareEvalRuns } from './evalRunComparison.js';
import {
  applyReliabilityGate,
  buildCalibrationFromCases,
  calibrateJudgeReliability,
  gateCaseScoring,
  judgeConsensus,
  type CalibrationExample,
} from './reliabilityGatedScoring.js';

/**
 * Build a realistic eval case result with a `judge` expectation. These
 * fixtures are constructed against the real `EvalCaseResult` type so the gate
 * is exercised against the same shape the framework produces.
 */
function createJudgeCase(
  id: string,
  judgePass: boolean,
  options?: {
    casePass?: boolean;
    judgeVotes?: Array<{ pass: boolean }>;
    humanLabel?: boolean;
  }
): EvalCaseResult {
  const casePass = options?.casePass ?? judgePass;
  return {
    id,
    datasetName: 'reliability-test',
    toolName: 'search',
    source: 'eval',
    pass: casePass,
    expectations: {
      judge: {
        pass: judgePass,
        score: judgePass ? 0.9 : 0.2,
        judgeName: 'correctness',
        judgeProvider: 'anthropic',
        judgeResults: options?.judgeVotes?.map((vote) => ({
          pass: vote.pass,
          score: vote.pass ? 0.9 : 0.2,
        })),
      },
    },
    durationMs: 5,
  };
}

function createRun(cases: EvalCaseResult[]): EvalRunnerResult {
  const passed = cases.filter((c) => c.pass).length;
  return {
    total: cases.length,
    passed,
    failed: cases.length - passed,
    caseResults: cases,
    durationMs: 10,
  };
}

function labeledExample(
  caseId: string,
  judgeDecision: boolean,
  humanLabel: boolean
): CalibrationExample {
  return { caseId, judgeDecision, humanLabel };
}

describe('calibrateJudgeReliability', () => {
  it('permits automated scoring when judge agreement meets the threshold', () => {
    // 9 of 10 judge decisions agree with the human label → 0.9 >= 0.8.
    const examples: CalibrationExample[] = [
      labeledExample('a', true, true),
      labeledExample('b', true, true),
      labeledExample('c', true, true),
      labeledExample('d', true, true),
      labeledExample('e', true, true),
      labeledExample('f', false, false),
      labeledExample('g', false, false),
      labeledExample('h', false, false),
      labeledExample('i', false, false),
      labeledExample('j', true, false), // disagreement
    ];

    const calibration = calibrateJudgeReliability(examples);

    expect(calibration.sampleSize).toBe(10);
    expect(calibration.matchRate).toBeCloseTo(0.9, 5);
    expect(calibration.autoScorePermitted).toBe(true);
    expect(calibration.reason).toContain('permitted');
  });

  it('closes the gate when judge agreement falls below the threshold', () => {
    // 5 of 10 agree → 0.5 < 0.8.
    const examples: CalibrationExample[] = [
      labeledExample('a', true, true),
      labeledExample('b', true, true),
      labeledExample('c', true, true),
      labeledExample('d', true, true),
      labeledExample('e', true, true),
      labeledExample('f', true, false),
      labeledExample('g', true, false),
      labeledExample('h', false, true),
      labeledExample('i', false, true),
      labeledExample('j', false, false),
    ];

    const calibration = calibrateJudgeReliability(examples);

    expect(calibration.matchRate).toBeCloseTo(0.6, 5);
    expect(calibration.autoScorePermitted).toBe(false);
    expect(calibration.reason).toContain('human review');
  });

  it('keeps the gate closed when the calibration sample is too small', () => {
    // Perfect agreement, but only 3 examples — below the default minimum of 10.
    const examples: CalibrationExample[] = [
      labeledExample('a', true, true),
      labeledExample('b', false, false),
      labeledExample('c', true, true),
    ];

    const calibration = calibrateJudgeReliability(examples);

    expect(calibration.matchRate).toBe(1);
    expect(calibration.autoScorePermitted).toBe(false);
    expect(calibration.reason).toContain('Insufficient calibration sample');
  });

  it('computes a positive Cohen’s kappa for better-than-chance agreement', () => {
    const examples: CalibrationExample[] = [
      labeledExample('a', true, true),
      labeledExample('b', true, true),
      labeledExample('c', true, true),
      labeledExample('d', true, true),
      labeledExample('e', false, false),
      labeledExample('f', false, false),
      labeledExample('g', false, false),
      labeledExample('h', false, false),
      labeledExample('i', true, false),
      labeledExample('j', false, true),
    ];

    const calibration = calibrateJudgeReliability(examples, {
      minSampleSize: 5,
    });

    expect(calibration.matchRate).toBeCloseTo(0.8, 5);
    expect(calibration.cohensKappa).toBeGreaterThan(0);
    expect(calibration.autoScorePermitted).toBe(true);
  });

  it('returns a closed gate with no sample when given no examples', () => {
    const calibration = calibrateJudgeReliability([]);

    expect(calibration.sampleSize).toBe(0);
    expect(calibration.autoScorePermitted).toBe(false);
  });
});

describe('buildCalibrationFromCases', () => {
  it('pairs the judge decision from each case with a human label map', () => {
    const cases = [
      createJudgeCase('a', true),
      createJudgeCase('b', false),
      createJudgeCase('c', true),
    ];
    const humanLabels: Record<string, boolean> = {
      a: true,
      b: true,
      c: false,
    };

    const examples = buildCalibrationFromCases(cases, humanLabels);

    expect(examples).toEqual([
      { caseId: 'a', judgeDecision: true, humanLabel: true },
      { caseId: 'b', judgeDecision: false, humanLabel: true },
      { caseId: 'c', judgeDecision: true, humanLabel: false },
    ]);
  });

  it('skips cases that have no human label', () => {
    const cases = [createJudgeCase('a', true), createJudgeCase('b', false)];
    const examples = buildCalibrationFromCases(cases, { a: true });

    expect(examples).toHaveLength(1);
    expect(examples[0]?.caseId).toBe('a');
  });
});

describe('judgeConsensus', () => {
  it('returns null when there is no multi-judge breakdown', () => {
    expect(judgeConsensus(createJudgeCase('a', true))).toBeNull();
  });

  it('returns 1.0 when all judges agree', () => {
    const caseResult = createJudgeCase('a', true, {
      judgeVotes: [{ pass: true }, { pass: true }, { pass: true }],
    });
    expect(judgeConsensus(caseResult)).toBe(1);
  });

  it('returns the majority fraction when judges split', () => {
    const caseResult = createJudgeCase('a', true, {
      judgeVotes: [{ pass: true }, { pass: true }, { pass: false }],
    });
    expect(judgeConsensus(caseResult)).toBeCloseTo(2 / 3, 5);
  });
});

describe('gateCaseScoring', () => {
  it('trusts the automated score when the calibration is reliable', () => {
    const calibration = calibrateJudgeReliability(
      Array.from({ length: 10 }, (_, index) =>
        labeledExample(`c${index}`, true, true)
      )
    );
    expect(calibration.autoScorePermitted).toBe(true);

    const decision = gateCaseScoring(createJudgeCase('x', true), calibration);

    expect(decision.trust).toBe('auto');
    expect(decision.automatedPass).toBe(true);
  });

  it('routes a low-consensus case to review even when the gate is open', () => {
    const calibration = calibrateJudgeReliability(
      Array.from({ length: 10 }, (_, index) =>
        labeledExample(`c${index}`, true, true)
      )
    );
    // 2 of 4 judges pass → 0.5 majority < default 0.6 consensus threshold.
    const splitCase = createJudgeCase('split', true, {
      judgeVotes: [
        { pass: true },
        { pass: true },
        { pass: false },
        { pass: false },
      ],
    });

    const decision = gateCaseScoring(splitCase, calibration);

    expect(decision.trust).toBe('needs-review');
    expect(decision.automatedPass).toBeNull();
    expect(decision.judgeConsensus).toBeCloseTo(0.5, 5);
  });

  it('routes every case to review when the calibration is unreliable', () => {
    const calibration = calibrateJudgeReliability(
      Array.from({ length: 10 }, (_, index) =>
        labeledExample(`c${index}`, true, index % 2 === 0)
      )
    );
    expect(calibration.autoScorePermitted).toBe(false);

    const decision = gateCaseScoring(createJudgeCase('x', true), calibration);

    expect(decision.trust).toBe('needs-review');
    expect(decision.automatedPass).toBeNull();
  });
});

describe('applyReliabilityGate (integration with compareEvalRuns)', () => {
  it('shows how gating changes the detected pass-rate delta vs. ungated', () => {
    // Baseline: every case failed. Candidate: the judge says every case now
    // passes. Under ungated scoring that is a +1.0 improvement. But the judge
    // is unreliable (it disagrees with human labels), so the gate should
    // withhold all of those "improvements" and route them to review.
    const baseline = createRun([
      createJudgeCase('a', false, { casePass: false }),
      createJudgeCase('b', false, { casePass: false }),
      createJudgeCase('c', false, { casePass: false }),
    ]);
    const candidate = createRun([
      createJudgeCase('a', true, { casePass: true }),
      createJudgeCase('b', true, { casePass: true }),
      createJudgeCase('c', true, { casePass: true }),
    ]);

    const comparison = compareEvalRuns({ baseline, candidate });
    expect(comparison.deltaPassRate).toBeCloseTo(1, 5);
    expect(comparison.improvedCases).toHaveLength(3);

    // Judge disagrees with humans on 3 of 10 labeled examples → 0.7 < 0.8,
    // so the gate closes and withholds the spurious "improvements".
    const calibration = calibrateJudgeReliability(
      [
        labeledExample('a', true, false),
        labeledExample('b', true, false),
        labeledExample('c', true, false),
        labeledExample('d', true, true),
        labeledExample('e', true, true),
        labeledExample('f', false, false),
        labeledExample('g', false, false),
        labeledExample('h', false, false),
        labeledExample('i', false, false),
        labeledExample('j', false, false),
      ],
      { threshold: 0.8 }
    );
    expect(calibration.matchRate).toBeCloseTo(0.7, 5);
    expect(calibration.autoScorePermitted).toBe(false);

    const gated = applyReliabilityGate(comparison, calibration);

    // Ungated delta said +1.0; gated view withholds every candidate score.
    expect(gated.ungatedDeltaPassRate).toBeCloseTo(1, 5);
    expect(gated.gatedDeltaPassRate).toBeNull();
    expect(gated.trustedImprovements).toHaveLength(0);
    expect(gated.needsReviewCaseIds).toEqual(['a', 'b', 'c']);
  });

  it('trusts improvements that survive a reliable gate', () => {
    const baseline = createRun([
      createJudgeCase('a', false, { casePass: false }),
      createJudgeCase('b', false, { casePass: false }),
    ]);
    const candidate = createRun([
      createJudgeCase('a', true, { casePass: true }),
      createJudgeCase('b', true, { casePass: true }),
    ]);

    const comparison = compareEvalRuns({ baseline, candidate });

    // Reliable judge: perfect agreement with human labels.
    const calibration = calibrateJudgeReliability(
      Array.from({ length: 10 }, (_, index) =>
        labeledExample(`x${index}`, true, true)
      )
    );
    expect(calibration.autoScorePermitted).toBe(true);

    const gated = applyReliabilityGate(comparison, calibration);

    expect(gated.trustedImprovements).toHaveLength(2);
    expect(gated.trustedCaseIds).toEqual(['a', 'b']);
    expect(gated.needsReviewCaseIds).toHaveLength(0);
    expect(gated.gatedCandidatePassRate).toBeCloseTo(1, 5);
    expect(gated.gatedDeltaPassRate).toBeCloseTo(1, 5);
  });
});
