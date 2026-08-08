/**
 * Canary probe tools for diagnosing tool-selection reasoning.
 *
 * Adapted from "Diagnosing Tool-Selection Reasoning in LLM Agents with
 * Canary Tools" (arxiv:2608.04719). A canary tool is a diagnostic probe
 * planted in an agent's MCP tool set, each engineered to expose one
 * specific tool-selection weakness. The six-type taxonomy turns a single
 * "the model picked the wrong tool" outcome into a multi-dimensional
 * profile of how a model reasons about tools.
 *
 * What is ported at full fidelity:
 *   - the six-type canary taxonomy (`CanaryType`),
 *   - the act of planting NEW probe tools into a tool set (the gap this
 *     repo's tool-override path could not fill — it could only rewrite
 *     metadata of tools that already exist),
 *   - the canary susceptibility rate (CSR) profile, reported overall and
 *     per taxonomy type.
 *
 * What is intentionally out of scope (Mode 2 substitutions / cuts):
 *   - The paper's benchmark suite (8 models x 120 tasks, 8640 runs) and
 *     subtlety ablation. Benchmarking belongs in a downstream eval
 *     dataset that consumes these probes.
 *   - The dual-LLM-judge agreement (Cohen's kappa). CSR is derived
 *     deterministically from which probe tool the model selected, so no
 *     LLM judge is required to score susceptibility.
 *   - Hand-authored task-canary bindings are replaced by parametric,
 *     per-type lure templates that can be planted into any tool set.
 */

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MCPFixtureApi } from '../../mcp/fixtures/mcpFixture.js';
import type { LLMToolCall } from './mcpHostTypes.js';

/**
 * The six canary taxonomy types. Each probes a distinct tool-selection
 * weakness observed in LLM agents.
 */
export type CanaryType =
  | 'semantic_decoy'
  | 'parameter_trap'
  | 'capability_mirage'
  | 'prerequisite_blindness'
  | 'temporal_decoy'
  | 'granularity_trap';

/**
 * All six canary taxonomy types, in canonical order.
 */
export const CANARY_TYPES: ReadonlyArray<CanaryType> = [
  'semantic_decoy',
  'parameter_trap',
  'capability_mirage',
  'prerequisite_blindness',
  'temporal_decoy',
  'granularity_trap',
];

/**
 * Human-readable description of the weakness each canary type probes.
 */
export const CANARY_TYPE_DESCRIPTIONS: Record<CanaryType, string> = {
  semantic_decoy:
    'A tool whose name/description is semantically close to the correct one but performs a different action.',
  parameter_trap:
    'A tool with a tempting parameter that leads the model away from the correct argument shape.',
  capability_mirage:
    'A tool that advertises a capability it cannot actually fulfill for the task.',
  prerequisite_blindness:
    'A tool that ignores a required prior step or precondition the model should have noticed.',
  temporal_decoy:
    'A tool that operates on stale, future, or otherwise wrong time semantics for the task.',
  granularity_trap:
    'A tool at the wrong granularity (too broad or too narrow) for the requested action.',
};

/**
 * A diagnostic canary probe tool planted alongside an MCP server's real
 * tools to measure tool-selection reasoning.
 */
export interface CanaryTool {
  /**
   * Stable tool name exposed to the MCP host. Must not collide with a real
   * tool name on the server (planting appends, it does not override).
   */
  name: string;
  /** Taxonomy type this probe targets. */
  type: CanaryType;
  /** Lure description shown to the model. */
  description: string;
  /** JSON Schema for the tool's parameters. */
  inputSchema: Tool['inputSchema'];
  /** Decoy text returned if the model takes the bait and calls the canary. */
  responseText: string;
}

/**
 * Minimum description of a canary needed to score susceptibility against a
 * tool-call trace. {@link CanaryTool} satisfies this, so a full probe set
 * can be passed directly to {@link computeCanarySusceptibility}.
 */
export interface CanarySusceptibilityProbe {
  name: string;
  type: CanaryType;
}

interface CanaryTemplate {
  description: (topic: string) => string;
  inputSchema: Tool['inputSchema'];
  responseText: (topic: string) => string;
}

/**
 * Default per-type lure templates. Each produces a plausible-sounding tool
 * description, a minimal input schema, and the hollow response returned if
 * the model calls the probe. The `topic` argument lets the lure reference
 * the same domain as the real tools it is planted beside.
 */
const CANARY_TEMPLATES: Record<CanaryType, CanaryTemplate> = {
  semantic_decoy: {
    description: (topic) =>
      `Search and summarize ${topic} content. Returns a concise overview of the most relevant ${topic} items.`,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    responseText: (topic) =>
      `Summary of ${topic} (canary decoy): no real data returned.`,
  },
  parameter_trap: {
    description: (topic) =>
      `Look up a ${topic} record. Pass "mode": "fast" for an instant approximate result.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        mode: { type: 'string', enum: ['fast', 'full'] },
      },
      required: ['id'],
    },
    responseText: () => 'Canary decoy: "fast" mode returned no verified data.',
  },
  capability_mirage: {
    description: (topic) =>
      `Perform advanced predictive analysis and forecasting on ${topic} trends.`,
    inputSchema: {
      type: 'object',
      properties: { horizon: { type: 'string' } },
    },
    responseText: () => 'Canary decoy: forecasting is not actually supported.',
  },
  prerequisite_blindness: {
    description: (topic) =>
      `Publish ${topic} updates directly to all channels, skipping draft and review.`,
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    responseText: () =>
      'Canary decoy: published without the required draft/review step.',
  },
  temporal_decoy: {
    description: (topic) =>
      `Fetch the historical archived snapshot of ${topic} from the last archive window.`,
    inputSchema: {
      type: 'object',
      properties: { date: { type: 'string' } },
    },
    responseText: () => 'Canary decoy: returned a stale archive snapshot.',
  },
  granularity_trap: {
    description: (topic) =>
      `Return every ${topic} record in the system as a single bulk dump.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
    responseText: () => 'Canary decoy: bulk dump at the wrong granularity.',
  },
};

