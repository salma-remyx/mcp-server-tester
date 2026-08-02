import { describe, it, expect } from 'vitest';
import {
  resolveDecision,
  DEFAULT_DECISION_PROTOCOL,
} from './decisionProtocols.js';
import type { JudgeVote } from './decisionProtocols.js';

function votes(passes: boolean[]): JudgeVote[] {
  return passes.map((pass) => ({ pass }));
}

describe('resolveDecision — default protocol', () => {
  it('defaults to unanimous', () => {
    expect(DEFAULT_DECISION_PROTOCOL).toBe('unanimous');
  });

  it('unanimous passes only when every judge passes', () => {
    expect(resolveDecision(votes([true, true, true])).pass).toBe(true);
    expect(resolveDecision(votes([true, true, false])).pass).toBe(false);
  });

  it('unanimous requires all even for a single judge', () => {
    expect(resolveDecision(votes([true])).pass).toBe(true);
    expect(resolveDecision(votes([false])).pass).toBe(false);
  });
});

describe('resolveDecision — consensus family', () => {
  it('supermajority requires at least 2/3 (ceil)', () => {
    // 3 judges: ceil(3 * 2/3) = 2 required
    expect(
      resolveDecision(votes([true, true, false]), { protocol: 'supermajority' })
        .pass
    ).toBe(true);
    expect(
      resolveDecision(votes([true, false, false]), {
        protocol: 'supermajority',
      }).pass
    ).toBe(false);
  });

  it('supermajority on 2 judges requires both', () => {
    // ceil(2 * 2/3) = 2
    expect(
      resolveDecision(votes([true, true]), { protocol: 'supermajority' }).pass
    ).toBe(true);
    expect(
      resolveDecision(votes([true, false]), { protocol: 'supermajority' }).pass
    ).toBe(false);
  });
});

describe('resolveDecision — voting family', () => {
  it('majority requires a strict majority', () => {
    // 3 judges: floor(3/2) + 1 = 2 required
    expect(
      resolveDecision(votes([true, true, false]), { protocol: 'majority' }).pass
    ).toBe(true);
    expect(
      resolveDecision(votes([true, false, false]), { protocol: 'majority' })
        .pass
    ).toBe(false);
  });

  it('majority on 2 judges requires both (no tie winner)', () => {
    // floor(2/2) + 1 = 2 — a 1/1 split must fail
    expect(
      resolveDecision(votes([true, false]), { protocol: 'majority' }).pass
    ).toBe(false);
    expect(
      resolveDecision(votes([true, true]), { protocol: 'majority' }).pass
    ).toBe(true);
  });

  it('plurality passes when more pass than fail', () => {
    expect(
      resolveDecision(votes([true, true, false]), { protocol: 'plurality' })
        .pass
    ).toBe(true);
    // tie => fail
    expect(
      resolveDecision(votes([true, false]), { protocol: 'plurality' }).pass
    ).toBe(false);
  });
});

describe('resolveDecision — custom overrides', () => {
  it('minAgree overrides any fraction', () => {
    // 4 judges, 2 pass. minAgree: 2 => pass.
    const r = resolveDecision(votes([true, true, false, false]), {
      protocol: 'unanimous',
      minAgree: 2,
    });
    expect(r.pass).toBe(true);
    expect(r.required).toBe(2);
  });

  it('agreementThreshold is ceiled to a whole judge', () => {
    // 3 judges, threshold 0.5 => ceil(1.5) = 2 required
    expect(
      resolveDecision(votes([true, false, false]), {
        agreementThreshold: 0.5,
      }).pass
    ).toBe(false);
    expect(
      resolveDecision(votes([true, true, false]), {
        agreementThreshold: 0.5,
      }).pass
    ).toBe(true);
  });

  it('clamps out-of-range thresholds', () => {
    expect(
      resolveDecision(votes([true, true]), { agreementThreshold: 5 }).pass
    ).toBe(true);
  });
});

describe('resolveDecision — summary + edge cases', () => {
  it('reports counts, agreement, protocol, and a human summary', () => {
    const r = resolveDecision(votes([true, true, false]), {
      protocol: 'majority',
    });
    expect(r.passCount).toBe(2);
    expect(r.failCount).toBe(1);
    expect(r.total).toBe(3);
    expect(r.protocol).toBe('majority');
    expect(r.agreement).toBeCloseTo(2 / 3, 5);
    expect(r.summary).toContain('2/3');
    expect(r.summary).toContain('majority');
  });

  it('returns a failing verdict for no votes', () => {
    const r = resolveDecision([]);
    expect(r.pass).toBe(false);
    expect(r.total).toBe(0);
    expect(r.summary).toContain('no judges voted');
  });
});
