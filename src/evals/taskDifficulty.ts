/**
 * MCP tool-use task-difficulty taxonomy and classifier.
 *
 * Adapted from MCP-Universe (https://arxiv.org/abs/2508.14704v1), which
 * organizes its benchmark of real-world MCP servers into difficulty tiers
 * reflecting the two axes that drive real-world tool-use difficulty:
 *
 *   1. the size of the available tool/server space (large, unfamiliar tool
 *      spaces are harder to navigate), and
 *   2. the reasoning horizon (single hop -> multi-step -> long-horizon).
 *
 * This ports that taxonomy onto the repo's existing `EvalCase` shape so a
 * benchmark can be sliced and reported by difficulty tier through the existing
 * `runEvalDataset` pipeline, with no separate eval framework. The paper
 * annotates tiers by hand; here the tier is *computed* from a case's `expect`
 * block (tool span / call budget), with an explicit override for the
 * multi-server tier that a single `EvalCase` cannot structurally express
 * (one MCP connection is one server in this repo's model).
 */
import type { EvalCase } from './datasetTypes.js';

/**
 * Difficulty tier for an MCP tool-use task.
 *
 * - `single-tool`  — solvable with one tool call (single hop).
 * - `multi-tool`   — requires several tools / steps within a server.
 * - `multi-server` — long-horizon reasoning spanning multiple servers.
 */
export type TaskDifficultyTier = 'single-tool' | 'multi-tool' | 'multi-server';

/**
 * All tiers in ascending difficulty order.
 */
export const DIFFICULTY_TIERS: readonly TaskDifficultyTier[] = [
  'single-tool',
  'multi-tool',
  'multi-server',
] as const;

/** Tag prefix used to carry a tier on a case's `tags` array. */
export const DIFFICULTY_TAG_PREFIX = 'difficulty:';

/**
 * Narrows an arbitrary value (e.g. from `metadata.difficultyTier` or a parsed
 * tag) to a known tier.
 */
export function isTaskDifficultyTier(
  value: unknown
): value is TaskDifficultyTier {
  return (
    typeof value === 'string' &&
    (DIFFICULTY_TIERS as readonly string[]).includes(value)
  );
}

// Scenario phrasing that implies coordination across more than one backing
// service — the strongest available signal for the multi-server tier.
const CROSS_SERVER_KEYWORDS = [
  'across both',
  'across all',
  'both servers',
  'multiple servers',
  'cross-server',
  'each server',
  'and the github server',
  'and the slack',
] as const;

function distinctToolNames(evalCase: EvalCase): Set<string> {
  const calls = evalCase.expect?.toolsTriggered?.calls ?? [];
  return new Set(calls.map((c) => c.name));
}

/**
 * Best-effort estimate of how many distinct tools a scenario exercises, taken
 * from the larger of the distinct expected-tool set and the minimum call count.
 */
function effectiveToolSpan(evalCase: EvalCase): number {
  const toolCount = distinctToolNames(evalCase).size;
  const minCalls = evalCase.expect?.toolCallCount?.min;
  const fromCount = typeof minCalls === 'number' ? minCalls : 0;
  return Math.max(toolCount, fromCount);
}

function tierFromTag(tags: string[] | undefined): TaskDifficultyTier | null {
  if (!tags) return null;
  for (const tag of tags) {
    if (tag.startsWith(DIFFICULTY_TAG_PREFIX)) {
      const candidate = tag.slice(DIFFICULTY_TAG_PREFIX.length);
      if (isTaskDifficultyTier(candidate)) return candidate;
    }
  }
  return null;
}

function scenarioLooksCrossServer(evalCase: EvalCase): boolean {
  if (evalCase.metadata?.crossServer === true) return true;
  const text = [evalCase.scenario, evalCase.description]
    .filter((s): s is string => typeof s === 'string')
    .join(' ')
    .toLowerCase();
  if (!text) return false;
  return CROSS_SERVER_KEYWORDS.some((kw) => text.includes(kw));
}

/**
 * Classifies an `EvalCase` into a difficulty tier.
 *
 * Resolution order:
 *   1. `metadata.difficultyTier` — explicit author override.
 *   2. A `difficulty:<tier>` tag.
 *   3. Cross-server heuristics on the scenario/description (`multi-server`).
 *   4. A large `toolCallCount.max` budget (`multi-tool` — long horizon).
 *   5. Tool span: one tool -> `single-tool`, more than one -> `multi-tool`.
 *
 * Defaults to `single-tool` when a case carries no difficulty signal at all
 * (e.g. a plain direct-mode regression check).
 */
export function classifyTaskDifficulty(evalCase: EvalCase): TaskDifficultyTier {
  // Explicit override wins — the case author knows the intended tier, which
  // matters for multi-server scenarios a single EvalCase cannot express.
  const override = evalCase.metadata?.difficultyTier;
  if (isTaskDifficultyTier(override)) return override;

  const fromTag = tierFromTag(evalCase.tags);
  if (fromTag !== null) return fromTag;

  if (scenarioLooksCrossServer(evalCase)) return 'multi-server';

  // A large call budget implies a long reasoning horizon even when the
  // distinct tool set is small (e.g. iterate-then-refine loops).
  const maxCalls = evalCase.expect?.toolCallCount?.max;
  if (typeof maxCalls === 'number' && maxCalls >= 5) return 'multi-tool';

  return effectiveToolSpan(evalCase) <= 1 ? 'single-tool' : 'multi-tool';
}

/**
 * The `difficulty:<tier>` tag form, for slicing a benchmark run via the
 * existing `filterTags` option without opting into the computed classifier.
 */
export function difficultyTierTag(tier: TaskDifficultyTier): string {
  return `${DIFFICULTY_TAG_PREFIX}${tier}`;
}

/**
 * Returns only the cases whose computed tier is in `tiers`.
 */
export function sliceByDifficulty(
  cases: readonly EvalCase[],
  tiers: readonly TaskDifficultyTier[]
): EvalCase[] {
  const wanted = new Set<TaskDifficultyTier>(tiers);
  return cases.filter((c) => wanted.has(classifyTaskDifficulty(c)));
}

/**
 * Groups cases into buckets by computed tier. Useful for reporting the
 * per-difficulty breakdown of a benchmark run.
 */
export function groupCasesByDifficulty(
  cases: readonly EvalCase[]
): Record<TaskDifficultyTier, EvalCase[]> {
  const groups: Record<TaskDifficultyTier, EvalCase[]> = {
    'single-tool': [],
    'multi-tool': [],
    'multi-server': [],
  };
  for (const evalCase of cases) {
    groups[classifyTaskDifficulty(evalCase)].push(evalCase);
  }
  return groups;
}
