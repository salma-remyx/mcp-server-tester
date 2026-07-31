import { describe, it, expect } from 'vitest';
import { validateArgumentFormat } from './argumentFormat.js';
import type { ArgumentFormatExpectation } from './argumentFormat.js';
import type { MCPHostSimulationResult } from '../../evals/mcpHost/mcpHostTypes.js';

function makeResult(
  toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>
): MCPHostSimulationResult {
  return {
    success: true,
    toolCalls: toolCalls.map((c) => ({ ...c, arguments: c.arguments ?? {} })),
  };
}

describe('validateArgumentFormat — format kinds', () => {
  it('passes when a quoted (string) value is emitted', () => {
    const result = makeResult([
      { name: 'search', arguments: { query: 'hello' } },
    ]);
    const v = validateArgumentFormat(result, {
      calls: [{ name: 'search', arguments: { query: { kind: 'quoted' } } }],
    });
    expect(v.pass).toBe(true);
  });

  it('fails quoted when the model emitted a bare number', () => {
    const result = makeResult([{ name: 'search', arguments: { id: 12345 } }]);
    const v = validateArgumentFormat(result, {
      calls: [{ name: 'search', arguments: { id: { kind: 'quoted' } } }],
    });
    expect(v.pass).toBe(false);
    expect(v.message).toContain('string');
    expect(v.message).toContain('id');
  });

  it('validates integer values (number and numeric string)', () => {
    const ok = makeResult([{ name: 't', arguments: { n: 7 } }]);
    const okStr = makeResult([{ name: 't', arguments: { n: '42' } }]);
    const bad = makeResult([{ name: 't', arguments: { n: 1.5 } }]);
    const rule: ArgumentFormatExpectation = {
      calls: [{ name: 't', arguments: { n: { kind: 'integer' } } }],
    };
    expect(validateArgumentFormat(ok, rule).pass).toBe(true);
    expect(validateArgumentFormat(okStr, rule).pass).toBe(true);
    expect(validateArgumentFormat(bad, rule).pass).toBe(false);
  });

  it('validates number (int and float)', () => {
    const ok = makeResult([{ name: 't', arguments: { n: 1.5 } }]);
    const bad = makeResult([{ name: 't', arguments: { n: 'abc' } }]);
    const rule: ArgumentFormatExpectation = {
      calls: [{ name: 't', arguments: { n: { kind: 'number' } } }],
    };
    expect(validateArgumentFormat(ok, rule).pass).toBe(true);
    expect(validateArgumentFormat(bad, rule).pass).toBe(false);
  });

  it('validates boolean type strictly', () => {
    const ok = makeResult([{ name: 't', arguments: { flag: true } }]);
    const bad = makeResult([{ name: 't', arguments: { flag: 'true' } }]);
    const rule: ArgumentFormatExpectation = {
      calls: [{ name: 't', arguments: { flag: { kind: 'boolean' } } }],
    };
    expect(validateArgumentFormat(ok, rule).pass).toBe(true);
    expect(validateArgumentFormat(bad, rule).pass).toBe(false);
  });

  it('validates iso-date', () => {
    const ok = makeResult([{ name: 't', arguments: { d: '2026-07-31' } }]);
    const bad = makeResult([{ name: 't', arguments: { d: '31/07/2026' } }]);
    const rule: ArgumentFormatExpectation = {
      calls: [{ name: 't', arguments: { d: { kind: 'iso-date' } } }],
    };
    expect(validateArgumentFormat(ok, rule).pass).toBe(true);
    expect(validateArgumentFormat(bad, rule).pass).toBe(false);
  });

  it('validates iso-datetime', () => {
    const ok = makeResult([
      { name: 't', arguments: { ts: '2026-07-31T12:00:00Z' } },
    ]);
    const bad = makeResult([{ name: 't', arguments: { ts: '2026-07-31' } }]);
    const rule: ArgumentFormatExpectation = {
      calls: [{ name: 't', arguments: { ts: { kind: 'iso-datetime' } } }],
    };
    expect(validateArgumentFormat(ok, rule).pass).toBe(true);
    expect(validateArgumentFormat(bad, rule).pass).toBe(false);
  });

  it('validates uuid', () => {
    const ok = makeResult([
      {
        name: 't',
        arguments: { id: '123e4567-e89b-12d3-a456-426614174000' },
      },
    ]);
    const bad = makeResult([{ name: 't', arguments: { id: 'not-a-uuid' } }]);
    const rule: ArgumentFormatExpectation = {
      calls: [{ name: 't', arguments: { id: { kind: 'uuid' } } }],
    };
    expect(validateArgumentFormat(ok, rule).pass).toBe(true);
    expect(validateArgumentFormat(bad, rule).pass).toBe(false);
  });

  it('validates enum membership (type-sensitive)', () => {
    const ok = makeResult([{ name: 't', arguments: { sort: 'asc' } }]);
    const bad = makeResult([{ name: 't', arguments: { sort: 'sideways' } }]);
    const rule: ArgumentFormatExpectation = {
      calls: [
        {
          name: 't',
          arguments: { sort: { kind: 'enum', values: ['asc', 'desc'] } },
        },
      ],
    };
    expect(validateArgumentFormat(ok, rule).pass).toBe(true);
    expect(validateArgumentFormat(bad, rule).pass).toBe(false);
  });

  it('fails enum when values is missing', () => {
    const result = makeResult([{ name: 't', arguments: { sort: 'asc' } }]);
    const v = validateArgumentFormat(result, {
      calls: [{ name: 't', arguments: { sort: { kind: 'enum' } } }],
    });
    expect(v.pass).toBe(false);
    expect(v.message).toContain('values');
  });

  it('validates comma-list (string with >= 2 items)', () => {
    const ok = makeResult([{ name: 't', arguments: { tags: 'a,b,c' } }]);
    const arrayForm = makeResult([
      { name: 't', arguments: { tags: ['a', 'b'] } },
    ]);
    const single = makeResult([{ name: 't', arguments: { tags: 'only' } }]);
    const rule: ArgumentFormatExpectation = {
      calls: [{ name: 't', arguments: { tags: { kind: 'comma-list' } } }],
    };
    expect(validateArgumentFormat(ok, rule).pass).toBe(true);
    // JSON array instead of comma-separated string -> failure
    expect(validateArgumentFormat(arrayForm, rule).pass).toBe(false);
    // single item without comma -> failure (list implies >= 2)
    expect(validateArgumentFormat(single, rule).pass).toBe(false);
  });

  it('validates regex with flags', () => {
    const ok = makeResult([{ name: 't', arguments: { code: 'ABC' } }]);
    const bad = makeResult([{ name: 't', arguments: { code: '123' } }]);
    const rule: ArgumentFormatExpectation = {
      calls: [
        {
          name: 't',
          arguments: {
            code: { kind: 'regex', pattern: '^[A-Z]+$', flags: '' },
          },
        },
      ],
    };
    expect(validateArgumentFormat(ok, rule).pass).toBe(true);
    expect(validateArgumentFormat(bad, rule).pass).toBe(false);
  });
});

