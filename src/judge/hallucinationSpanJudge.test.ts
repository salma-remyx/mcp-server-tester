/**
 * Hallucination Span Judge tests.
 *
 * The `validateJudge` / `getRegisteredJudge` blocks exercise the *existing*
 * judge path (assertions/validators/judge.ts + judgeRegistry.ts) wiring into
 * the new module, proving real integration rather than a self-only test.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerJudge,
  getRegisteredJudge,
  clearJudgeRegistry,
} from './judgeRegistry.js';
import { validateJudge } from '../assertions/validators/judge.js';
import {
  createHallucinationSpanJudge,
  registerHallucinationSpanJudge,
  localizeHallucinations,
  splitIntoSpans,
  tokenOverlapSupport,
  buildHallucinationReasoning,
  HALLUCINATION_SPAN_JUDGE,
} from './hallucinationSpanJudge.js';
import type {
  CustomJudgeResult,
  CustomJudgeExecutor,
} from './judgeRegistry.js';
import type { HallucinationSpan } from './hallucinationSpanJudge.js';

beforeEach(() => {
  clearJudgeRegistry();
});

describe('hallucination span judge — integration via existing judge path', () => {
  const candidate = 'Revenue was 5 million. The CEO won a Nobel Prize.';
  const reference = 'Revenue 5 million dollars.';

  it('localizes unsupported spans through validateJudge and fails above threshold', async () => {
    registerHallucinationSpanJudge();
    const result = await validateJudge(candidate, {
      judge: HALLUCINATION_SPAN_JUDGE,
      reference,
      threshold: 0.7,
    });

    expect(result.pass).toBe(false);
    expect(result.message).toContain('failed with score 0.50');
    expect(result.message).toContain('1/2 span(s) unsupported');
    expect(result.message).toContain('The CEO won a Nobel Prize.');
  });

  it('passes below threshold for the same localization', async () => {
    registerHallucinationSpanJudge();
    const result = await validateJudge(candidate, {
      judge: HALLUCINATION_SPAN_JUDGE,
      reference,
      threshold: 0.4,
    });

    expect(result.pass).toBe(true);
    expect(result.message).toContain('passed with score 0.50');
  });

  it('invokes the registered executor through getRegisteredJudge', async () => {
    registerHallucinationSpanJudge();
    const executor: CustomJudgeExecutor = getRegisteredJudge(
      HALLUCINATION_SPAN_JUDGE
    );
    const result: CustomJudgeResult = await executor(candidate, reference);

    expect(result.score).toBe(0.5);
    expect(result.reasoning).toContain('1/2 span(s) unsupported');
    expect(result.reasoning).toContain('The CEO won a Nobel Prize.');
  });

  it('returns a fully-grounded score when every span is supported', async () => {
    registerHallucinationSpanJudge();
    const result = await validateJudge(
      'Revenue was 5 million. Based in California.',
      {
        judge: HALLUCINATION_SPAN_JUDGE,
        reference: 'Revenue 5 million dollars. HQ in California.',
        threshold: 0.7,
      }
    );

    expect(result.pass).toBe(true);
    expect(result.message).toContain('passed with score 1.00');
  });

  it('does not penalize when no grounding context is provided', async () => {
    registerJudge('h', createHallucinationSpanJudge());
    const result = await getRegisteredJudge('h')('Some claim here.');

    expect(result.score).toBe(1);
    expect(result.reasoning).toContain('requires grounding context');
  });

  it('scores an empty candidate as fully grounded', async () => {
    registerJudge('h', createHallucinationSpanJudge());
    const result = await getRegisteredJudge('h')('', 'some context');

    expect(result.score).toBe(1);
    expect(result.reasoning).toContain('Empty candidate');
  });
});

describe('span-support predicate seam (restores the paper learned estimator)', () => {
  it('uses a custom predicate that marks every span unsupported', async () => {
    registerJudge(
      'always-bad',
      createHallucinationSpanJudge({ supportPredicate: () => false })
    );
    const result = await getRegisteredJudge('always-bad')(
      'One sentence. Two sentence.',
      'context'
    );

    expect(result.score).toBe(0);
    expect(result.reasoning).toContain('2/2 span(s) unsupported');
  });

  it('uses a custom predicate that marks every span grounded', async () => {
    registerJudge(
      'always-good',
      createHallucinationSpanJudge({ supportPredicate: () => true })
    );
    const result = await getRegisteredJudge('always-good')('A. B. C.', 'ctx');

    expect(result.score).toBe(1);
    expect(result.reasoning).toContain('All 3 span(s) grounded');
  });
});

describe('localizeHallucinations', () => {
  it('localizes the unsupported span and computes the grounded fraction', async () => {
    const loc = await localizeHallucinations(
      'Revenue was 5 million. The CEO won a Nobel Prize.',
      'Revenue 5 million dollars.'
    );

    expect(loc.totalSpans).toBe(2);
    expect(loc.hallucinatedSpans).toHaveLength(1);
    const unsupported = loc.hallucinatedSpans[0]!;
    expect(unsupported.text).toBe('The CEO won a Nobel Prize.');
    expect(loc.groundedFraction).toBe(0.5);
  });

  it('returns no hallucinations when context is empty', async () => {
    const loc = await localizeHallucinations('A claim. Another claim.', '');

    expect(loc.totalSpans).toBe(2);
    expect(loc.hallucinatedSpans).toHaveLength(0);
    expect(loc.groundedFraction).toBe(1);
  });

  it('handles an empty text', async () => {
    const loc = await localizeHallucinations('', 'context');
    expect(loc.totalSpans).toBe(0);
    expect(loc.groundedFraction).toBe(1);
  });
});

describe('splitIntoSpans', () => {
  it('splits on sentence terminators and preserves offsets', () => {
    const spans = splitIntoSpans('Hello world. Foo bar!');
    const first = spans[0]!;
    const second = spans[1]!;

    expect(spans).toHaveLength(2);
    expect(first.text).toBe('Hello world.');
    expect(first.start).toBe(0);
    expect(first.end).toBe(first.start + first.text.length);
    expect(second.text).toBe('Foo bar!');
    expect(second.start).toBe(13);
    expect(second.end).toBe(second.start + second.text.length);
  });

  it('keeps a terminator-less text as a single span', () => {
    const spans = splitIntoSpans('just one span');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text).toBe('just one span');
  });
});

describe('tokenOverlapSupport', () => {
  it('marks a span grounded when its content tokens appear in context', () => {
    expect(
      tokenOverlapSupport(
        'revenue grew strongly',
        'revenue grew last year',
        0.5
      )
    ).toBe(true);
  });

  it('marks a span unsupported when its content tokens are absent', () => {
    expect(
      tokenOverlapSupport('quantum entanglement', 'revenue grew', 0.5)
    ).toBe(false);
  });

  it('treats a stopword-only span as grounded (nothing to ground)', () => {
    expect(tokenOverlapSupport('the of and', 'unrelated words', 0.5)).toBe(
      true
    );
  });
});

describe('buildHallucinationReasoning', () => {
  it('enumerates unsupported spans with offsets', () => {
    const reasoning = buildHallucinationReasoning({
      hallucinatedSpans: [{ text: 'x', start: 0, end: 1 }],
      totalSpans: 2,
      groundedFraction: 0.5,
    });

    expect(reasoning).toBe(
      '1/2 span(s) unsupported by reference context: (1) "x" [0:1].'
    );
  });

  it('reports all spans grounded when nothing is unsupported', () => {
    const reasoning = buildHallucinationReasoning({
      hallucinatedSpans: [],
      totalSpans: 3,
      groundedFraction: 1,
    });

    expect(reasoning).toBe(
      'All 3 span(s) grounded against the reference context.'
    );
  });

  it('truncates the listing and reports the remainder count', () => {
    const spans: HallucinationSpan[] = Array.from(
      { length: 10 },
      (_, index) => ({
        text: `s${index}`,
        start: index,
        end: index + 1,
      })
    );
    const reasoning = buildHallucinationReasoning(
      { hallucinatedSpans: spans, totalSpans: 10, groundedFraction: 0 },
      3
    );

    expect(reasoning).toContain('10/10 span(s) unsupported');
    expect(reasoning).toContain('+7 more');
  });
});
