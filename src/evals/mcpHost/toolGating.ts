/**
 * Tool gating + lazy schema loading for the MCP host injection layer.
 *
 * MCP exposes every tool's full JSON Schema to the host LLM on every turn of
 * the agentic loop (the Vercel adapter builds an eager `tools` map and passes
 * it to `generateText`). In multi-server deployments this payload — the
 * "tools tax" — runs to tens of thousands of tokens per turn, inflating the
 * KV cache and degrading reasoning as context utilization climbs.
 *
 * This module implements the two deflation mechanisms from "Tool Attention Is
 * All You Need: Dynamic Tool Gating and Lazy Schema Loading for Eliminating
 * the MCP/Tools Tax in Scalable Agentic Workflows" (arXiv:2604.21816):
 *
 *   1. Dynamic tool gating — only the scenario-relevant subset of the catalog
 *      is exposed to the LLM, dropping irrelevant tools from the payload.
 *   2. Lazy schema loading — each exposed tool ships a trimmed schema skeleton
 *      (property names + top-level types) in the prompt; verbose detail
 *      (nested descriptions, long enums, nested object schemas) is deferred
 *      and reconstructed by the MCP server at call time.
 *
 * Adapted port (Mode 2): the paper's learned tool-attention / gating model is
 * replaced with a parameter-free lexical relevance proxy (scenario ↔ tool
 * token overlap), and its separate retrieval index for lazy schemas is
 * replaced with a deterministic in-process trim. The core mechanism — shrink
 * the per-turn schema-injection payload — is preserved at full fidelity.
 * Evaluation of downstream discoverability/quality belongs in a later PR.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * Optional knobs for tool gating + lazy schema loading at the SDK host
 * injection layer. Every field is optional; setting none of them leaves the
 * full catalog exposed untouched (gating is opt-in).
 */
export interface ToolGatingConfig {
  /**
   * Maximum number of tools to expose to the LLM after relevance ranking.
   * The highest-relevance tools are kept first. `0` exposes no tools.
   */
  maxTools?: number;

  /**
   * Minimum normalized relevance score (0–1) required to keep a tool. A tool's
   * score is the fraction of scenario tokens it covers; `0.1` means a tool
   * must match at least 10% of the scenario's keywords. Defaults to `0`
   * (keep everything unless `maxTools` caps it).
   */
  minRelevance?: number;

  /**
   * When true, each exposed tool ships a trimmed schema skeleton (property
   * names + top-level types) instead of its full JSON Schema, deferring
   * verbose detail to the MCP server's call-time validation. @default false
   */
  lazySchema?: boolean;

  /**
   * Tool names to always keep regardless of relevance score (e.g. tools a
   * scenario is expected to require). They still count toward `maxTools`.
   */
  alwaysInclude?: string[];
}

/**
 * Per-tool relevance score and gating decision.
 */
export interface ToolScore {
  /** Tool name. */
  name: string;
  /** Normalized relevance to the scenario, in [0, 1]. */
  relevance: number;
  /** Whether the tool was exposed to the LLM after gating. */
  kept: boolean;
}

/**
 * Observable report on a gating pass, surfaced on the simulation result so a
 * test can assert which tools were gated in/out and how the payload shrank.
 */
export interface ToolGatingReport {
  /** Whether gating was applied (false when no config was supplied). */
  enabled: boolean;
  /** Number of tools in the full catalog. */
  originalCount: number;
  /** Number of tools exposed to the LLM after gating. */
  exposedCount: number;
  /** Tool names dropped from the payload. */
  droppedNames: string[];
  /** Whether lazy (trimmed) schemas were shipped. */
  lazySchema: boolean;
  /** Relevance score + kept flag for every tool in the catalog. */
  scores: ToolScore[];
}

/**
 * Common English stopwords excluded from relevance matching so that filler
 * words in a scenario ("the", "for", "with") do not anchor tool selection.
 */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'your',
  'you',
  'are',
  'was',
  'but',
  'not',
  'all',
  'can',
  'has',
  'have',
  'our',
  'its',
  'into',
  'about',
  'what',
  'when',
  'how',
  'use',
  'using',
  'get',
  'find',
  'need',
  'of',
  'in',
  'to',
  'is',
  'it',
  'on',
  'as',
  'at',
  'by',
  'an',
  'or',
]);

/**
 * Tokenizes free text for lexical relevance matching: lowercases, splits
 * camelCase / snake_case / kebab-case / punctuation boundaries, and drops
 * stopwords and single characters. Exported so the scoring heuristic is
 * unit-testable in isolation.
 */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

/**
 * Scores a single tool's relevance to a scenario as the fraction of scenario
 * tokens covered by the tool's name + description tokens. Returns a value in
 * [0, 1]; 0 means no overlap.
 */
