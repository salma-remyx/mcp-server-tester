/**
 * Judge Panel Vote Aggregation Unit Tests
 *
 * Tests the majority-vote ensemble aggregation and its wiring into the eval
 * dataset schema (EvalCase.judgeVoteStrategy), imported from the existing
 * datasetTypes module.
 */

import { describe, it, expect } from 'vitest';
import {
  aggregateJudgePanel,
  DEFAULT_JUDGE_VOTE_STRATEGY,
} from './judgePanelVote.js';
import { validateEvalCase } from './datasetTypes.js';

describe('aggregateJudgePanel', () => {
  const panel = (...passes: boolean[]) => passes.map((pass) => ({ pass }));

  it('defaults to unanimous, preserving strict AND semantics', () => {
    expect(DEFAULT_JUDGE_VOTE_STRATEGY).toBe('unanimous');

    const allPass = aggregateJudgePanel(panel(true, true, true));
    expect(allPass.pass).toBe(true);
    expect(allPass.passCount).toBe(3);
    expect(allPass.details).toBe('3/3 judges passed (unanimous)');

    const oneFails = aggregateJudgePanel(panel(true, true, false));
    expect(oneFails.pass).toBe(false);
  });

  it('passes under majority when a strict majority agree', () => {
    const result = aggregateJudgePanel(panel(true, true, false), 'majority');
    expect(result.pass).toBe(true);
    expect(result.passCount).toBe(2);
    expect(result.total).toBe(3);
    expect(result.details).toBe('2/3 judges passed (majority)');
  });

  it('fails under majority when only a minority agree', () => {
    const result = aggregateJudgePanel(panel(true, false, false), 'majority');
    expect(result.pass).toBe(false);
  });

  it('fails an even split under majority (no tie-break)', () => {
    const result = aggregateJudgePanel(panel(true, false), 'majority');
    expect(result.pass).toBe(false);
    expect(result.passCount).toBe(1);
  });
});

describe('EvalCase.judgeVoteStrategy schema wiring', () => {
  it('accepts a majority vote strategy on an eval case', () => {
    const parsed = validateEvalCase({
      id: 'panel-majority',
      judgeVoteStrategy: 'majority',
      expect: { passesJudge: [{ rubric: 'correctness' }] },
    });
    expect(parsed.judgeVoteStrategy).toBe('majority');
  });

  it('rejects an unknown vote strategy', () => {
    expect(() =>
      validateEvalCase({
        id: 'panel-bad',
        judgeVoteStrategy: 'plurality',
      })
    ).toThrow();
  });

  it('leaves judgeVoteStrategy undefined when omitted', () => {
    const parsed = validateEvalCase({ id: 'panel-default' });
    expect(parsed.judgeVoteStrategy).toBeUndefined();
  });
});
