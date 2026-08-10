/**
 * Canary probe tools — diagnostic decoys planted in an agent's tool set.
 *
 * Each canary mirrors a real tool's surface (name/description/schema) but
 * encodes one specific tool-selection weakness from a six-type taxonomy. By
 * injecting canaries into the tool set an MCP host offers an LLM and then
 * observing which canaries the agent calls, a single "picked the wrong tool"
 * outcome becomes a multi-dimensional profile of how the model reasons about
 * tools.
 *
 * Adapted (Mode 2) from "Diagnosing Tool-Selection Reasoning in LLM Agents
 * with Canary Tools" (arXiv:2608.04719). The paper's CORE mechanism — the
 * six-type taxonomy, mirroring synthesis, and the Canary Susceptibility Rate
 * (CSR) — is kept at full fidelity. The paper's auxiliary machinery is
 * substituted with target-native equivalents:
 *   - judge-graded task success  → parameter-free CSR proxy computed from
 *     whether canary tool names appear in the observed tool calls;
 *   - the 120-task benchmark suite and multi-judge agreement study → out of
 *     scope (evaluation belongs in a downstream PR);
 *   - the subtlety ablation → retained as the `subtlety` option that softens
 *     each canary's give-away phrase.
 */

import type {
  CanaryInjectionOptions,
  CanarySusceptibilityReport,
  CanaryType,
  CanaryTypeStat,
  LLMToolCall,
} from './mcpHostTypes.js';

/** The six canary types, in canonical (paper) order. */
export const CANARY_TYPES: readonly CanaryType[] = [
  'semantic-decoy',
  'parameter-trap',
  'capability-mirage',
  'prerequisite-blindness',
  'temporal-decoy',
  'granularity-trap',
];

/**
 * Minimal structural view of a real MCP tool that canaries mirror. The SDK's
 * `Tool` type satisfies this, so `mcp.listTools()` output can be passed
 * directly without coupling this module to the SDK runtime.
 */
export interface CanarySeedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** A synthesized canary probe tool. */
export interface CanaryTool {
  /** Synthesized tool name (prefixed so it is detectable in tool calls). */
  name: string;
  /** The weakness this canary probes. */
  type: CanaryType;
  /** The real tool this canary mirrors. */
  mirrorToolName: string;
  /** Tool description presented to the LLM. */
  description: string;
  /** JSON Schema for the tool's parameters. */
  inputSchema: Record<string, unknown>;
  /** The phrase that reveals the trap; softened when `subtlety` is `'subtle'`. */
  giveAwayPhrase: string;
}

/**
 * A canary entry in the Vercel AI SDK tool map. Matches the shape of real
 * tool entries built by the SDK orchestrator.
 */
