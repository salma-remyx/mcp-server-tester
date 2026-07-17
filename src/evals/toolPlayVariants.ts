/**
 * Built-in "tool play" variant proposer for {@link runVariantExperiment}.
 *
 * Adapted from PLAY2PROMPT: Zero-shot Tool Instruction Optimization for LLM
 * Agents via Tool Play (https://arxiv.org/abs/2503.14432v2). The paper
 * observes that MCP-style tool descriptions are often minimal or noisy, and
 * that an agent can do better in zero-shot settings by systematically
 * "playing" with each tool to learn its real input-output behavior, then
 * rewriting the description from what it observed and keeping the rewrite
 * that best helps a downstream model trigger the tool correctly.
 *
 * This module supplies that policy as a built-in `proposeVariants` hook:
 *   1. PLAY — call each tool with schema-derived probe arguments and observe
 *      whether it succeeds, errors, or returns content.
 *   2. PROPOSE — synthesize several candidate description overrides per tool
 *      from its name, input schema, and observed behavior.
 *
 * Scoring those candidates by downstream triggering success (passRate /
 * tool precision) and keeping the best is owned by `runVariantExperiment`;
 * only the play → propose half of the paper lives here. The paper's
 * LLM-driven trial-and-error candidate generator is substituted by a
 * parameter-free, deterministic schema prober so candidate generation costs
 * no extra model calls (the experiment's mcp_host run is the only model
 * spend). See the PR body for the adapted-vs-substituted breakdown.
 *
 * NOTE: "playing" actually invokes each tool, so it can have side effects on
 * the target server just like any other test call. Opt in via
 * `runVariantExperiment({ toolPlay: true })`.
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import type {
  ToolMetadataOverride,
  ToolOverrideVariant,
} from './evalRunner.js';
import type { ProposeVariantsContext } from './variantExperiment.js';

/**
 * Description framing derived from a tool's play behavior.
 *
 * - `augmented` — original (or schema-derived) description plus observed
 *   required inputs and returned content.
 * - `example` — original description plus a concrete example invocation
 *   built from the probe arguments and the observed response.
 * - `minimal` — a terse name + required-params summary, as a control
 *   contrast the experiment can rank against the richer candidates.
 */
export type ToolPlayStrategy = 'augmented' | 'example' | 'minimal';

/** Options for the built-in tool-play proposer. */
export interface ToolPlayProposerOptions {
  /** Restrict play to these canonical tool names. Default: all listed tools. */
  toolNames?: string[];
  /** Which description framings to synthesize per tool. Default: all three. */
  strategies?: ToolPlayStrategy[];
  /**
   * Include optional (non-required) params when sampling probe arguments.
   * @default false
   */
  includeOptional?: boolean;
  /** Cap observed-content summary length in characters. @default 160 */
  summaryLength?: number;
}

/** Subset of JSON Schema describing a single tool parameter. */
interface JsonSchemaProp {
  type?: string;
  format?: string;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  items?: JsonSchemaProp;
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
}

/** What "playing" a tool revealed about its behavior. */
interface ToolPlayObservation {
  toolName: string;
  /** The tool call resolved without throwing and did not report an error. */
  ok: boolean;
  /** The tool rejected the probe (isError response or thrown exception). */
  isError: boolean;
  /** Observed successful output text, truncated. Empty when nothing returned. */
  outputSummary: string;
  /** Observed error text (from an isError response or thrown exception). */
  errorNote: string;
  /** The probe arguments that were actually sent, as a compact JSON string. */
  argSummary: string;
  /** Required parameter names declared by the tool's input schema. */
  requiredParams: string[];
}

const DEFAULT_STRATEGIES: ToolPlayStrategy[] = [
  'augmented',
  'example',
  'minimal',
];

const DEFAULT_SUMMARY_LENGTH = 160;

/** Recognized parameter names mapped to realistic placeholder values. */
const KNOWN_PARAM_VALUES: Record<string, string> = {
  city: 'London',
  country: 'United States',
  state: 'California',
  query: 'example',
  search: 'example',
  q: 'example',
  keyword: 'example',
  text: 'sample',
  message: 'sample',
  name: 'sample',
  username: 'sample_user',
  email: 'user@example.com',
  url: 'https://example.com',
  link: 'https://example.com',
  path: '/example',
  file: 'example.txt',
  filename: 'example.txt',
  date: '2024-01-15',
  language: 'en',
  locale: 'en-US',
  format: 'json',
};

