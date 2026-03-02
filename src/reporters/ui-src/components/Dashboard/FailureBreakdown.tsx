import React, { useMemo } from 'react';
import type { EvalCaseResult } from '../../types';
import type { ExpectationType } from '../../types';

interface FailureCount {
  type: ExpectationType;
  count: number;
}

function computeFailureCounts(results: EvalCaseResult[]): FailureCount[] {
  const counts = new Map<ExpectationType, number>();

  for (const result of results) {
    if (result.pass) continue;

    for (const [type, expectation] of Object.entries(result.expectations) as [
      ExpectationType,
      { pass: boolean },
    ][]) {
      if (expectation.pass === false) {
        counts.set(type, (counts.get(type) ?? 0) + 1);
      }
    }
  }

  return Array.from(counts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

export function FailureBreakdown({ results }: { results: EvalCaseResult[] }) {
  const failureCounts = useMemo(() => computeFailureCounts(results), [results]);
  const totalFailed = useMemo(
    () => results.filter((r) => !r.pass).length,
    [results]
  );

  if (totalFailed === 0) return null;

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-foreground mb-3">Why Cases Fail</h2>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">
          {totalFailed} failure{totalFailed !== 1 ? 's' : ''}:
        </span>
        {failureCounts.map(({ type, count }) => (
          <span
            key={type}
            className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400"
          >
            <span className="font-semibold">{type}</span>
            <span className="text-red-500 dark:text-red-500">({count})</span>
          </span>
        ))}
      </div>
    </div>
  );
}
