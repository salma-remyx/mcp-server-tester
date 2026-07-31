import { describe, it, expect as vitestExpect } from 'vitest';
import { expect as mcpExpect } from './index.js';
import type { MCPHostSimulationResult } from '../../evals/mcpHost/mcpHostTypes.js';

function makeResult(
  toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>
): MCPHostSimulationResult {
  return {
    success: true,
    toolCalls: toolCalls.map((c) => ({ ...c, arguments: c.arguments ?? {} })),
  };
}

describe('toMatchToolArgumentFormat (registered matcher)', () => {
  it('passes when arguments satisfy the declared formats', () => {
    const result = makeResult([
      {
        name: 'search',
        arguments: { query: 'hello', date: '2026-07-31', sort: 'asc' },
      },
    ]);
    vitestExpect(() =>
      mcpExpect(result).toMatchToolArgumentFormat({
        calls: [
          {
            name: 'search',
            arguments: {
              query: { kind: 'quoted' },
              date: { kind: 'iso-date' },
              sort: { kind: 'enum', values: ['asc', 'desc'] },
            },
          },
        ],
      })
    ).not.toThrow();
  });

  it('fails when an argument violates its format', () => {
    const result = makeResult([{ name: 'search', arguments: { query: 123 } }]);
    vitestExpect(() =>
      mcpExpect(result).toMatchToolArgumentFormat({
        calls: [{ name: 'search', arguments: { query: { kind: 'quoted' } } }],
      })
    ).toThrow();
  });

  it('supports negation with not', () => {
    const result = makeResult([{ name: 'search', arguments: { query: 123 } }]);
    vitestExpect(() =>
      mcpExpect(result).not.toMatchToolArgumentFormat({
        calls: [{ name: 'search', arguments: { query: { kind: 'quoted' } } }],
      })
    ).not.toThrow();
  });
});
