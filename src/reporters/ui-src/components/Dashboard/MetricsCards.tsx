import React, { useMemo } from 'react';
import { BarChart3, FlaskConical } from 'lucide-react';
import type { EvalCaseResult } from '../../types';

interface MetricsCardsProps {
  results: EvalCaseResult[];
}

interface MetricsSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  avgAccuracy?: number; // mean accuracy across multi-iteration cases
  totalIterations?: number; // total iterations run
}

function computeMetrics(results: EvalCaseResult[]): MetricsSummary {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const total = results.length;

  const multiIterResults = results.filter(
    (r) => r.assertionPassRate !== undefined
  );
  const avgAccuracy =
    multiIterResults.length > 0
      ? multiIterResults.reduce(
          (sum, r) => sum + (r.assertionPassRate ?? 0),
          0
        ) / multiIterResults.length
      : undefined;

  const totalIterations = results.reduce(
    (sum, r) => sum + (r.iterationResults?.length ?? 1),
    0
  );

  return {
    total,
    passed,
    failed,
    passRate: total > 0 ? passed / total : 0,
    avgAccuracy,
    totalIterations,
  };
}

interface ToolDiscoveryMetrics {
  meanRecall: number;
  count: number;
}

interface RegressionMetrics {
  regressions: number;
  fixes: number;
}

function computeToolDiscovery(
  results: EvalCaseResult[]
): ToolDiscoveryMetrics | null {
  const withRecall = results.filter((r) => r.toolRecall !== undefined);
  if (withRecall.length === 0) return null;
  const meanRecall =
    withRecall.reduce((sum, r) => sum + (r.toolRecall ?? 0), 0) /
    withRecall.length;
  return { meanRecall, count: withRecall.length };
}

function computeRegressions(results: EvalCaseResult[]): RegressionMetrics | null {
  const withBaseline = results.filter((r) => r.baselinePass !== undefined);
  if (withBaseline.length === 0) return null;
  const regressions = withBaseline.filter(
    (r) => r.baselinePass === true && r.pass === false
  ).length;
  const fixes = withBaseline.filter(
    (r) => r.baselinePass === false && r.pass === true
  ).length;
  return { regressions, fixes };
}

export function MetricsCards({ results }: MetricsCardsProps) {
  const overall = useMemo(() => computeMetrics(results), [results]);
  const toolDiscovery = useMemo(() => computeToolDiscovery(results), [results]);
  const regressionMetrics = useMemo(() => computeRegressions(results), [results]);
  const showAccuracy = overall.avgAccuracy !== undefined;

  const extraCards =
    (showAccuracy ? 1 : 0) +
    (toolDiscovery !== null ? 1 : 0) +
    (regressionMetrics !== null ? 1 : 0);
  const totalCols = 4 + extraCards;

  return (
    <div
      className={`grid grid-cols-2 gap-4 lg:grid-cols-${totalCols}`}
    >
      <MetricCard
        title="Pass Rate"
        value={`${(overall.passRate * 100).toFixed(1)}%`}
        variant={overall.passRate >= 0.8 ? 'success' : 'error'}
      />
      {showAccuracy && (
        <MetricCard
          title="Avg LLM Accuracy"
          value={`${(overall.avgAccuracy! * 100).toFixed(1)}%`}
          subtitle={`${overall.totalIterations} iterations`}
          variant={
            overall.avgAccuracy! >= 0.8
              ? 'success'
              : overall.avgAccuracy! >= 0.6
                ? 'warning'
                : 'error'
          }
        />
      )}
      {toolDiscovery !== null && (
        <MetricCard
          title="Tool Discovery Rate"
          value={`${(toolDiscovery.meanRecall * 100).toFixed(1)}%`}
          subtitle="avg recall across llm_host cases"
          variant={
            toolDiscovery.meanRecall >= 0.8
              ? 'success'
              : toolDiscovery.meanRecall >= 0.6
                ? 'warning'
                : 'error'
          }
        />
      )}
      {regressionMetrics !== null && (
        <RegressionCard metrics={regressionMetrics} />
      )}
      <MetricCard
        title="Total Cases"
        value={overall.total.toString()}
        subtitle={
          overall.totalIterations && overall.totalIterations > overall.total
            ? `${overall.totalIterations} runs`
            : undefined
        }
        variant="neutral"
      />
      <MetricCard
        title="Passed"
        value={overall.passed.toString()}
        variant="success"
      />
      <MetricCard
        title="Failed"
        value={overall.failed.toString()}
        variant={overall.failed === 0 ? 'neutral' : 'error'}
      />
    </div>
  );
}

interface RegressionCardProps {
  metrics: RegressionMetrics;
}

