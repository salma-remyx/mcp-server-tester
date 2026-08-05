import {
  type EvalDataset,
  type SerializedEvalDataset,
} from './datasetTypes.js';
import {
  type LoadDatasetOptions,
  loadEvalDatasetFromObject,
} from './datasetLoader.js';

/**
 * Built-in tool-learning benchmark dataset.
 *
 * Adapted from "Seal-Tools: Self-Instruct Tool Learning Dataset for Agent
 * Tuning and Detailed Benchmark" (arXiv:2405.08355). Seal-Tools pairs a
 * catalog of API-like tools with query→tool-call instances, including
 * deliberately *hard* instances that require composing multiple tools.
 *
 * That shape maps directly onto this framework's `EvalDataset` contract:
 * the tool catalog documents the surface under test, and each instance
 * becomes an `EvalCase` — either a deterministic `direct` regression case
 * (toolName + args) or an `mcp_host` discoverability case (scenario +
 * toolsTriggered). The hard multi-tool instances exercise the
 * `toolsTriggered` (multi-call) and `toolCallCount` assertions, which is
 * where this benchmark earns its keep over single-call cases.
 *
 * Scope note (Mode 2 — adapted port): the paper's *self-instruct generation
 * pipeline* and its separate benchmark harness are intentionally not ported.
 * The dataset is hand-authored against the verified `EvalDataset` schema and
 * run through the existing `loadEvalDatasetFromObject` validator instead of a
 * bespoke runner. What is preserved at fidelity is the paper's core artifact
 * — tools + instances + hard multi-tool cases — as in-pool eval data.
 */

/**
 * Difficulty band for a benchmark case.
 *
 * Mirrors Seal-Tools' split between single-tool (easy/medium) and the hard
 * multi-tool instances that stress tool-selection quality.
 */
export type BenchmarkDifficulty = 'easy' | 'medium' | 'hard';

/**
 * A single API-like tool in the benchmark catalog.
 *
 * Seal-Tools' contribution is a catalog of self-instruct *tools* alongside
 * their instances. This entry documents the synthetic tool surface the
 * benchmark assumes the server under test exposes.
 */
export interface BenchmarkToolEntry {
  /** Tool name, matching the `toolName` / `toolsTriggered.calls[].name` used in cases. */
  name: string;
  /** Short human-readable description of what the tool does. */
  description: string;
  /** Parameter name → human-readable description. */
  parameters: Record<string, string>;
}

/**
 * The Seal-Tools-inspired tool catalog.
 *
 * A representative slice of API-like tools spanning search, weather, math,
 * scheduling, translation, navigation, files, and vision. Cases below
 * reference these by name.
 */
export const sealToolsCatalog: BenchmarkToolEntry[] = [
  {
    name: 'web_search',
    description:
      'Search the web for a natural-language query and return ranked results.',
    parameters: { query: 'The search query', top_k: 'Max results to return' },
  },
  {
    name: 'get_weather',
    description: 'Return the current weather for a city.',
    parameters: {
      city: 'City name',
      units: 'Temperature units (metric or imperial)',
    },
  },
  {
    name: 'calculator',
    description:
      'Evaluate a arithmetic expression and return the numeric result.',
    parameters: { expression: 'A math expression, e.g. "18% * 47.50"' },
  },
  {
    name: 'calendar_create_event',
    description: 'Create a new event on the user calendar.',
    parameters: {
      title: 'Event title',
      start_time: 'ISO start timestamp',
      end_time: 'ISO end timestamp',
    },
  },
  {
    name: 'translate_text',
    description: 'Translate text into a target language.',
    parameters: {
      text: 'Text to translate',
      target_language: 'Target language code or name',
    },
  },
  {
    name: 'map_route',
    description: 'Compute a travel route between two locations.',
    parameters: {
      origin: 'Starting location',
      destination: 'Destination location',
    },
  },
  {
    name: 'file_read',
    description: 'Read the contents of a file at the given path.',
    parameters: { path: 'Absolute or relative file path' },
  },
  {
    name: 'image_describe',
    description: 'Return a natural-language description of an image.',
    parameters: { image_url: 'URL of the image to describe' },
  },
];

/**
 * The benchmark instances, expressed as eval cases.
 *
 * Mix of:
 * - `direct` regression cases (deterministic expectations on tool output)
 * - `mcp_host` single-tool discoverability cases
 * - `mcp_host` HARD multi-tool cases (the Seal-Tools "hard instances") that
 *   assert multiple tools are composed, optionally in strict order
 *
 * `tags` carry the difficulty band and category so existing runner/reporter
 * slicing (`filterTags`) works without any runner changes.
 */
