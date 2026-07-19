# Reliability-Gated Scoring

> Decide when an LLM judge is allowed to automate scoring, and when its decisions must be routed to human review.

---

## Why this exists

LLM-as-a-judge scores are convenient, but a judge that is unreliable on your rubric will silently encode its mistakes into your pass-rate deltas. **Reliability-gated scoring** adapts the central mechanism of [Project Kaleidoscope](https://arxiv.org/abs/2607.14673v1): _judges automate scoring only when their agreement with human labels meets a configured threshold._ When the judge is not demonstrably reliable, automated scores are withheld and the affected cases are flagged for human review instead of trusted.

This module keeps Kaleidoscope's gate at full fidelity and intentionally leaves out its persona-based test generation, human-review annotation UI, and rubric-authoring workflow — the framework already hosts eval datasets, multi-iteration accuracy, built-in rubrics, and a custom-judge registry.

---

## How it works

1. **Calibrate.** On a sample of cases you have human-reviewed, compare each judge decision to its human label. `calibrateJudgeReliability` reports the match rate, Cohen's kappa, and a gate decision: is the judge reliable enough to auto-score?
2. **Gate per case.** `gateCaseScoring` trusts a case's automated score only when (a) the calibration passed and (b) the individual judges agreed on that case. Otherwise the case is routed to human review.
3. **Compare runs under the gate.** `applyReliabilityGate` takes an existing `compareEvalRuns` result and produces a gated view: pass-rate delta and improvement/regression buckets computed only from trusted cases, with the ungated delta surfaced alongside it so you can see exactly what the gate changed.

---

## Usage

```typescript
import { compareEvalRuns } from '@gleanwork/mcp-server-tester';
import {
  applyReliabilityGate,
  buildCalibrationFromCases,
  calibrateJudgeReliability,
} from '@gleanwork/mcp-server-tester/evals/reliabilityGatedScoring';
// The reliability-gated scoring helpers live in src/evals/reliabilityGatedScoring.ts.
// Until they are added to the public barrel (src/index.ts) and package.json
// `exports` map, import them via that source path or re-export from your own code.

// 1. Calibrate the judge against human labels on a labeled sample.
const examples = buildCalibrationFromCases(candidate.caseResults, {
  search_trigger: true,
  weather_query: false,
  // ... one entry per human-reviewed case
});
const calibration = calibrateJudgeReliability(examples, { threshold: 0.8 });

// 2. Compare runs, then see what survives the reliability gate.
const comparison = compareEvalRuns({ baseline, candidate });
const gated = applyReliabilityGate(comparison, calibration);

console.log(gated.ungatedDeltaPassRate); // what ungated scoring claimed
console.log(gated.gatedDeltaPassRate); // what survives the gate (null = nothing trusted)
console.log(gated.needsReviewCaseIds); // cases a human must look at
```

### Defaults

| Option                    | Default | Meaning                                                       |
| ------------------------- | ------- | ------------------------------------------------------------- |
| `threshold`               | `0.8`   | Minimum judge-vs-human match rate to permit automated scoring |
| `minSampleSize`           | `10`    | Minimum labeled examples; below this the gate stays closed    |
| `judgeConsensusThreshold` | `0.6`   | Per-case multi-judge agreement; below it a case needs review  |

---

## When to use it

- You ship changes through `runVariantExperiment` or tool-override variants and want to know whether detected regressions are real or judge artifacts.
- A new rubric or judge provider is being adopted and you want to gate it until it earns trust on labeled data.
- You are reporting pass-rate deltas to stakeholders and want to distinguish _trusted_ movement from movement that still needs human sign-off.
