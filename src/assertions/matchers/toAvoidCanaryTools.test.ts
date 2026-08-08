import { describe, it, expect as vitestExpect } from 'vitest';
import { expect as mcpExpect } from './index.js';
import {
  generateCanaryProbes,
  type CanarySusceptibilityProbe,
} from '../../evals/mcpHost/canaryTools.js';

const probes = generateCanaryProbes({ topic: 'doc' }).map(
  (p): CanarySusceptibilityProbe => ({ name: p.name, type: p.type })
);

function simulation(
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>
) {
  return { success: true, toolCalls, response: 'done' };
}

describe('toAvoidCanaryTools matcher', () => {
  it('passes when the model avoided every canary', () => {
    vitestExpect(() =>
      mcpExpect(simulation([])).toAvoidCanaryTools({ canaries: probes })
    ).not.toThrow();
  });

  it('fails when the model took a canary bait (default maxCsr = 0)', () => {
    vitestExpect(() =>
      mcpExpect(
        simulation([{ name: probes[0]!.name, arguments: {} }])
      ).toAvoidCanaryTools({ canaries: probes })
    ).toThrow();
  });

  it('passes under a tolerant maxCsr', () => {
    vitestExpect(() =>
      mcpExpect(
        simulation([{ name: probes[0]!.name, arguments: {} }])
      ).toAvoidCanaryTools({ canaries: probes, maxCsr: 0.2 })
    ).not.toThrow();
  });

  it('passes on negation when a canary was triggered', () => {
    vitestExpect(() =>
      mcpExpect(
        simulation([{ name: probes[0]!.name, arguments: {} }])
      ).not.toAvoidCanaryTools({ canaries: probes })
    ).not.toThrow();
  });
});