const benchmarkCases: SerializedEvalDataset['cases'] = [
  // --- Easy: direct regression cases ---
  {
    id: 'calc-add',
    description: 'Calculator returns the sum of two numbers.',
    tags: ['easy', 'arithmetic'],
    expect: { containsText: ['4'], isError: false },
    toolName: 'calculator',
    args: { expression: '2 + 2' },
  },
  {
    id: 'weather-london',
    description: 'Weather tool returns a temperature for a city.',
    tags: ['easy', 'weather'],
    expect: {
      containsText: ['temperature'],
      isError: false,
      responseSize: { maxBytes: 10000 },
    },
    toolName: 'get_weather',
    args: { city: 'London', units: 'metric' },
  },
  {
    id: 'translate-hello',
    description: 'Translation tool returns the target-language word.',
    tags: ['easy', 'translation'],
    expect: { matchesPattern: '\\bhola\\b', isError: false },
    toolName: 'translate_text',
    args: { text: 'hello', target_language: 'es' },
  },
  {
    id: 'weather-missing-city',
    description:
      'Weather tool surfaces an error when a required argument is omitted.',
    tags: ['easy', 'weather', 'error-handling'],
    expect: { isError: true },
    toolName: 'get_weather',
    args: {},
  },
  // --- Medium: single-tool discoverability (mcp_host) ---
  {
    id: 'find-weather',
    mode: 'mcp_host',
    description: 'A rainy-day prompt should trigger the weather tool.',
    scenario: 'Should I bring an umbrella if I am walking in Seattle today?',
    tags: ['medium', 'tool-finding', 'weather'],
    mcpHostConfig: { provider: 'anthropic' },
    expect: {
      toolsTriggered: { calls: [{ name: 'get_weather', required: true }] },
    },
  },
  {
    id: 'compute-tip',
    mode: 'mcp_host',
    description: 'A tipping question should trigger the calculator tool.',
    scenario: 'What is an 18% tip on a $47.50 bill?',
    tags: ['medium', 'tool-finding', 'arithmetic'],
    mcpHostConfig: { provider: 'anthropic' },
    expect: {
      toolsTriggered: { calls: [{ name: 'calculator', required: true }] },
    },
  },
  // --- Hard: multi-tool composition (Seal-Tools "hard instances") ---
  {
    id: 'trip-plan',
    mode: 'mcp_host',
    description: 'Trip planning composes weather lookup with a driving route.',
    scenario:
      'Plan a day trip to Paris: look up the current weather and find a driving route from the airport (CDG) to the Eiffel Tower, then summarize.',
    tags: ['hard', 'multi-tool', 'planning'],
    mcpHostConfig: { provider: 'anthropic', maxToolCalls: 4 },
    expect: {
      toolsTriggered: {
        calls: [
          { name: 'get_weather', required: true },
          { name: 'map_route', required: true },
        ],
        order: 'any',
        exclusive: false,
      },
      toolCallCount: { min: 2, max: 4 },
    },
  },
  {
    id: 'translate-weather',
    mode: 'mcp_host',
    description:
      'Cross-tool pipeline: fetch weather, then translate the summary.',
    scenario:
      'Get the current weather for Tokyo and translate the summary into French.',
    tags: ['hard', 'multi-tool', 'translation'],
    mcpHostConfig: { provider: 'anthropic', maxToolCalls: 3 },
    expect: {
      toolsTriggered: {
        calls: [
          { name: 'get_weather', required: true },
          { name: 'translate_text', required: true },
        ],
        order: 'strict',
      },
      toolCallCount: { min: 2, max: 3 },
    },
  },
  {
    id: 'research-event',
    mode: 'mcp_host',
    description: 'Research a topic and schedule a follow-up calendar event.',
    scenario:
      'Find recent news about the Mars rover, then schedule a 30-minute calendar event tomorrow at 2pm to discuss the findings.',
    tags: ['hard', 'multi-tool', 'scheduling'],
    mcpHostConfig: { provider: 'anthropic', maxToolCalls: 4 },
    expect: {
      toolsTriggered: {
        calls: [
          { name: 'web_search', required: true },
          { name: 'calendar_create_event', required: true },
        ],
        order: 'any',
      },
      toolCallCount: { min: 2, max: 4 },
    },
  },
];

/**
 * Counts cases per difficulty band in a set of tags.
 *
 * @param cases - Eval cases whose `tags` may include a difficulty band
 * @returns A map of band → count
 */
export function countBenchmarkDifficulty(
  cases: SerializedEvalDataset['cases']
): Record<BenchmarkDifficulty, number> {
  const counts: Record<BenchmarkDifficulty, number> = {
    easy: 0,
    medium: 0,
    hard: 0,
  };
  for (const entry of cases) {
    for (const tag of entry.tags ?? []) {
      if (tag === 'easy' || tag === 'medium' || tag === 'hard') {
        counts[tag] += 1;
      }
    }
  }
  return counts;
}

/**
 * Builds the Seal-Tools-inspired tool-learning benchmark as a serialized
 * eval dataset.
 *
 * The returned object conforms to `SerializedEvalDataset` and is ready to be
 * validated by the existing `validateEvalDataset` / `loadEvalDatasetFromObject`
 * pipeline — no bespoke runner required.
 *
 * @returns The benchmark as a serializable eval dataset
 */
export function buildToolLearningBenchmark(): SerializedEvalDataset {
  return {
    name: 'seal-tools-tool-learning',
    description:
      'Tool-learning benchmark adapted from Seal-Tools: a tool catalog plus ' +
      'query→tool-call instances, including hard multi-tool composition cases.',
    cases: benchmarkCases,
    metadata: {
      toolCount: sealToolsCatalog.length,
      caseCount: benchmarkCases.length,
      bands: countBenchmarkDifficulty(benchmarkCases),
    },
  };
}

/**
 * Loads the tool-learning benchmark as a fully-typed, validated `EvalDataset`.
 *
 * This is the integration entry point: it runs the benchmark through the
 * existing `loadEvalDatasetFromObject` validator (which calls
 * `EvalDatasetSchema.parse`), proving the dataset satisfies the framework's
 * verified contract. Optional `schemas` are attached for any `schema`
 * expectations callers add later.
 *
 * @param options - Optional loader options (e.g. named Zod schemas)
 * @returns The validated benchmark dataset
 */
export function loadToolLearningBenchmark(
  options: LoadDatasetOptions = {}
): EvalDataset {
  return loadEvalDatasetFromObject(buildToolLearningBenchmark(), options);
}
