import { describe, it, expect } from 'vitest';
import {
  estimateJudgeCallCostUsd,
  estimateJudgeQuality,
  chooseRoRAction,
  planJudgeBudget,
} from './budgetAllocator.js';

describe('estimateJudgeCallCostUsd', () => {
  it('uses model-prefix overrides', () => {
    expect(estimateJudgeCallCostUsd({ model: 'claude-opus-4-20250514' })).toBe(
      0.012
    );
    expect(
      estimateJudgeCallCostUsd({ model: 'claude-sonnet-4-20250514' })
    ).toBe(0.003);
    expect(estimateJudgeCallCostUsd({ model: 'claude-haiku-3' })).toBe(0.0006);
    expect(
      estimateJudgeCallCostUsd({ provider: 'openai', model: 'gpt-4o' })
    ).toBe(0.005);
    expect(
      estimateJudgeCallCostUsd({
        provider: 'google',
        model: 'gemini-1.5-flash',
      })
    ).toBe(0.0003);
  });

  it('falls back to provider default when model is unknown', () => {
    expect(estimateJudgeCallCostUsd({ provider: 'openai' })).toBe(0.005);
    expect(estimateJudgeCallCostUsd({})).toBe(0.003); // anthropic default
  });

  it('falls back to a sane default for an unknown provider', () => {
    expect(
      estimateJudgeCallCostUsd({
        provider: 'mistral' as unknown as 'anthropic',
      })
    ).toBe(0.005);
  });
});

describe('estimateJudgeQuality', () => {
  it('uses model-prefix quality priors', () => {
    expect(estimateJudgeQuality({ model: 'claude-opus-4-20250514' })).toBe(0.9);
    expect(estimateJudgeQuality({ model: 'claude-haiku-3' })).toBe(0.62);
    expect(estimateJudgeQuality({ provider: 'openai', model: 'gpt-4o' })).toBe(
      0.82
    );
  });

  it('falls back to provider default', () => {
    expect(estimateJudgeQuality({ provider: 'anthropic' })).toBe(0.8);
    expect(estimateJudgeQuality({})).toBe(0.8);
  });
});

describe('chooseRoRAction', () => {
  it('resamples the committed judge when no alternative dominates', () => {
    const decision = chooseRoRAction({
      committedCostUsd: 0.003,
      committedQuality: 0.8,
      committedReps: 1,
      alternatives: [],
      remainingBudgetUsd: 1.0,
    });
    // SE reduction of sd=0.4 at 1 rep: 0.4 * (1 - 1/sqrt(2)) over cost 0.003
    expect(decision.action).toBe('resample');
    expect(decision.marginalCorrectnessPerUsd).toBeCloseTo(
      (0.4 * (1 - 1 / Math.sqrt(2))) / 0.003,
      5
    );
  });

  it('reroutes to a stronger judge once resampling saturates', () => {
    const decision = chooseRoRAction({
      committedCostUsd: 0.003,
      committedQuality: 0.8,
      committedReps: 20, // saturated -> tiny marginal SE reduction
      alternatives: [
        {
          judge: { model: 'claude-opus-4-20250514' },
          costUsd: 0.012,
          quality: 0.9,
        },
      ],
      remainingBudgetUsd: 1.0,
    });
    expect(decision.action).toBe('reroute');
    expect(decision.rerouteJudge?.model).toBe('claude-opus-4-20250514');
    // headroom 0.1 gated by committed quality 0.8, over cost 0.012
    expect(decision.marginalCorrectnessPerUsd).toBeCloseTo(
      (0.1 * 0.8) / 0.012,
      5
    );
  });

  it('stops when the remaining budget cannot afford any action', () => {
    const decision = chooseRoRAction({
      committedCostUsd: 0.003,
      committedQuality: 0.8,
      committedReps: 1,
      alternatives: [
        { judge: { model: 'opus' }, costUsd: 0.012, quality: 0.9 },
      ],
      remainingBudgetUsd: 0.001, // < every cost
    });
    expect(decision.action).toBe('stop');
    expect(decision.marginalCorrectnessPerUsd).toBe(0);
  });

  it('falls back to resample when the only alternative is unaffordable', () => {
    const decision = chooseRoRAction({
      committedCostUsd: 0.003,
      committedQuality: 0.8,
      committedReps: 1,
      alternatives: [
        { judge: { model: 'opus' }, costUsd: 0.012, quality: 0.9 },
      ],
      remainingBudgetUsd: 0.005, // afford resample, not the alternative
    });
    expect(decision.action).toBe('resample');
  });

  it('verifier gating suppresses rerouting when the committed judge is unreliable', () => {
    // Huge headroom (0.8) but a 0.1 quality gate crushes reroute value to
    // ~6.67 correctness/USD, well below resampling (~29.3 correctness/USD).
    const decision = chooseRoRAction({
      committedCostUsd: 0.003,
      committedQuality: 0.1,
      committedReps: 1,
      alternatives: [
        { judge: { model: 'opus' }, costUsd: 0.012, quality: 0.9 },
      ],
      remainingBudgetUsd: 1.0,
    });
    expect(decision.action).toBe('resample');
  });
});