export function scoreToolRelevance(
  scenarioTokens: string[],
  tool: Tool
): number {
  if (scenarioTokens.length === 0) {
    return 0;
  }
  const toolTokens = new Set<string>([
    ...tokenize(tool.name),
    ...tokenize(tool.description ?? ''),
  ]);
  let matched = 0;
  for (const token of scenarioTokens) {
    if (toolTokens.has(token)) {
      matched++;
    }
  }
  return matched / scenarioTokens.length;
}

function roundTo3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Applies dynamic tool gating: ranks the catalog by scenario relevance and
 * keeps the subset satisfying `minRelevance` / `maxTools` / `alwaysInclude`.
 * Schemas are left untouched here (see {@link trimToolSchema}). Returns both
 * the kept tools and a full per-tool score breakdown for reporting.
 */
export function gateTools(
  scenario: string,
  tools: Tool[],
  config: ToolGatingConfig
): { tools: Tool[]; scores: ToolScore[] } {
  const scenarioTokens = tokenize(scenario);
  const alwaysKeep = new Set(config.alwaysInclude ?? []);
  const minRelevance = config.minRelevance ?? 0;

  const scored = tools.map((tool) => ({
    tool,
    name: tool.name,
    relevance: scoreToolRelevance(scenarioTokens, tool),
    forced: alwaysKeep.has(tool.name),
  }));

  const kept = scored.filter(
    (entry) => entry.forced || entry.relevance >= minRelevance
  );
  kept.sort((a, b) => b.relevance - a.relevance);

  const capped =
    config.maxTools != null && config.maxTools >= 0
      ? kept.slice(0, config.maxTools)
      : kept;
  const keptNames = new Set(capped.map((entry) => entry.name));

  const scores = scored
    .slice()
    .sort((a, b) => b.relevance - a.relevance)
    .map((entry) => ({
      name: entry.name,
      relevance: roundTo3(entry.relevance),
      kept: keptNames.has(entry.name),
    }));

  return { tools: capped.map((entry) => entry.tool), scores };
}

/**
 * Trims a JSON Schema to a lightweight skeleton: keeps `type: 'object'`, the
 * `required` array, and each property's name with only its top-level `type`.
 * Drops nested descriptions, long enums, nested object/array schemas, and
 * format hints — the heavy detail that dominates schema token cost. The MCP
 * server re-validates against the full schema at call time, so deferring it
 * loses nothing on the execution path.
 */
export function trimToolSchema(
  schema: Record<string, unknown>
): Record<string, unknown> {
  const trimmed: Record<string, unknown> = { type: 'object' };
  const properties = schema.properties;
  if (properties && typeof properties === 'object') {
    const trimmedProperties: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(
      properties as Record<string, unknown>
    )) {
      trimmedProperties[key] = trimProperty(raw);
    }
    trimmed.properties = trimmedProperties;
  }
  if (Array.isArray(schema.required)) {
    trimmed.required = schema.required;
  }
  return trimmed;
}

function trimProperty(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    const property = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if ('type' in property) {
      out.type = property.type;
    }
    if (Array.isArray(property.required)) {
      out.required = property.required;
    }
    return out;
  }
  return {};
}

/**
 * End-to-end gating + lazy schema pass invoked at the host injection layer.
 *
 * With no config this is a no-op returning the full catalog (gating is
 * opt-in). Otherwise it gates the catalog by scenario relevance and, when
 * `lazySchema` is set, replaces each kept tool's schema with a trimmed
 * skeleton. The returned report records the gating decision for observability.
 */
export function buildGatedTools(
  scenario: string,
  tools: Tool[],
  config?: ToolGatingConfig
): { tools: Tool[]; report: ToolGatingReport } {
  if (!config) {
    return {
      tools,
      report: {
        enabled: false,
        originalCount: tools.length,
        exposedCount: tools.length,
        droppedNames: [],
        lazySchema: false,
        scores: [],
      },
    };
  }

  const lazySchema = config.lazySchema === true;
  const { tools: gated, scores } = gateTools(scenario, tools, config);

  const exposed: Tool[] = lazySchema
    ? gated.map(
        (tool) =>
          ({
            ...tool,
            inputSchema: trimToolSchema(
              tool.inputSchema as Record<string, unknown>
            ),
          }) as Tool
      )
    : gated;

  const keptNames = new Set(gated.map((tool) => tool.name));
  const droppedNames = tools
    .map((tool) => tool.name)
    .filter((name) => !keptNames.has(name));

  return {
    tools: exposed,
    report: {
      enabled: true,
      originalCount: tools.length,
      exposedCount: exposed.length,
      droppedNames,
      lazySchema,
      scores,
    },
  };
}