describe('validateArgumentFormat — length bounds', () => {
  it('enforces minLength and maxLength on the stringified value', () => {
    const ok = makeResult([{ name: 't', arguments: { q: 'hello' } }]);
    const tooShort = makeResult([{ name: 't', arguments: { q: 'hi' } }]);
    const tooLong = makeResult([{ name: 't', arguments: { q: 'abcdefgh' } }]);
    const rule: ArgumentFormatExpectation = {
      calls: [
        {
          name: 't',
          arguments: { q: { kind: 'quoted', minLength: 3, maxLength: 5 } },
        },
      ],
    };
    expect(validateArgumentFormat(ok, rule).pass).toBe(true);
    expect(validateArgumentFormat(tooShort, rule).pass).toBe(false);
    expect(validateArgumentFormat(tooLong, rule).pass).toBe(false);
  });
});

describe('validateArgumentFormat — structure', () => {
  it('accepts an array of rules for one argument (all must pass)', () => {
    const result = makeResult([{ name: 't', arguments: { q: 'hello' } }]);
    const v = validateArgumentFormat(result, {
      calls: [
        {
          name: 't',
          arguments: {
            q: [{ kind: 'quoted' }, { kind: 'regex', pattern: '^h' }],
          },
        },
      ],
    });
    expect(v.pass).toBe(true);
  });

  it('fails when one rule in an array fails', () => {
    const result = makeResult([{ name: 't', arguments: { q: 'hello' } }]);
    const v = validateArgumentFormat(result, {
      calls: [
        {
          name: 't',
          arguments: {
            q: [{ kind: 'quoted' }, { kind: 'regex', pattern: '^x' }],
          },
        },
      ],
    });
    expect(v.pass).toBe(false);
  });

  it('checks every matching call of the same name', () => {
    const result = makeResult([
      { name: 't', arguments: { q: 'good' } },
      { name: 't', arguments: { q: 99 } },
    ]);
    const v = validateArgumentFormat(result, {
      calls: [{ name: 't', arguments: { q: { kind: 'quoted' } } }],
    });
    expect(v.pass).toBe(false);
  });

  it('fails when a required call is missing', () => {
    const result = makeResult([{ name: 'other', arguments: {} }]);
    const v = validateArgumentFormat(result, {
      calls: [{ name: 'search', arguments: { q: { kind: 'quoted' } } }],
    });
    expect(v.pass).toBe(false);
    expect(v.message).toContain('search');
  });

  it('skips a missing call when required is false', () => {
    const result = makeResult([{ name: 'other', arguments: {} }]);
    const v = validateArgumentFormat(result, {
      calls: [
        {
          name: 'search',
          required: false,
          arguments: { q: { kind: 'quoted' } },
        },
      ],
    });
    expect(v.pass).toBe(true);
  });

  it('treats an absent argument as a format failure', () => {
    const result = makeResult([{ name: 't', arguments: {} }]);
    const v = validateArgumentFormat(result, {
      calls: [{ name: 't', arguments: { q: { kind: 'quoted' } } }],
    });
    expect(v.pass).toBe(false);
  });

  it('reports the checked count in details on success', () => {
    const result = makeResult([{ name: 't', arguments: { q: 'hi', n: 3 } }]);
    const v = validateArgumentFormat(result, {
      calls: [
        {
          name: 't',
          arguments: { q: { kind: 'quoted' }, n: { kind: 'integer' } },
        },
      ],
    });
    expect(v.pass).toBe(true);
    expect(v.details?.checked).toBe(2);
  });

  it('returns an error when response is not an MCPHostSimulationResult', () => {
    const v = validateArgumentFormat('not a simulation', {
      calls: [{ name: 't', arguments: { q: { kind: 'quoted' } } }],
    });
    expect(v.pass).toBe(false);
    expect(v.message).toContain('mcp_host');
  });
});
