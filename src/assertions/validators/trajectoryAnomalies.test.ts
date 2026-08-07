import { describe, it, expect } from 'vitest';
import {
  validateTrajectoryAnomalies,
  detectTrajectoryAnomalies,
} from './trajectoryAnomalies.js';
import type { MCPHostSimulationResult } from '../../evals/mcpHost/mcpHostTypes.js';

function makeResult(
  toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>,
  conversationHistory?: MCPHostSimulationResult['conversationHistory']
): MCPHostSimulationResult {
  return {
    success: true,
    toolCalls: toolCalls.map((c) => ({
      ...c,
      arguments: c.arguments ?? {},
    })),
    conversationHistory,
  };
}

describe('validateTrajectoryAnomalies', () => {
  it('passes for a clean trajectory', () => {
    const result = makeResult([
      { name: 'search', arguments: { q: 'a' } },
      { name: 'read', arguments: { path: '/x' } },
    ]);
    const v = validateTrajectoryAnomalies(result);
    expect(v.pass).toBe(true);
  });

  it('requires an mcp_host simulation result', () => {
    const v = validateTrajectoryAnomalies('plain text response');
    expect(v.pass).toBe(false);
    expect(v.message).toContain('mcp_host');
  });

  it('detects a tool-call loop and fails', () => {
    const result = makeResult([
      { name: 'search', arguments: { q: 'a' } },
      { name: 'search', arguments: { q: 'a' } },
      { name: 'search', arguments: { q: 'a' } },
    ]);
    const v = validateTrajectoryAnomalies(result);
    expect(v.pass).toBe(false);
    expect(v.message).toContain("'search'");
    expect(v.details?.loop).toBe(true);
  });

  it('does not flag a single retry below the loop threshold', () => {
    const result = makeResult([
      { name: 'search', arguments: { q: 'a' } },
      { name: 'search', arguments: { q: 'a' } },
    ]);
    const v = validateTrajectoryAnomalies(result);
    expect(v.pass).toBe(true);
  });

  it('respects a custom loopThreshold', () => {
    const result = makeResult([
      { name: 'search', arguments: { q: 'a' } },
      { name: 'search', arguments: { q: 'a' } },
    ]);
    const v = validateTrajectoryAnomalies(result, { loopThreshold: 2 });
    expect(v.pass).toBe(false);
  });

  it('treats arguments with reordered keys as identical', () => {
    const result = makeResult([
      { name: 'search', arguments: { a: 1, b: 2 } },
      { name: 'search', arguments: { b: 2, a: 1 } },
      { name: 'search', arguments: { a: 1, b: 2 } },
    ]);
    const v = validateTrajectoryAnomalies(result);
    expect(v.pass).toBe(false);
    expect(v.details?.loop).toBe(true);
  });

  it('detects an error cascade from conversation history', () => {
    const result = makeResult(
      [{ name: 'search' }, { name: 'search' }],
      [
        { role: 'assistant', content: 'thinking' },
        { role: 'tool', content: JSON.stringify([{ isError: true }]) },
        { role: 'assistant', content: 'retry' },
        { role: 'tool', content: JSON.stringify([{ isError: true }]) },
      ]
    );
    const v = validateTrajectoryAnomalies(result);
    expect(v.pass).toBe(false);
    expect(v.details?.errorCascade).toBe(true);
  });

  it('does not false-positive on non-error tool steps', () => {
    const result = makeResult(
      [{ name: 'search' }],
      [
        {
          role: 'tool',
          content: JSON.stringify([{ type: 'text', text: 'ok' }]),
        },
        { role: 'tool', content: 'unparseable prose about errors' },
      ]
    );
    const v = validateTrajectoryAnomalies(result);
    expect(v.pass).toBe(true);
  });
});

describe('detectTrajectoryAnomalies', () => {
  it('returns a structured report with loop and errorCascade flags', () => {
    const result = makeResult(
      [
        { name: 'x', arguments: {} },
        { name: 'x', arguments: {} },
        { name: 'x', arguments: {} },
      ],
      [{ role: 'tool', content: JSON.stringify([{ isError: true }]) }]
    );
    const report = detectTrajectoryAnomalies(result);
    expect(report.loop).toBe(true);
    expect(report.errorCascade).toBe(false); // single errored step < threshold
    expect(report.anomalies.length).toBe(1);
    expect(report.anomalies[0]?.type).toBe('loop');
  });
});