export interface CanaryVercelEntry {
  description: string;
  inputSchema: unknown;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

function describeSeed(seed: CanarySeedTool): string {
  return seed.description?.trim() || `the ${seed.name} tool`;
}

function tagFor(type: CanaryType): string {
  // First word of the dash-joined type: 'semantic', 'parameter', ...
  return type.split('-')[0] ?? type;
}

/**
 * Builds one canary by transforming a real tool's surface to encode the
 * given weakness. Pure and deterministic.
 */
function synthesizeOne(
  type: CanaryType,
  seed: CanarySeedTool,
  subtlety: 'plain' | 'subtle',
  prefix: string
): CanaryTool {
  const name = `${prefix}_${tagFor(type)}_${seed.name}`;
  const baseDesc = describeSeed(seed);
  const baseSchema: Record<string, unknown> = {
    type: 'object',
    ...seed.inputSchema,
  };

  switch (type) {
    case 'semantic-decoy': {
      // Sounds like the right tool but operates on a different domain.
      const giveAway =
        subtlety === 'plain'
          ? 'Scope: only operates on archived historical records, not live or current data.'
          : 'Scope: results may include archived entries alongside current ones.';
      return makeCanary(
        name,
        type,
        seed.name,
        `${baseDesc} (variant). ${giveAway}`,
        baseSchema,
        giveAway
      );
    }
    case 'parameter-trap': {
      // Tempting extra parameter with a foot-gun default.
      const giveAway =
        subtlety === 'plain'
          ? 'Defaults to mode="fast", which returns approximate, lower-fidelity results.'
          : 'An optional mode parameter tunes result fidelity.';
      const existing =
        (baseSchema.properties as Record<string, unknown> | undefined) ?? {};
      const schema: Record<string, unknown> = {
        ...baseSchema,
        properties: {
          ...existing,
          mode: {
            type: 'string',
            enum: ['fast', 'accurate'],
            default: 'fast',
            description: 'Result fidelity. "fast" is approximate.',
          },
        },
      };
      return makeCanary(
        name,
        type,
        seed.name,
        `${baseDesc} (configurable). ${giveAway}`,
        schema,
        giveAway
      );
    }
    case 'capability-mirage': {
      // Over-promises a capability it does not have.
      const giveAway =
        subtlety === 'plain'
          ? 'Advanced capabilities (analytics, cross-referencing) return placeholder stubs.'
          : 'Some advanced capabilities are best-effort.';
      return makeCanary(
        name,
        type,
        seed.name,
        `${baseDesc} with advanced analytics and cross-referencing. ${giveAway}`,
        baseSchema,
        giveAway
      );
    }
    case 'prerequisite-blindness': {
      // Requires a prior step the scenario will not have performed.
      const giveAway =
        subtlety === 'plain'
          ? 'Requires init_session to have been called first; otherwise returns "not authenticated".'
          : 'May require a prior setup step in some deployments.';
      return makeCanary(
        name,
        type,
        seed.name,
        `${baseDesc}. ${giveAway}`,
        baseSchema,
        giveAway
      );
    }
    case 'temporal-decoy': {
      // Operates on the wrong time frame.
      const giveAway =
        subtlety === 'plain'
          ? 'Returns records from the previous calendar year only, never the current period.'
          : 'Returns records that may lag the current period.';
      return makeCanary(
        name,
        type,
        seed.name,
        `${baseDesc}. ${giveAway}`,
        baseSchema,
        giveAway
      );
    }
    case 'granularity-trap': {
      // Operates at the wrong granularity.
      const giveAway =
        subtlety === 'plain'
          ? 'Operates only in bulk batches (minimum 1000 items); single-item lookups are unsupported.'
          : 'Optimized for bulk batches rather than single items.';
      return makeCanary(
        name,
        type,
        seed.name,
        `${baseDesc} (bulk). ${giveAway}`,
        baseSchema,
        giveAway
      );
    }
    default: {
      // Exhaustiveness guard: errors at compile time if CanaryType gains a member.
      const exhaustive: never = type;
      throw new Error(`Unhandled canary type: ${String(exhaustive)}`);
    }
  }
}

function makeCanary(
  name: string,
  type: CanaryType,
  mirrorToolName: string,
  description: string,
  inputSchema: Record<string, unknown>,
  giveAwayPhrase: string
): CanaryTool {
  return {
    name,
    type,
    mirrorToolName,
    description,
    inputSchema,
    giveAwayPhrase,
  };
}

/**
 * Synthesizes canary probe tools that mirror the given real tools.
 *
 * One canary is produced per (weakness type × mirrored tool). The total count
 * is the canary density the LLM sees; reduce it by limiting `types` or
 * `mirrorTools`. Returns an empty array when injection is disabled.
 *
 * @param realTools - The real tools exposed by the MCP server.
 * @param options - Injection options. `enabled` must be `true`.
 * @returns Synthesized canary tools (deduplicated by name).
 */
export function synthesizeCanaryTools(
  realTools: ReadonlyArray<CanarySeedTool>,
  options: CanaryInjectionOptions
): CanaryTool[] {
  if (!options.enabled) {
    return [];
  }
  const types = options.types ?? CANARY_TYPES;
  const subtlety = options.subtlety ?? 'plain';
  const prefix = options.prefix ?? 'canary';
  const mirrorFilter = options.mirrorTools
    ? new Set(options.mirrorTools)
    : null;
  const seeds = mirrorFilter
    ? realTools.filter((t) => mirrorFilter.has(t.name))
    : realTools;

  const out: CanaryTool[] = [];
  const seen = new Set<string>();
  for (const seed of seeds) {
    for (const type of types) {
      const canary = synthesizeOne(type, seed, subtlety, prefix);
      // Skip collisions with real tools or earlier canaries.
      if (!seen.has(canary.name)) {
        seen.add(canary.name);
        out.push(canary);
      }
    }
  }
  return out;
}

/**
 * Builds Vercel AI SDK tool-map entries for a set of canaries.
 *
 * Each canary's `execute` records the call via `onCall` (so it is captured in
 * the simulation's tool-call log) and returns a diagnostic string fed back to
 * the LLM — canaries never reach the real MCP server. `wrapSchema` is the
 * SDK's `jsonSchema` helper, supplied by the caller so this module stays free
 * of the SDK import.
 *
 * @param canaries - Synthesized canary tools.
 * @param wrapSchema - Wraps a raw JSON Schema into the SDK's Schema object.
 * @param onCall - Invoked with `(name, args)` when the agent calls a canary.
 * @returns A tool-name → entry map, ready to merge into the SDK tool map.
 */
export function buildCanaryVercelEntries(
  canaries: ReadonlyArray<CanaryTool>,
  wrapSchema: (schema: Record<string, unknown>) => unknown,
  onCall: (name: string, args: Record<string, unknown>) => void
): Record<string, CanaryVercelEntry> {
  const entries: Record<string, CanaryVercelEntry> = {};
  for (const canary of canaries) {
    const rawSchema: Record<string, unknown> = {
      type: 'object',
      ...canary.inputSchema,
    };
    entries[canary.name] = {
      description: canary.description,
      inputSchema: wrapSchema(rawSchema),
      execute: async (args: Record<string, unknown>) => {
        onCall(canary.name, args);
        return `[canary probe:${canary.type}] This tool is a decoy and is not the correct tool for this task.`;
      },
    };
  }
  return entries;
}

/**
 * Computes the Canary Susceptibility Rate (CSR) from observed tool calls.
 *
 * A tool call "hits" a canary when its name appears in `canaryTypes` (the
 * name → type map produced alongside injection). The overall rate is the
 * fraction of all tool calls that hit a canary; the per-type breakdown shows
 * which weaknesses fired.
 *
 * @param toolCalls - Every tool call the agent made during the simulation.
 * @param canaryTypes - Map of injected canary tool names to their weakness type.
 */
export function computeCanarySusceptibility(
  toolCalls: ReadonlyArray<LLMToolCall>,
  canaryTypes: Readonly<Record<string, CanaryType>>
): CanarySusceptibilityReport {
  const totalCalls = toolCalls.length;
  const triggeredCalls = toolCalls.filter(
    (call) => canaryTypes[call.name] !== undefined
  );
  const canaryCalls = triggeredCalls.length;

  const byType: CanaryTypeStat[] = CANARY_TYPES.map((type) => {
    const calls = triggeredCalls.filter(
      (call) => canaryTypes[call.name] === type
    ).length;
    return { type, calls, triggered: calls > 0 };
  });

  return {
    susceptibilityRate: totalCalls > 0 ? canaryCalls / totalCalls : 0,
    triggeredAny: canaryCalls > 0,
    canaryCalls,
    totalCalls,
    byType,
    triggeredCalls: [...triggeredCalls],
  };
}
