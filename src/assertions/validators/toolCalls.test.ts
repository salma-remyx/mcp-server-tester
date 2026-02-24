import { describe, it, expect } from 'vitest';
import { validateToolCalls, validateToolCallCount } from './toolCalls.js';
import type { LLMHostSimulationResult } from '../../evals/llmHost/llmHostTypes.js';

function makeResult(
  toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>
): LLMHostSimulationResult {
  return {
    success: true,
    toolCalls: toolCalls.map((c) => ({ ...c, arguments: c.arguments ?? {} })),
  };
}

describe('validateToolCalls', () => {
  it('passes when required tool was called', () => {
    const result = makeResult([
      { name: 'search', arguments: { query: 'hello' } },
    ]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search', required: true }],
    });
    expect(v.pass).toBe(true);
  });

  it('fails when required tool was not called', () => {
    const result = makeResult([{ name: 'other' }]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search', required: true }],
    });
    expect(v.pass).toBe(false);
    expect(v.message).toContain('search');
  });

  it('passes optional tool even when missing', () => {
    const result = makeResult([]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search', required: false }],
    });
    expect(v.pass).toBe(true);
  });

  it('validates partial argument match', () => {
    const result = makeResult([
      { name: 'search', arguments: { query: 'hello', limit: 10 } },
    ]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search', arguments: { query: 'hello' } }],
    });
    expect(v.pass).toBe(true);
  });

  it('fails when arguments do not match', () => {
    const result = makeResult([
      { name: 'search', arguments: { query: 'wrong' } },
    ]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search', arguments: { query: 'hello' } }],
    });
    expect(v.pass).toBe(false);
  });

  it('enforces strict order when order is strict', () => {
    const result = makeResult([{ name: 'search' }, { name: 'fetch' }]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'fetch' }, { name: 'search' }],
      order: 'strict',
    });
    expect(v.pass).toBe(false);
  });

  it('passes strict order when sequence matches', () => {
    const result = makeResult([{ name: 'search' }, { name: 'fetch' }]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search' }, { name: 'fetch' }],
      order: 'strict',
    });
    expect(v.pass).toBe(true);
  });

  it('fails when exclusive and unexpected tool was called', () => {
    const result = makeResult([{ name: 'search' }, { name: 'unexpected' }]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search' }],
      exclusive: true,
    });
    expect(v.pass).toBe(false);
    expect(v.message).toContain('unexpected');
  });

  it('returns error when response is not an LLMHostSimulationResult', () => {
    const v = validateToolCalls('not a simulation result', {
      calls: [{ name: 'search' }],
    });
    expect(v.pass).toBe(false);
    expect(v.message).toContain('llm_host');
  });
});

describe('validateToolCallCount', () => {
  it('passes exact count', () => {
    const result = makeResult([{ name: 'a' }, { name: 'b' }]);
    expect(validateToolCallCount(result, { exact: 2 }).pass).toBe(true);
  });

  it('fails wrong exact count', () => {
    const result = makeResult([{ name: 'a' }]);
    const v = validateToolCallCount(result, { exact: 2 });
    expect(v.pass).toBe(false);
    expect(v.message).toContain('1');
  });

  it('passes min/max range', () => {
    const result = makeResult([{ name: 'a' }, { name: 'b' }]);
    expect(validateToolCallCount(result, { min: 1, max: 3 }).pass).toBe(true);
  });

  it('fails when below min', () => {
    const result = makeResult([]);
    expect(validateToolCallCount(result, { min: 1 }).pass).toBe(false);
  });

  it('fails when above max', () => {
    const result = makeResult([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    expect(validateToolCallCount(result, { max: 2 }).pass).toBe(false);
  });

  it('returns error when response is not an LLMHostSimulationResult', () => {
    const v = validateToolCallCount('not a simulation result', { exact: 1 });
    expect(v.pass).toBe(false);
    expect(v.message).toContain('llm_host');
  });
});
