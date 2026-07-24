/**
 * Curated long-horizon MCP tool-use benchmark, adapted from MCP-Universe
 * (https://arxiv.org/abs/2508.14704v1).
 *
 * MCP-Universe curates real-world MCP servers and tasks organized into
 * difficulty tiers (single-tool -> multi-tool -> multi-server). This ports a
 * representative slice of that benchmark into the repo's `EvalDataset` shape so
 * it runs through the existing `runEvalDataset` pipeline and slices by tier via
 * `difficultyFilter` (or the `difficulty:<tier>` tags).
 *
 * Mode 2 adaptation:
 *   - The paper's 100+ hosted servers are replaced by a small, extensible
 *     sample spanning the tiers. Plug in your own servers by editing the cases
 *     below or passing overrides to `buildBenchmarkDataset()`.
 *   - Each case is a plain `mcp_host` scenario — no bespoke benchmark harness
 *     is reproduced (the repo already provides one).
 *
 * These cases run an LLM host against whichever MCP server the test fixture is
 * connected to, so they make real API calls. Slice by tier to keep a CI smoke
 * run cheap (`difficultyFilter: ['single-tool']`) and reserve the long-horizon
 * tiers for release gates.
 */
import {
  type EvalCase,
  type EvalDataset,
  validateEvalDataset,
} from './datasetTypes.js';
import type { MCPHostConfig } from './mcpHost/mcpHostTypes.js';
import {
  classifyTaskDifficulty,
  type TaskDifficultyTier,
} from './taskDifficulty.js';

/** LLM provider driving the mcp_host scenarios. */
type BenchmarkProvider = NonNullable<MCPHostConfig['provider']>;

/**
 * Options for {@link buildBenchmarkDataset}.
 */
export interface BenchmarkDatasetOptions {
  /** LLM provider for every mcp_host scenario. @default 'anthropic' */
  provider?: BenchmarkProvider;
  /** Model id forwarded to the host. */
  model?: string;
  /** Iterations per case for accuracy measurement. @default 10 */
  iterations?: number;
  /** Minimum pass rate (0-1) required for a case to pass. @default 0.8 */
  accuracyThreshold?: number;
  /** Restrict the dataset to a subset of difficulty tiers. */
  tiers?: TaskDifficultyTier[];
}

const DEFAULT_PROVIDER: BenchmarkProvider = 'anthropic';
const DEFAULT_ITERATIONS = 10;
const DEFAULT_ACCURACY_THRESHOLD = 0.8;

/**
 * Raw benchmark cases before provider/iteration overrides are applied.
 *
 * Each case carries a `difficulty:<tier>` tag (the canonical tier label, which
 * also slices through `filterTags`) and structural expectations consistent with
 * that tier, so the computed classifier and the declared tag agree.
 */