/**
 * Plays every (or selected) tool once and returns one candidate
 * {@link ToolOverrideVariant} per tool × strategy. Each candidate overrides a
 * single tool's description so the experiment can attribute score changes to
 * one rewrite at a time.
 */
export async function proposeToolPlayVariants(
  mcp: MCPFixtureApi,
  options: ToolPlayProposerOptions = {}
): Promise<ToolOverrideVariant[]> {
  const strategies = options.strategies ?? DEFAULT_STRATEGIES;
  const includeOptional = options.includeOptional ?? false;
  const summaryLength = options.summaryLength ?? DEFAULT_SUMMARY_LENGTH;

  const tools = await mcp.listTools();
  const targets = filterTools(tools, options.toolNames);

  const variants: ToolOverrideVariant[] = [];
  for (const tool of targets) {
    const observation = await playTool(
      mcp,
      tool,
      includeOptional,
      summaryLength
    );
    for (const candidate of synthesizeDescriptions(
      tool,
      observation,
      strategies
    )) {
      const overrides: ToolMetadataOverride = {
        description: candidate.description,
      };
      variants.push({
        id: variantId(tool.name, candidate.strategy),
        description: `tool-play ${candidate.strategy} for ${tool.name}`,
        tools: { [tool.name]: overrides },
      });
    }
  }
  return variants;
}

/**
 * Builds a `proposeVariants` callback for {@link runVariantExperiment}. The
 * callback plays the tools once (round 0) to explore behavior and yields the
 * resulting candidates; later rounds return no new candidates, leaving
 * convergence and repetition to the experiment's own logic.
 */
export function createToolPlayProposer(
  mcp: MCPFixtureApi,
  options: ToolPlayProposerOptions = {}
): (context: ProposeVariantsContext) => Promise<ToolOverrideVariant[]> {
  let played = false;
  return async (
    _context: ProposeVariantsContext
  ): Promise<ToolOverrideVariant[]> => {
    if (played) {
      return [];
    }
    played = true;
    return proposeToolPlayVariants(mcp, options);
  };
}

function filterTools(tools: Tool[], names?: string[]): Tool[] {
  if (!names || names.length === 0) {
    return tools;
  }
  const wanted = new Set(names);
  return tools.filter((tool) => wanted.has(tool.name));
}

async function playTool(
  mcp: MCPFixtureApi,
  tool: Tool,
  includeOptional: boolean,
  summaryLength: number
): Promise<ToolPlayObservation> {
  const args = sampleProbeArgs(tool.inputSchema, includeOptional);
  const requiredParams = readRequired(tool.inputSchema) ?? [];
  const argSummary = JSON.stringify(args);
  try {
    const result: CallToolResult = await mcp.callTool(tool.name, args);
    const isError = result.isError === true;
    const content = summarizeContent(result.content, summaryLength);
    return {
      toolName: tool.name,
      ok: !isError,
      isError,
      outputSummary: isError ? '' : content,
      errorNote: isError ? content : '',
      argSummary,
      requiredParams,
    };
  } catch (err) {
    return {
      toolName: tool.name,
      ok: false,
      isError: true,
      outputSummary: '',
      errorNote: err instanceof Error ? err.message : String(err),
      argSummary,
      requiredParams,
    };
  }
}

function synthesizeDescriptions(
  tool: Tool,
  observation: ToolPlayObservation,
  strategies: ToolPlayStrategy[]
): Array<{ strategy: ToolPlayStrategy; description: string }> {
  const base = baseDescription(tool);
  return strategies.map((strategy) => ({
    strategy,
    description: synthesizeOne(strategy, tool, observation, base),
  }));
}

function synthesizeOne(
  strategy: ToolPlayStrategy,
  tool: Tool,
  observation: ToolPlayObservation,
  base: string
): string {
  switch (strategy) {
    case 'minimal': {
      const required = observation.requiredParams.length
        ? observation.requiredParams.join(', ')
        : 'none';
      return `${schemaSummary(tool)} — required input: ${required}.`;
    }
    case 'example': {
      const example = `Example call: ${tool.name}(${observation.argSummary}).`;
      const behavior = observation.ok
        ? `Observed output: ${observation.outputSummary || '(empty response)'}.`
        : `Observed behavior: rejected this input` +
          (observation.errorNote
            ? ` (${truncate(observation.errorNote, 120)})`
            : '') +
          `; real inputs likely need specific values.`;
      return `${base}\n\n${example}\n${behavior}`;
    }
    case 'augmented':
    default: {
      const clauses: string[] = [];
      if (observation.requiredParams.length) {
        clauses.push(
          `Required input: ${observation.requiredParams.join(', ')}.`
        );
      }
      if (observation.ok && observation.outputSummary) {
        clauses.push(`Returns: ${observation.outputSummary}.`);
      } else if (observation.isError) {
        clauses.push('May reject invalid or placeholder input.');
      }
      const body = clauses.length ? `\n\n${clauses.join(' ')}` : '';
      return `${base}${body}`;
    }
  }
}