describe('planJudgeBudget', () => {
  it('returns an empty plan for no judges', () => {
    const plan = planJudgeBudget({ judges: [], defaultReps: 1 });
    expect(plan.reps).toEqual([]);
    expect(plan.estimatedSpendUsd).toBe(0);
    expect(plan.reallocated).toBe(false);
  });

  it('preserves each judge own reps when no budget is set (default behavior)', () => {
    const plan = planJudgeBudget({
      judges: [{ reps: 3 }, { reps: 5 }],
      defaultReps: 1,
    });
    expect(plan.reps).toEqual([3, 5]);
    expect(plan.reallocated).toBe(false);
  });

  it('applies defaultReps when a judge omits reps and no budget is set', () => {
    const plan = planJudgeBudget({
      judges: [{ model: 'claude-sonnet-4-20250514' }, {}],
      defaultReps: 2,
    });
    expect(plan.reps).toEqual([2, 2]);
    expect(plan.estimatedSpendUsd).toBeCloseTo(0.012, 5); // 2*0.003 + 2*0.003
  });

  it('honors requested reps when the budget is abundant', () => {
    const plan = planJudgeBudget({
      judges: [{ model: 'claude-haiku-3', reps: 3 }],
      defaultReps: 1,
      budgetUsd: 1.0,
    });
    expect(plan.reps).toEqual([3]);
    expect(plan.reallocated).toBe(false);
    expect(plan.estimatedSpendUsd).toBeCloseTo(3 * 0.0006, 6);
  });

  it('caps reps under a tight budget but never drops a judge below one rep', () => {
    const plan = planJudgeBudget({
      judges: [{ model: 'claude-opus-4', reps: 10 }],
      defaultReps: 1,
      budgetUsd: 0.02, // baseline 1 opus rep costs 0.012; a 2nd would not fit
    });
    expect(plan.reps).toEqual([1]);
    expect(plan.reps.every((r) => r >= 1)).toBe(true);
    expect(plan.reallocated).toBe(true);
  });

  it('allocates extra reps by marginal correctness per USD across judges', () => {
    const plan = planJudgeBudget({
      judges: [
        { model: 'claude-haiku-3', reps: 5 },
        { model: 'claude-opus-4', reps: 2 },
      ],
      defaultReps: 1,
      budgetUsd: 0.015,
    });
    // Cheap haiku reps have far higher correctness/USD, so they absorb the
    // budget while the expensive opus judge is held at its baseline rep.
    expect(plan.reps[1]).toBe(1); // opus held at baseline 1 (< its request of 2)
    expect(plan.reps[0]).toBeGreaterThanOrEqual(4); // cheap haiku gets the bulk
    expect(plan.reps[0]).toBeGreaterThan(plan.reps[1]!); // value-based ordering
    expect(plan.reps.every((r) => r >= 1)).toBe(true);
    expect(plan.reallocated).toBe(true); // opus held below its request of 2
    expect(plan.estimatedSpendUsd).toBeLessThanOrEqual(0.015);
  });
});