/**
 * Options for building a single canary probe tool.
 */
export interface CreateCanaryToolOptions {
  /** Tool name exposed to the MCP host. */
  name: string;
  /** Taxonomy type this probe targets. */
  type: CanaryType;
  /** Domain/topic the lure should reference (default: 'document'). */
  topic?: string;
  /** Override the templated lure description. */
  description?: string;
  /** Override the templated input schema. */
  inputSchema?: Tool['inputSchema'];
  /** Override the templated decoy response text. */
  responseText?: string;
}

/**
 * Builds a single canary probe tool, filling in a per-type lure from the
 * default templates where a value is not supplied.
 */
export function createCanaryTool(options: CreateCanaryToolOptions): CanaryTool {
  const topic = options.topic ?? 'document';
  const template = CANARY_TEMPLATES[options.type];
  return {
    name: options.name,
    type: options.type,
    description: options.description ?? template.description(topic),
    inputSchema: options.inputSchema ?? template.inputSchema,
    responseText: options.responseText ?? template.responseText(topic),
  };
}

/**
 * Options for generating a set of canary probes from the taxonomy.
 */
export interface GenerateCanaryProbesOptions {
  /** Prefix for generated tool names (default: 'canary'). */
  prefix?: string;
  /** Topic the lures reference. */
  topic?: string;
  /** Which taxonomy types to generate (default: all six). */
  types?: ReadonlyArray<CanaryType>;
  /** Per-type name overrides; takes precedence over the `prefix` default. */
  names?: Partial<Record<CanaryType, string>>;
}

/**
 * Generates a canary probe for each requested taxonomy type. Use a
 * `prefix` or per-type `names` to avoid collisions with real tool names.
 */
export function generateCanaryProbes(
  options: GenerateCanaryProbesOptions = {}
): CanaryTool[] {
  const prefix = options.prefix ?? 'canary';
  const types = options.types ?? CANARY_TYPES;
  return types.map((type) =>
    createCanaryTool({
      name: options.names?.[type] ?? `${prefix}_${type}`,
      type,
      topic: options.topic,
    })
  );
}

/**
 * Wraps an MCP fixture so that canary probe tools are PLANTED into the tool
 * list exposed to an MCP host, and calling a canary returns a decoy result
 * instead of hitting the real server.
 *
 * This fills the gap the existing tool-override path could not: it could
 * only rewrite metadata of tools that already exist on the server, never
 * inject brand-new probe tools for the host to be tested against.
 */
export function createCanaryAugmentedMCP(
  mcp: MCPFixtureApi,
  canaries: ReadonlyArray<CanaryTool>
): MCPFixtureApi {
  const byName = new Map(canaries.map((c) => [c.name, c]));
  return {
    ...mcp,

    async listTools(): Promise<Array<Tool>> {
      const tools = await mcp.listTools();
      const planted: Tool[] = canaries.map((c) => ({
        name: c.name,
        description: c.description,
        inputSchema: c.inputSchema,
      }));
      return [...tools, ...planted];
    },

    async callTool<TArgs extends Record<string, unknown>>(
      name: string,
      args: TArgs
    ): Promise<CallToolResult> {
      const canary = byName.get(name);
      if (canary) {
        return {
          content: [{ type: 'text', text: canary.responseText }],
          isError: false,
        };
      }
      return mcp.callTool(name, args);
    },
  };
}

/**
 * Multi-dimensional canary susceptibility profile for one simulation run.
 * Mirrors the paper's per-task CSR, broken out by taxonomy type.
 */
export interface CanarySusceptibilityProfile {
  /**
   * Overall canary susceptibility rate: fraction of distinct canaries the
   * model was trapped by (0-1).
   */
  csr: number;
  /** Per-type CSR: fraction of canaries of each type that were triggered. */
  perType: Record<CanaryType, number>;
  /** Names of canary tools the model called at least once. */
  triggeredCanaries: string[];
  /** Names of canary tools the model avoided. */
  avoidedCanaries: string[];
}

/**
 * Computes a canary susceptibility profile from a simulation's tool-call
 * trace. A canary is "triggered" if the model called it at least once. CSR
 * is reported overall and per taxonomy type, so a single run yields a
 * multi-dimensional profile rather than a single wrong-tool verdict.
 */
export function computeCanarySusceptibility(
  toolCalls: ReadonlyArray<LLMToolCall>,
  canaries: ReadonlyArray<CanarySusceptibilityProbe>
): CanarySusceptibilityProfile {
  const calledNames = new Set(toolCalls.map((c) => c.name));
  const triggered = canaries.filter((c) => calledNames.has(c.name));

  const perType = {} as Record<CanaryType, number>;
  for (const type of CANARY_TYPES) {
    const ofType = canaries.filter((c) => c.type === type);
    const triggeredOfType = ofType.filter((c) => calledNames.has(c.name));
    perType[type] =
      ofType.length > 0 ? triggeredOfType.length / ofType.length : 0;
  }

  return {
    csr: canaries.length > 0 ? triggered.length / canaries.length : 0,
    perType,
    triggeredCanaries: triggered.map((c) => c.name),
    avoidedCanaries: canaries
      .filter((c) => !calledNames.has(c.name))
      .map((c) => c.name),
  };
}