const RAW_CASES: ReadonlyArray<EvalCase> = [
  // --- single-tool (Level 1) ---
  {
    id: 'mu-s1-read-readme',
    mode: 'mcp_host',
    scenario:
      'Read the file README.md from the filesystem server and return its first top-level heading.',
    expect: {
      toolsTriggered: {
        calls: [{ name: 'read_file', required: true }],
      },
      toolCallCount: { min: 1, max: 2 },
    },
    tags: ['difficulty:single-tool', 'filesystem', 'read'],
    canonicalAnswer: 'The first top-level heading of README.md.',
  },
  {
    id: 'mu-s2-web-search',
    mode: 'mcp_host',
    scenario:
      "Search the web for 'Model Context Protocol' using the search server and report the title of the top result.",
    expect: {
      toolsTriggered: {
        calls: [{ name: 'web_search', required: true }],
      },
      toolCallCount: { min: 1, max: 2 },
    },
    tags: ['difficulty:single-tool', 'search', 'web'],
  },
  // --- multi-tool (Level 2) ---
  {
    id: 'mu-m1-count-exports',
    mode: 'mcp_host',
    scenario:
      'List the TypeScript files under the src/ directory, then determine how many of them export a function named runEvalDataset.',
    expect: {
      toolsTriggered: {
        calls: [
          { name: 'list_directory', required: true },
          { name: 'read_file', required: true },
        ],
        order: 'strict',
      },
      toolCallCount: { min: 2, max: 8 },
    },
    tags: ['difficulty:multi-tool', 'filesystem', 'multi-step'],
  },
  {
    id: 'mu-m2-summarize-issues',
    mode: 'mcp_host',
    scenario:
      'Find the most recent issues labeled "bug" in the repository, then summarize the top three by title and status.',
    expect: {
      toolsTriggered: {
        calls: [
          { name: 'search_issues', required: true },
          { name: 'get_issue', required: true },
        ],
      },
      toolCallCount: { min: 2, max: 6 },
    },
    tags: ['difficulty:multi-tool', 'github', 'summarize'],
  },
  // --- multi-server (Level 3) ---
  {
    id: 'mu-x1-version-crosscheck',
    mode: 'mcp_host',
    scenario:
      'Using both the filesystem server and the github server, read the local package.json version and cross-check it against the latest release tag on GitHub.',
    expect: {
      toolsTriggered: {
        calls: [
          { name: 'read_file', required: true },
          { name: 'get_latest_release', required: true },
        ],
      },
      toolCallCount: { min: 2, max: 6 },
    },
    tags: ['difficulty:multi-server', 'filesystem', 'github', 'cross-server'],
    metadata: { crossServer: true },
    canonicalAnswer:
      'Whether the local package.json version matches the latest GitHub release tag.',
  },
  {
    id: 'mu-x2-search-save-notify',
    mode: 'mcp_host',
    scenario:
      'Search the web for a given topic across multiple servers: fetch the top result, save a one-paragraph summary to a file on the filesystem server, then post that summary to a Slack channel.',
    expect: {
      toolsTriggered: {
        calls: [
          { name: 'web_search', required: true },
          { name: 'write_file', required: true },
          { name: 'post_message', required: true },
        ],
        order: 'strict',
      },
      toolCallCount: { min: 3, max: 8 },
    },
    tags: [
      'difficulty:multi-server',
      'search',
      'filesystem',
      'slack',
      'cross-server',
    ],
    metadata: { crossServer: true },
  },
];

/**
 * The full benchmark dataset with default provider/iteration settings.
 *
 * Validated against {@link EvalDatasetSchema} at load time via
 * {@link loadBenchmarkDataset}.
 */
export const benchmarkDataset: EvalDataset = buildBenchmarkDataset({});

/**
 * Builds a benchmark dataset, optionally overriding the LLM provider, model,
 * iteration count, accuracy threshold, and tier subset.
 *
 * @example
 * ```typescript
 * // Cheap CI smoke run: single-tool tier only, fewer iterations
 * const dataset = buildBenchmarkDataset({
 *   provider: 'openai',
 *   iterations: 5,
 *   tiers: ['single-tool'],
 * });
 * await runEvalDataset({ dataset }, { mcp, testInfo });
 * ```
 */
export function buildBenchmarkDataset(
  options: BenchmarkDatasetOptions = {}
): EvalDataset {
  const provider = options.provider ?? DEFAULT_PROVIDER;
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const accuracyThreshold =
    options.accuracyThreshold ?? DEFAULT_ACCURACY_THRESHOLD;

  const wantedTiers = options.tiers
    ? new Set<TaskDifficultyTier>(options.tiers)
    : null;

  const mcpHostConfig: MCPHostConfig = {
    provider,
    ...(options.model ? { model: options.model } : null),
  };

  const cases: EvalCase[] = RAW_CASES.filter(
    (raw) => !wantedTiers || wantedTiers.has(classifyTaskDifficulty(raw))
  ).map((raw) => ({
    ...raw,
    mcpHostConfig,
    iterations,
    accuracyThreshold,
  }));

  return {
    name: 'mcp-universe-benchmark',
    description:
      'Long-horizon MCP tool-use benchmark adapted from MCP-Universe (arXiv:2508.14704), sliced by difficulty tier.',
    cases,
    metadata: {
      source: 'https://arxiv.org/abs/2508.14704',
      tiers: Array.from(new Set(cases.map((c) => classifyTaskDifficulty(c)))),
    },
  };
}

/**
 * Returns the benchmark dataset validated through {@link validateEvalDataset},
 * mirroring the `loadEvalDataset` round-trip. Throws if the shape ever drifts
 * from the Zod schema.
 */
export function loadBenchmarkDataset(
  options: BenchmarkDatasetOptions = {}
): EvalDataset {
  const dataset = buildBenchmarkDataset(options);
  // Strip the non-serializable schemas field before validating the JSON shape.
  const { schemas: _schemas, ...serializable } = dataset;
  validateEvalDataset(serializable);
  return dataset;
}
