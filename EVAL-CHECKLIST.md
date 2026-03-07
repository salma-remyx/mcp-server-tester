# Eval Checklist — preview/ui-redesign

Generated: 2026-03-05 | Panel: eval-panel-ui-redesign (Discovery Mode, 8 agents)
Last updated: 2026-03-05 (PRs #111–123 merged)

## How to read this

- P0 = release blocker; P1 = should fix before release; P2 = nice to have / backlog
- Each item has a unique ID (CHK-NNN), acceptance criteria, and the agents who found it
- Items are OPEN until acceptance criteria are verifiably met via file read
- Confidence: Confirmed = 3+ agents | Corroborated = 2 agents | Single = 1 agent (high confidence)

---

## P0 — Release Blockers

_(all closed — see Closed section)_

---

## P1 — Should fix before release

_(all closed — see Closed section)_

---

## P2 — Nice to have / Backlog

- [ ] **CHK-021** `runData.metrics.expectationBreakdown` and `datasetBreakdown` are computed by reporter but never displayed in the UI
  - **File:** `src/reporters/ui-src/App.tsx:21-45`; `src/reporters/ui-src/components/Dashboard/MetricsCards.tsx:20-49`
  - **Details:** `MCPEvalRunData.metrics` contains pre-aggregated `expectationBreakdown` (which assertion types users exercise), `datasetBreakdown` (how cases distribute across datasets). The UI ignores all of it and recomputes from `results[]`. The `expectationBreakdown` data (e.g., "you ran 9 textContains checks, 4 judge checks") is nowhere visible.
  - **Acceptance:** `expectationBreakdown` data is displayed somewhere in the UI (e.g., a breakdown chart on the Overview or Evals tab). The decision to use pre-aggregated vs. re-derived metrics is documented.
  - **Confidence:** Corroborated (devils-advocate, data-reviewer in discussion)
  - **Opened:** 2026-03-05

- [ ] **CHK-022** `EvalRunMetadata` (`gitHash`, `llmHostModel`, `judgeModel`, `packageVersion`) computed by runner but lost at reporter boundary
  - **File:** `src/evals/evalRunner.ts:918-932` (populated); reporter `buildRunData()` (dropped); `src/types/reporter.ts:20-31` (type defined)
  - **Details:** `EvalRunMetadata` is populated by `evalRunner` but `MCPEvalRunData` has no `metadata` field, so the reporter's `buildRunData()` never emits it. For llm_host evals, `llmHostModel` is critical experiment-tracking information.
  - **Acceptance:** (a) `metadata?: EvalRunMetadata` added to `MCPEvalRunData`; reporter's `buildRunData()` sets it; Layout header or info panel displays git hash and model versions. OR (b) `EvalRunMetadata` type is removed to eliminate dead code.
  - **Confidence:** Corroborated (devils-advocate, types-reviewer in discussion, data-reviewer in discussion)
  - **Opened:** 2026-03-05

- [ ] **CHK-023** `environment.ci` flag is captured but never displayed
  - **File:** `src/reporters/ui-src/components/Layout.tsx:28-34`
  - **Details:** The reporter detects `!!process.env.CI` and includes it in the data payload, but the Layout header only shows platform and duration. Users cannot distinguish CI-generated reports from local runs.
  - **Acceptance:** Layout header shows a "CI" badge or indicator when `environment.ci` is `true`.
  - **Confidence:** Corroborated (devils-advocate; data-reviewer in discussion)
  - **Opened:** 2026-03-05

- [ ] **CHK-029** No `prefers-reduced-motion` support — chart animations play unconditionally
  - **File:** `src/reporters/ui-src/components/Dashboard/TrendChart.tsx`; `src/reporters/ui-src/styles.css`
  - **Details:** Recharts `Line` plays an entry animation by default. `transition-colors` is used extensively. No `@media (prefers-reduced-motion: reduce)` rule.
  - **Acceptance:** `@media (prefers-reduced-motion: reduce)` in `styles.css` disables CSS transitions. Recharts `isAnimationActive={false}` applied when `prefers-reduced-motion` is `true`.
  - **Confidence:** Single-agent (a11y-reviewer in discussion)
  - **Opened:** 2026-03-05

  - **File:** `src/reporters/ui-src/components/Results/ResultsTable.tsx`
  - **Details:** When filters change, the visible result count updates in the DOM but no `aria-live` region announces the change to screen reader users.
  - **Acceptance:** An `aria-live="polite"` region announces the filtered result count when it changes (e.g., `"{n} results"`).
  - **Confidence:** Single-agent (a11y-reviewer in discussion)
  - **Opened:** 2026-03-05

---

## Closed

- [x] **CHK-001** `DetailModal` had no ARIA dialog semantics, no Escape key handler, no focus trap
  - **Closed by:** PR #116 | `role="dialog"`, `aria-modal`, `aria-labelledby`, Escape `useEffect`, focus-on-mount, focus-return-on-close, Tab focus trap

- [x] **CHK-002** Tab navigation had no ARIA tab roles (main nav + source filter tabs)
  - **Closed by:** PR #112 (main nav: `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls`, `role="tabpanel"`) + PR #115 (source filter tabs)

- [x] **CHK-003** Result rows were clickable `<div>` elements with no keyboard accessibility
  - **Closed by:** PR #115 | `role="button"`, `tabIndex={0}`, `onKeyDown` (Enter/Space), `aria-label`

- [x] **CHK-004** Icon-only interactive elements had no accessible name
  - **Closed by:** PR #111 (DarkModeToggle `aria-label`, Logo `aria-hidden`) + PR #116 (close button `aria-label="Close"`, SVG `aria-hidden`)

- [x] **CHK-005** Form controls in `ResultsTable` had no accessible labels
  - **Closed by:** PR #115 | `aria-label="Search results"` on input, `aria-label="Filter by project"` on select

- [x] **CHK-006** Toggle/filter buttons missing `aria-pressed`
  - **Closed by:** PR #115 | `aria-pressed` on tag filter buttons and pass/fail filter buttons

- [x] **CHK-007** `JSON.stringify(r.response)` in search filter ran on every keystroke
  - **Closed by:** PR #115 | `searchIndex` `useMemo([results])` pre-computes searchable strings once; null responses produce `''` (no false "null" matches)

- [x] **CHK-008** `preview-reporter.ts` had phantom `accuracy` field; `scripts/` not type-checked
  - **Closed by:** PR #114 | `accuracy` properties removed; `"scripts/**/*"` added to `tsconfig.json` include

- [x] **CHK-009** `expectationBreakdown` fallback missing `size`, `toolsTriggered`, `toolCallCount`
  - **Closed by:** PR #112 | All 10 `ExpectationType` keys present in fallback

- [x] **CHK-010** Duplicate `recharts` v2 + v3 entries in `package.json`
  - **Closed by:** PR #114 | Older `^2.12.0` entry removed; single `^3.7.0` entry remains

- [x] **CHK-011** `TrendChart` computed `chartData` without `useMemo`; 6+ unstable Recharts prop references
  - **Closed by:** PR #113 | `useMemo([historical])` on `chartData`; `CHART_MARGIN`, `AXIS_TICK_STYLE`, `LINE_DOT_STYLE`, `LINE_ACTIVE_DOT_STYLE` as module-level constants; `formatPercent` extracted; `Tooltip content={CustomTooltip}` (component ref, not element)

- [x] **CHK-012** `DarkModeToggle` used inline SVGs instead of Lucide; lacked `aria-label`
  - **Closed by:** PR #111 | `Sun`/`Moon` from `lucide-react`; `aria-label` reflects action; icon shows Sun when dark (switch-to-light) and Moon when light (switch-to-dark)

- [x] **CHK-013** `DetailModal` used inline SVGs for collapse chevron and close button
  - **Closed by:** PR #116 | `CollapsibleSection` uses `ChevronDown`/`ChevronRight`; close button uses `X` — all from `lucide-react`

- [x] **CHK-014** Color-threshold logic duplicated 7+ callsites; 2-tier vs 3-tier already diverging
  - **Closed by:** PR #117 | `rateColorClass(rate)` in `src/reporters/ui-src/utils.ts`; `ByToolTable` and `MetricsCards` (including `SourceBreakdownCard`) updated to use it

- [x] **CHK-015** `TrendChart` hardcoded hex colors bypassing CSS variable theme system
  - **Closed by:** PR #113 | `PASS_COLOR`/`MUTED_COLOR` named constants with comment documenting Recharts CSS variable limitation

- [x] **CHK-016** `ResultsTable` was a 523-line monolith
  - **Closed by:** PR #115 | `ResultRow` sub-component extracted; `formatMs()` added locally (shared via `utils.ts` from PR #117)

- [x] **CHK-017** `DetailModal` body was a 250-line monolith; `CollapsibleSection` file-private
  - **Closed by:** PR #116 | `CollapsibleSection` extracted to `src/reporters/ui-src/components/CollapsibleSection.tsx`; `iterations` const eliminates scattered non-null assertions

- [x] **CHK-018** `evalCount`/`testCount` in `ResultsTable` computed without `useMemo`
  - **Closed by:** PR #115 | Both wrapped in `useMemo([results])`

- [x] **CHK-019** No React error boundaries — a single throw crashed the entire app
  - **Closed by:** PR #112 | `ErrorBoundary` class component created; Overview, Evals, and Tests tab content each wrapped

- [x] **CHK-020** Collapsible section toggles missing `aria-expanded`
  - **Closed by:** PR #112 (App.tsx eval/test detail toggles) + PR #116 (`CollapsibleSection` with `useId()`-based `aria-controls`)

- [x] **CHK-024** `DetailModal` displayed `null` as literal string for error results
  - **Closed by:** PR #116 | Raw Response section shows `"No response — tool call failed"` when `result.response === null`

- [x] **CHK-025** `toolRecall` fallback displayed `"0%"` instead of `"N/A"` when undefined
  - **Closed by:** PR #116 | Explicit `!== undefined` check; `undefined` renders `"N/A"`

- [x] **CHK-028** `<html>` element missing `lang` attribute
  - **Closed by:** Already present — `src/reporters/ui-src/index.html` has `<html lang="en">`. No change needed.

- [x] **CHK-031** `TrendChart` had no text alternative for screen readers
  - **Closed by:** PR #113 (bonus) | Chart wrapper has `role="img"` and `aria-label` summarizing trend data

- [x] **CHK-026** `toolPrecision` JSDoc said "only when `exclusive: true`" — stale after PR #85 fix
  - **Closed by:** PR #120 | JSDoc updated to reflect that precision is always computed when `toolsTriggered` runs

- [x] **CHK-027** `ByToolTable` silently returned `null` for single-tool servers
  - **Closed by:** PR #121 | `distinctTools < 2` guard removed; replaced with `toolStats.length === 0`; unused `distinctTools` memo also removed

- [x] **CHK-030** No `aria-live` region for filter result count
  - **Closed by:** PR #119 | `role="status"` `aria-live="polite"` div announces filtered count

- [x] **CHK-033** `conformanceChecks` deduplication kept last occurrence, could hide failures
  - **Closed by:** PR #122 | Group-and-aggregate: PASS only if all projects pass; failing entry's message shown

- [x] **CHK-034** `result.source || 'eval'` fallback silently misclassified unknown-source results
  - **Closed by:** PR #119 | Fallback removed; `result.source` used directly (trusted required type)

- [x] **CHK-035** `ConformancePanel` guarded `check.message` as if optional; type says required
  - **Closed by:** PR #118 | Guard removed; `message` renders unconditionally

- [x] **CHK-032** `formatMs()` in `ByToolTable` not used in `ResultsTable` — raw ms shown
  - **Closed by:** PR #117 (`formatMs` exported from `utils.ts`) + PR #115 (`ResultRow` uses it)

---

## Notes

- **Score baseline:** Panel composite 6.0/10 at discovery. After PRs #111–117, all P0 and P1 items are resolved.
- **Remaining open:** 4 items — CHK-021 (expectationBreakdown visibility), CHK-022 (EvalRunMetadata plumbing), CHK-023 (CI badge), CHK-029 (prefers-reduced-motion). All are feature gaps or polish, not correctness bugs.
- **`llm_host` → `mcp_host` rename:** Completed in PR #123. `EvalMode`, `mcpHostConfig`, `mcpHostTrace`, all types and docs updated. `LLMProvider` intentionally preserved.
- **runData.metrics architectural question (resolved):** UI re-derives metrics from `results[]` for filter-correctness. `expectationBreakdown` visibility gap tracked as CHK-021 (feature request).
- **Pre-commit checklist for this repo:** Always run `npm run format && npm run typecheck && npm run lint` before committing — CI checks all three.
