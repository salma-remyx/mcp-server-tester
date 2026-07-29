import { describe, it, expect } from 'vitest';
import {
  fleissKappa,
  computeJudgeReliability,
  auditJudgeBias,
} from './judgeBias.js';
import type { EvalCaseResult } from '../types/reporter.js';
import type { EvalExpectationResult } from '../types/index.js';

function judge(
  provider: string,
  pass: boolean,
  model?: string
): EvalExpectationResult {
  return { pass, judgeProvider: provider, judgeModel: model ?? provider };
}

function caseResult(
  id: string,
  candidateProvider: string,
  results: EvalExpectationResult[]
): EvalCaseResult {
  const allPassed = results.every((r) => r.pass);
  return {
    id,
    datasetName: 'judge-bias-test',
    toolName: 'mcp_host',
    source: 'eval',
    pass: allPassed,
    durationMs: 0,
    expectations: { judge: { pass: allPassed, judgeResults: results } },
    request: { mcpHostConfig: { provider: candidateProvider } },
  };
}

describe('fleissKappa', () => {
  it('returns null for an empty or all-zero matrix', () => {
    expect(fleissKappa([])).toBeNull();
    expect(fleissKappa([[0, 0]])).toBeNull();
  });

  it('returns 1 for perfect agreement', () => {
    expect(
      fleissKappa([
        [2, 0],
        [2, 0],
      ])
    ).toBe(1);
  });

  it('returns -1 when every panel splits the same way (less than chance)', () => {
    // Each item split 1/1: observed agreement 0, chance agreement 0.5.
    expect(
      fleissKappa([
        [1, 1],
        [1, 1],
      ])
    ).toBeCloseTo(-1, 5);
  });

  it('matches the hand-computed value for a mixed panel', () => {
    // Item 1 split 1/1 (P=0), item 2 unanimous 2/0 (P=1): Pbar=0.5, Pe=0.625.
    expect(
      fleissKappa([
        [1, 1],
        [2, 0],
      ])
    ).toBeCloseTo(-1 / 3, 2);
  });
});

describe('computeJudgeReliability', () => {
  it('returns null for fewer than two judges', () => {
    expect(computeJudgeReliability([judge('anthropic', true)])).toBeNull();
    expect(computeJudgeReliability([])).toBeNull();
  });

  it('classifies agreement and flags same-provider leniency', () => {
    const results = [
      judge('anthropic', true),
      judge('anthropic', true),
      judge('openai', false),
      judge('openai', false),
    ];
    const reliability = computeJudgeReliability(results, 'anthropic')!;

    expect(reliability.judgeCount).toBe(4);
    expect(reliability.passCount).toBe(2);
    expect(reliability.agreement).toBe(0.5);
    expect(reliability.category).toBe('split');
    expect(reliability.sameProvider!.biasFlag).toBe(true);
    expect(reliability.sameProvider!.gap).toBe(1);
  });

  it('reports unanimous agreement', () => {
    const reliability = computeJudgeReliability(
      [judge('anthropic', true), judge('openai', true)],
      'anthropic'
    )!;
    expect(reliability.category).toBe('unanimous');
    expect(reliability.agreement).toBe(1);
  });

  it('drops the same-provider signal without a candidate provider', () => {
    const reliability = computeJudgeReliability([
      judge('anthropic', true),
      judge('openai', false),
    ])!;
    expect(reliability.sameProvider).toBeNull();
  });

  it('drops the same-provider signal when all judges share the provider', () => {
    const reliability = computeJudgeReliability(
      [judge('anthropic', true), judge('anthropic', false)],
      'anthropic'
    )!;
    expect(reliability.sameProvider).toBeNull();
  });
});

describe('auditJudgeBias', () => {
  it('returns null when no case contributed multi-judge votes', () => {
    expect(auditJudgeBias([])).toBeNull();
    expect(
      auditJudgeBias([
        {
          ...caseResult('c1', 'anthropic', [judge('anthropic', true)]),
          expectations: { judge: { pass: true } },
        },
      ])
    ).toBeNull();
  });

  it('separates same-provider association from general leniency', () => {
    // One fixed judge panel rates two candidate hosts from different providers,
    // mirroring the paper's setup. Same-provider judges are systematically more
    // lenient, so the adjusted gap stays large and the permutation test can run.
    const cases = [
      caseResult('c1', 'anthropic', [
        judge('anthropic', true),
        judge('openai', false),
        judge('google', true),
      ]),
      caseResult('c2', 'openai', [
        judge('anthropic', false),
        judge('openai', true),
        judge('google', false),
      ]),
    ];

    const audit = auditJudgeBias(cases, { iterations: 499 })!;

    expect(audit.cases).toBe(2);
    expect(audit.totalVotes).toBe(6);
    expect(audit.fleissKappa).toBeCloseTo(-1 / 3, 2);
    expect(audit.sameProviderGap).toBeCloseTo(0.75, 5);
    expect(audit.sameProviderGapAdjusted).toBeCloseTo(0.75, 5);
    // anthropic and openai each judged both a same- and a cross-provider case.
    expect(audit.informativeJudges).toBe(2);
    expect(audit.permutationPValue).toBeGreaterThan(0);
    expect(audit.permutationPValue).toBeLessThanOrEqual(1);
    expect(audit.permutationIterations).toBe(499);
  });

  it('reports a null permutation p-value when no judge spans providers', () => {
    // Every judge only ever rates its own provider's candidate.
    const cases = [
      caseResult('c1', 'anthropic', [
        judge('anthropic', true),
        judge('anthropic', false),
      ]),
    ];
    const audit = auditJudgeBias(cases)!;

    expect(audit.fleissKappa).toBeCloseTo(-1, 5);
    expect(audit.sameProviderGap).toBeNull();
    expect(audit.informativeJudges).toBe(0);
    expect(audit.permutationPValue).toBeNull();
  });
});
