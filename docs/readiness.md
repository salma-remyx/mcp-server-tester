# Readiness Scoring

Readiness scoring turns a completed eval run into a **deployment decision**. Eval runs already produce metrics — pass rates, latencies, costs, judge scores — but nothing answers "can we ship this?" Readiness scoring aggregates the signals the reporter collects per case (pass rate, pass-rate confidence interval, p95 latency, cost, judge groundedness / tool recall) into three artifacts:

- a **scenario-weighted readiness score** in `[0, 1]`, blended from success, latency, cost, and quality sub-scores;
- an **efficiency (Pareto) frontier** over the passing cases on the quality-vs-latency-vs-cost tradeoff;
- a **CI-style quality gate** that reports `READY` / `NOT READY` with concrete blockers, split into hard and soft blockers.

The approach is adapted from _LLM Readiness Harness: Evaluation, Observability, and CI Gates for LLM/RAG Applications_ (arXiv:2603.27355), ported onto the signals this framework already collects — no separate telemetry backend required.

## Where the Verdict Appears

Every generated report and externally stored run carries a `readiness` assessment (`MCPEvalRunData.readiness`), and the reporter logs the gate verdict at the end of a run:

```
[MCP Reporter] Readiness: NOT READY (score 72.0%) — pass rate 70.0% below threshold 100.0% (using CI lower bound)
```

You can also compute an assessment programmatically from any completed run — the function is pure: it does not run evals, call LLMs, or touch the filesystem.

## Usage

```typescript snippet=snippets/readiness-score.ts
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import {
  loadEvalDataset,
  runEvalDataset,
  computeReadiness,
} from '@gleanwork/mcp-server-tester';

// Turn a completed eval run into a deployment decision.
test('readiness gate', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/my-evals.json');
  const result = await runEvalDataset({ dataset }, { mcp, testInfo });

  const assessment = computeReadiness({
    results: result.caseResults,
    // Optional: weight scenarios by case tag (higher counts more).
    scenarioWeights: { prod: 10, experimental: 1 },
    // Optional: a named weight preset ('cost-first' | 'risk-first' | 'sla-first').
    preset: 'risk-first',
    // Optional: CI gate thresholds.
    thresholds: {
      minPassRate: 0.95,
      maxP95LatencyMs: 3000,
      maxCostUsd: 0.5,
      minQuality: 0.8,
    },
  });

  if (!assessment.gate.ready) {
    console.log(assessment.gate.blockers);
  }

  // Hard blockers are workflow/policy failures; soft blockers are
  // latency / cost / quality budget breaches. Enforce only the hard
  // gate when budgets are advisory.
  expect(assessment.gate.hardBlockers).toHaveLength(0);
});
```

## The Score

The overall score blends four component sub-scores, each in `[0, 1]`:

| Component | Signal                                                    | Default weight |
| --------- | --------------------------------------------------------- | -------------- |
| `success` | Scenario-weighted pass rate                               | 0.5            |
| `latency` | p95 per-case latency vs. `maxP95LatencyMs` budget         | 0.2            |
| `cost`    | Total run cost vs. `maxCostUsd` budget                    | 0.15           |
| `quality` | Judge groundedness rate, falling back to mean tool recall | 0.15           |

`scenarioWeights` keys on case tags (falling back to the dataset name), so production-critical scenarios count more toward the success component and the gate than experimental ones.

## Scenario Presets

Named weight presets from the paper's scenario table are available via the `preset` option or the exported `READINESS_WEIGHT_PRESETS`:

| Preset       | Emphasis                                            |
| ------------ | --------------------------------------------------- |
| `cost-first` | Cost and quality dominate; latency matters least    |
| `risk-first` | Quality (groundedness) dominates; for risky domains |
| `sla-first`  | Latency dominates; for latency-sensitive surfaces   |

A preset is applied over the defaults, and explicit `weights` entries override the preset, so you can start from a preset and tune one component.

## Missing-Metric Handling

The score blends only the dimensions that were actually measured. If no judge or tool-recall data ran, `quality` is excluded and the remaining weights are renormalized; likewise for `cost` when no host usage was recorded. Excluded dimensions are listed in `assessment.missingComponents`, and gate thresholds for unmeasured dimensions are skipped — never evaluated against a substituted default. An empty run is scored `0` and reported as not ready.

## Hard and Soft CI Gates

The gate classifies blockers into two tiers:

- **Hard blockers** (`gate.hardBlockers`): workflow/policy failures — the (scenario-weighted) pass rate fell below `minPassRate`. For multi-iteration cases the gate uses the conservative Wilson lower bound of the pass-rate confidence interval, so a flaky workflow cannot sneak through. A run cannot be ready with a hard blocker no matter how high the scalar score is.
- **Soft blockers** (`gate.softBlockers`): latency, cost, or quality budget breaches. These degrade the score and block the default-strict gate, but are classified separately so a CI pipeline can choose to enforce only the hard gate while budgets are being calibrated.

`gate.blockers` is the union of both; `gate.passed` lists the thresholds that were met.

## Pareto Frontier

`assessment.paretoFrontier` (also exported standalone as `paretoFrontier(results)`) lists the non-dominated **passing** cases: cases where no other passing case is at least as good on quality, latency, and cost, and strictly better on at least one. Use it to see which scenarios give the best quality per unit of latency and cost — and which passing cases are dominated and could be cheapened. Cases with no measured quality are treated conservatively (quality `0` for dominance) but keep `quality: null` in the output.

## See Also

- [API Reference](./api-reference.md#computereadinessinput) — `computeReadiness`, `paretoFrontier`, `wilsonLowerBound`, and the readiness types
- [Evals Guide](./evals-guide.md) — designing the datasets a readiness gate runs over
- [UI Reporter](./ui-reporter.md) — where the readiness verdict is displayed
