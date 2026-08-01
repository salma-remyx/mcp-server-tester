import { describe, it, expect } from 'vitest';
import {
  aggregateMultiJudgeVerdicts,
  computeEloRankings,
  scoresFromJudgeResults,
  rankCandidatesByJudgeResults,
} from './judgeRanking.js';
import type { EvalExpectationResult } from '../types/index.js';

function judgeResult(pass: boolean, score?: number): EvalExpectationResult {
  return score === undefined ? { pass } : { pass, score };
}

describe('aggregateMultiJudgeVerdicts', () => {
  it('defaults to unanimity (all must pass) and matches legacy summary', () => {
    const allPass = aggregateMultiJudgeVerdicts([
      judgeResult(true),
      judgeResult(true),
    ]);
    expect(allPass.pass).toBe(true);
    expect(allPass.passCount).toBe(2);
    expect(allPass.total).toBe(2);
    expect(allPass.passFraction).toBe(1);
    // Default path keeps the bare legacy summary so existing reports are unchanged.
    expect(allPass.details).toBe('2/2 judges passed');

    const oneFails = aggregateMultiJudgeVerdicts([
      judgeResult(true),
      judgeResult(false),
    ]);
    expect(oneFails.pass).toBe(false);
    expect(oneFails.details).toBe('1/2 judges passed');
  });

  it('passes under majority when more than half agree', () => {
    const result = aggregateMultiJudgeVerdicts(
      [judgeResult(true), judgeResult(true), judgeResult(false)],
      { mode: 'majority' }
    );
    expect(result.passCount).toBe(2);
    expect(result.total).toBe(3);
    expect(result.pass).toBe(true);
    expect(result.details).toContain('2/3');
    expect(result.details).toContain('threshold');
  });

  it('fails under majority when at most half agree (strict majority)', () => {
    // 1 of 2 is exactly half, not a strict majority.
    const result = aggregateMultiJudgeVerdicts(
      [judgeResult(true), judgeResult(false)],
      { mode: 'majority' }
    );
    expect(result.pass).toBe(false);
  });

  it('honours an arbitrary minPassFraction', () => {
    // 1 of 2 passes when the threshold is a half.
    const relaxed = aggregateMultiJudgeVerdicts(
      [judgeResult(true), judgeResult(false)],
      { minPassFraction: 0.5 }
    );
    expect(relaxed.pass).toBe(true);

    // 0.6 of 5 = 3; only 2 pass -> fails.
    const strict = aggregateMultiJudgeVerdicts(
      [
        judgeResult(true),
        judgeResult(true),
        judgeResult(false),
        judgeResult(false),
        judgeResult(false),
      ],
      { minPassFraction: 0.6 }
    );
    expect(strict.pass).toBe(false);
  });

  it('treats an empty judge set as not passing', () => {
    const result = aggregateMultiJudgeVerdicts([]);
    expect(result.pass).toBe(false);
    expect(result.passFraction).toBe(0);
    expect(result.details).toBe('0/0 judges passed');
  });
});

describe('scoresFromJudgeResults', () => {
  it('keeps numeric scores and drops the rest', () => {
    const scores = scoresFromJudgeResults([
      judgeResult(true, 0.9),
      judgeResult(false), // no score
      judgeResult(true, 0.4),
    ]);
    expect(scores).toEqual([0.9, 0.4]);
  });
});

describe('computeEloRankings', () => {
  it('ranks the higher-scoring candidate first with the expected Elo delta', () => {
    const board = computeEloRankings([
      { id: 'a', scores: [0.9] },
      { id: 'b', scores: [0.1] },
    ]);
    expect(board).toHaveLength(2);
    expect(board[0]!.id).toBe('a');
    expect(board[1]!.id).toBe('b');
    // K=32, even match -> winner +16, loser -16.
    expect(board[0]!.rating).toBeCloseTo(1016, 6);
    expect(board[1]!.rating).toBeCloseTo(984, 6);
    expect(board[0]!.wins).toBe(1);
    expect(board[1]!.losses).toBe(1);
    expect(board[0]!.rank).toBe(1);
    expect(board[1]!.rank).toBe(2);
  });

  it('counts a near-equal pairing as a tie with no rating change', () => {
    const board = computeEloRankings([
      { id: 'a', scores: [0.5] },
      { id: 'b', scores: [0.52] },
    ]);
    expect(board[0]!.ties).toBe(1);
    expect(board[1]!.ties).toBe(1);
    expect(board[0]!.rating).toBeCloseTo(1000, 6);
    expect(board[1]!.rating).toBeCloseTo(1000, 6);
    // Tied ratings share rank 1.
    expect(board[0]!.rank).toBe(1);
    expect(board[1]!.rank).toBe(1);
  });

  it('orders three candidates best-first and assigns distinct ranks', () => {
    const board = computeEloRankings([
      { id: 'low', scores: [0.2, 0.2] },
      { id: 'high', scores: [0.9, 0.9] },
      { id: 'mid', scores: [0.6, 0.6] },
    ]);
    expect(board.map((e) => e.id)).toEqual(['high', 'mid', 'low']);
    expect(board[0]!.rank).toBe(1);
    expect(board[1]!.rank).toBe(2);
    expect(board[2]!.rank).toBe(3);
    expect(board[0]!.wins).toBe(2);
    expect(board[2]!.losses).toBe(2);
  });

  it('treats a candidate with no scores as score 0 (ranked last)', () => {
    const board = computeEloRankings([
      { id: 'scored', scores: [0.8] },
      { id: 'empty', scores: [] },
    ]);
    expect(board[0]!.id).toBe('scored');
    expect(board[1]!.id).toBe('empty');
  });

  it('respects custom initialRating and kFactor', () => {
    const board = computeEloRankings(
      [
        { id: 'a', scores: [0.9] },
        { id: 'b', scores: [0.1] },
      ],
      { initialRating: 1500, kFactor: 10 }
    );
    expect(board[0]!.rating).toBeCloseTo(1505, 6);
    expect(board[1]!.rating).toBeCloseTo(1495, 6);
  });

  it('handles a single candidate', () => {
    const board = computeEloRankings([{ id: 'solo', scores: [0.7] }]);
    expect(board).toHaveLength(1);
    expect(board[0]!.id).toBe('solo');
    expect(board[0]!.rank).toBe(1);
    expect(board[0]!.wins).toBe(0);
  });
});

describe('rankCandidatesByJudgeResults', () => {
  it('ranks candidates from real EvalExpectationResult[] judge outputs', () => {
    const board = rankCandidatesByJudgeResults([
      {
        id: 'variant-b',
        judgeResults: [judgeResult(true, 0.55), judgeResult(true, 0.6)],
      },
      {
        id: 'variant-a',
        judgeResults: [judgeResult(true, 0.95), judgeResult(true, 0.9)],
      },
    ]);
    expect(board[0]!.id).toBe('variant-a');
    expect(board[1]!.id).toBe('variant-b');
  });
});