function RegressionCard({ metrics }: RegressionCardProps) {
  const hasRegressions = metrics.regressions > 0;

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex flex-col">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Regressions / Fixed
        </span>
        <div className="mt-2 flex flex-col gap-1">
          <span
            className={`text-sm font-semibold ${
              hasRegressions
                ? 'text-red-600 dark:text-red-400'
                : 'text-muted-foreground'
            }`}
          >
            ▼ {metrics.regressions} regression{metrics.regressions !== 1 ? 's' : ''}
          </span>
          <span
            className={`text-sm font-semibold ${
              metrics.fixes > 0
                ? 'text-green-600 dark:text-green-400'
                : 'text-muted-foreground'
            }`}
          >
            ▲ {metrics.fixes} fixed
          </span>
        </div>
      </div>
    </div>
  );
}

interface SourceBreakdownProps {
  results: EvalCaseResult[];
}

export function SourceBreakdown({ results }: SourceBreakdownProps) {
  const { evals, tests } = useMemo(() => {
    const evalResults = results.filter((r) => r.source === 'eval');
    const testResults = results.filter((r) => r.source === 'test');
    return {
      evals: computeMetrics(evalResults),
      tests: computeMetrics(testResults),
    };
  }, [results]);

  if (evals.total === 0 && tests.total === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {tests.total > 0 && (
        <SourceBreakdownCard
          title="Test Suites"
          icon={<FlaskConical size={18} />}
          metrics={tests}
          accentColor="purple"
        />
      )}
      {evals.total > 0 && (
        <SourceBreakdownCard
          title="Eval Datasets"
          icon={<BarChart3 size={18} />}
          metrics={evals}
          accentColor="blue"
        />
      )}
    </div>
  );
}

interface MetricCardProps {
  title: string;
  value: string;
  subtitle?: string;
  variant: 'success' | 'error' | 'neutral' | 'warning';
}

function MetricCard({ title, value, subtitle, variant }: MetricCardProps) {
  const colors = {
    success: 'text-green-600 dark:text-green-400',
    error: 'text-red-600 dark:text-red-400',
    neutral: 'text-foreground',
    warning: 'text-amber-600 dark:text-amber-400',
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex flex-col">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {title}
        </span>
        <span className={`mt-2 text-3xl font-bold ${colors[variant]}`}>
          {value}
        </span>
        {subtitle && (
          <span className="mt-1 text-xs text-muted-foreground">{subtitle}</span>
        )}
      </div>
    </div>
  );
}

interface SourceBreakdownCardProps {
  title: string;
  icon: React.ReactNode;
  metrics: MetricsSummary;
  accentColor: 'blue' | 'purple';
}

function SourceBreakdownCard({
  title,
  icon,
  metrics,
  accentColor,
}: SourceBreakdownCardProps) {
  const colorClasses = {
    blue: {
      border: 'border-l-blue-500',
      bg: 'bg-blue-500/5',
      icon: 'text-blue-600 dark:text-blue-400',
      title: 'text-blue-700 dark:text-blue-300',
    },
    purple: {
      border: 'border-l-purple-500',
      bg: 'bg-purple-500/5',
      icon: 'text-purple-600 dark:text-purple-400',
      title: 'text-purple-700 dark:text-purple-300',
    },
  };

  const colors = colorClasses[accentColor];

  return (
    <div
      className={`rounded-lg border border-l-4 ${colors.border} ${colors.bg} p-4 shadow-sm`}
    >
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-2">
          <span className={colors.icon}>{icon}</span>
          <span className={`font-semibold ${colors.title}`}>{title}</span>
        </div>
        <div className="flex items-center gap-6 text-sm flex-wrap">
          <div className="flex flex-col items-center">
            <span className="text-xs text-muted-foreground uppercase">
              Pass Rate
            </span>
            <span
              className={`font-bold ${
                metrics.passRate >= 0.8
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {(metrics.passRate * 100).toFixed(1)}%
            </span>
          </div>
          {metrics.avgAccuracy !== undefined && (
            <div className="flex flex-col items-center">
              <span className="text-xs text-muted-foreground uppercase">
                Avg Accuracy
              </span>
              <span
                className={`font-bold ${
                  metrics.avgAccuracy >= 0.8
                    ? 'text-green-600 dark:text-green-400'
                    : metrics.avgAccuracy >= 0.6
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-red-600 dark:text-red-400'
                }`}
              >
                {(metrics.avgAccuracy * 100).toFixed(1)}%
              </span>
            </div>
          )}
          {metrics.totalIterations !== undefined &&
            metrics.totalIterations > metrics.total && (
              <div className="flex flex-col items-center">
                <span className="text-xs text-muted-foreground uppercase">
                  Iterations
                </span>
                <span className="font-bold">{metrics.totalIterations}</span>
              </div>
            )}
          <div className="flex flex-col items-center">
            <span className="text-xs text-muted-foreground uppercase">
              Cases
            </span>
            <span className="font-bold">{metrics.total}</span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-xs text-muted-foreground uppercase">
              Passed
            </span>
            <span className="font-bold text-green-600 dark:text-green-400">
              {metrics.passed}
            </span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-xs text-muted-foreground uppercase">
              Failed
            </span>
            <span
              className={`font-bold ${
                metrics.failed === 0
                  ? 'text-muted-foreground'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {metrics.failed}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
