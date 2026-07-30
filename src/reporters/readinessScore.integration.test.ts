/**
 * Integration test for the readiness wiring in MCPReporter.buildRunData().
 *
 * Imports the existing (non-new) reporter module, drives buildRunData() with
 * realistic EvalCaseResult records the same way the production reporter does,
 * and asserts that a readiness assessment is attached to the run data and that
 * the gate verdict reflects the cases.
 */
import { describe, it, expect } from 'vitest';
import MCPReporter from './mcpReporter.js';
import type { EvalCaseResult } from '../types/reporter.js';

function makeReporter(): MCPReporter {
  return new MCPReporter({ quiet: true, autoOpen: false });
}

function setResults(reporter: MCPReporter, results: EvalCaseResult[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (reporter as any).allResults = results;
}

function makeResult(
  overrides: Partial<EvalCaseResult> & { pass: boolean }
): EvalCaseResult {
  return {
    id: 'case-1',
    datasetName: 'test-dataset',
    toolName: 'search',
    source: 'eval',
    expectations: {},
    durationMs: 100,
    ...overrides,
  };
}

describe('MCPReporter.buildRunData() readiness wiring', () => {
  it('attaches a readiness assessment computed from the run results', () => {
    const reporter = makeReporter();
    setResults(reporter, [
      makeResult({ id: 'a', pass: true, durationMs: 80 }),
      makeResult({ id: 'b', pass: true, durationMs: 120 }),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runData = (reporter as any).buildRunData(200);

    expect(runData.readiness).toBeDefined();
    expect(runData.readiness.signals.caseCount).toBe(2);
    expect(runData.readiness.signals.passRate).toBe(1);
    // Every case passed and budgets are respected -> gate is ready.
    expect(runData.readiness.gate.ready).toBe(true);
    expect(runData.readiness.gate.blockers).toEqual([]);
  });

  it('marks the gate NOT READY when a case fails', () => {
    const reporter = makeReporter();
    setResults(reporter, [
      makeResult({ id: 'a', pass: true }),
      makeResult({ id: 'b', pass: false }),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runData = (reporter as any).buildRunData(150);

    expect(runData.readiness.gate.ready).toBe(false);
    expect(runData.readiness.gate.blockers[0]).toContain('pass rate');
  });

  it('respects p95 latency budget when computing the gate', () => {
    const reporter = makeReporter();
    setResults(reporter, [
      makeResult({ id: 'a', pass: true, durationMs: 100 }),
      makeResult({ id: 'b', pass: true, durationMs: 100 }),
      makeResult({ id: 'c', pass: true, durationMs: 9_000 }),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runData = (reporter as any).buildRunData(9_500);

    // p95 of [100, 100, 9000] is 9000ms, well over the default 5000ms budget.
    expect(runData.readiness.signals.p95LatencyMs).toBe(9_000);
    expect(runData.readiness.gate.ready).toBe(false);
    expect(
      runData.readiness.gate.blockers.some((b: string) =>
        b.includes('p95 latency')
      )
    ).toBe(true);
  });
});