function baseDescription(tool: Tool): string {
  const doc = (tool.description ?? '').trim();
  return doc ? doc : `${schemaSummary(tool)} (no description provided)`;
}

function schemaSummary(tool: Tool): string {
  const params = Object.keys(readProperties(tool.inputSchema) ?? {});
  const list = params.length ? params.join(', ') : 'no arguments';
  return `${tool.name}(${list})`;
}

function variantId(toolName: string, strategy: ToolPlayStrategy): string {
  return `${toolName}__play__${strategy}`;
}

/**
 * Derives best-effort probe arguments from a tool's JSON Schema. Only
 * required parameters are sampled by default so the probe resembles a
 * minimal valid call; optional parameters are added when requested.
 */
function sampleProbeArgs(
  schema: unknown,
  includeOptional: boolean
): Record<string, unknown> {
  const props = readProperties(schema);
  if (!props) {
    return {};
  }
  const required = readRequired(schema);
  const args: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(props)) {
    const isRequired = required ? required.includes(name) : false;
    if (!includeOptional && !isRequired) {
      continue;
    }
    args[name] = sampleValue(name, prop, includeOptional);
  }
  return args;
}

function sampleValue(
  name: string,
  prop: JsonSchemaProp,
  includeOptional: boolean
): unknown {
  if (prop.const !== undefined) {
    return prop.const;
  }
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return prop.enum[0];
  }
  switch (prop.type) {
    case 'integer':
    case 'number':
      return sampleNumber(prop);
    case 'boolean':
      return true;
    case 'array':
      return prop.items ? [sampleValue(name, prop.items, includeOptional)] : [];
    case 'object':
      return sampleObject(prop, includeOptional);
    case 'string':
      return sampleString(name, prop);
    default:
      return sampleString(name, prop);
  }
}

function sampleNumber(prop: JsonSchemaProp): number {
  if (typeof prop.minimum === 'number') {
    return prop.minimum;
  }
  if (typeof prop.maximum === 'number') {
    return prop.maximum;
  }
  return 1;
}

function sampleObject(
  prop: JsonSchemaProp,
  includeOptional: boolean
): Record<string, unknown> {
  if (!prop.properties) {
    return {};
  }
  const required = prop.required;
  const out: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(prop.properties)) {
    const isRequired = required ? required.includes(name) : false;
    if (!includeOptional && !isRequired) {
      continue;
    }
    out[name] = sampleValue(name, child, includeOptional);
  }
  return out;
}

function sampleString(name: string, prop: JsonSchemaProp): string {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(KNOWN_PARAM_VALUES)) {
    if (lower.includes(key)) {
      return value;
    }
  }
  switch (prop.format) {
    case 'date':
      return '2024-01-15';
    case 'date-time':
      return '2024-01-15T12:00:00Z';
    case 'email':
      return 'user@example.com';
    case 'uri':
    case 'url':
      return 'https://example.com';
    case 'uuid':
      return '00000000-0000-4000-8000-000000000000';
    default:
      return lower;
  }
}

function summarizeContent(content: unknown, maxLen: number): string {
  if (!Array.isArray(content)) {
    return '';
  }
  const texts: string[] = [];
  for (const item of content) {
    const text = (item as { text?: unknown } | null)?.text;
    if (typeof text === 'string') {
      texts.push(text);
    }
  }
  const joined = texts.join(' ').replace(/\s+/g, ' ').trim();
  return truncate(joined, maxLen);
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) {
    return value;
  }
  return value.slice(0, maxLen).trimEnd() + '…';
}

function readProperties(
  schema: unknown
): Record<string, JsonSchemaProp> | undefined {
  if (schema && typeof schema === 'object') {
    const props = (schema as { properties?: unknown }).properties;
    if (props && typeof props === 'object') {
      return props as Record<string, JsonSchemaProp>;
    }
  }
  return undefined;
}

function readRequired(schema: unknown): string[] | undefined {
  if (schema && typeof schema === 'object') {
    const required = (schema as { required?: unknown }).required;
    if (Array.isArray(required)) {
      return required.filter(
        (item): item is string => typeof item === 'string'
      );
    }
  }
  return undefined;
}
