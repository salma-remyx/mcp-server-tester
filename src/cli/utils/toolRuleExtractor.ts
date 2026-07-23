/**
 * Tool rule extractor — derives rule-grounded eval expectations and cases
 * from an MCP tool's natural-language description and input schema.
 *
 * Adapted from the core insight of PromptPex
 *   Pham et al., 2025, "PromptPex: Automatic Test Generation for Language
 *   Model Prompts", arXiv:2503.05070
 * which treats a prompt (here, the tool description) as a contract: output
 * and behavior rules are extracted from that contract and used to generate
 * rule-grounded test cases.
 *
 * This is a Mode 2 (adapted) port. The paper extracts formal rules with an
 * LLM and exercises them with a constraint solver; both are substituted with
 * parameter-free pattern heuristics over the description text and JSON
 * Schema. The output is projected onto the repo's existing EvalExpectBlock
 * shape ({ containsText, matchesPattern, isError }) so the generated cases
 * flow through the same generate command and datasetLoader as response-
 * derived suggestions.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { EvalCase, EvalExpectBlock } from '../../evals/datasetTypes.js';

/**
 * Category of a contract rule.
 * - contains: the output includes a named field/key
 * - pattern:  the output follows a named format (JSON, URL, ISO date, ...)
 * - enum:     a value is constrained to a fixed set
 * - error:    the tool rejects invalid input
 */
export type ToolRuleKind = 'contains' | 'pattern' | 'enum' | 'error';

/**
 * A single rule mined from a tool's contract.
 *
 * `detail` carries a machine hint used when projecting the rule onto
 * assertions: a field name (contains), a format token (pattern), an
 * alternation regex like `a|b|c` (enum), or a comma-joined required list.
 */
export interface ToolRule {
  kind: ToolRuleKind;
  summary: string;
  detail?: string;
}

/** Minimal projection of a tool's input JSON Schema. */
interface InputSchemaShape {
  properties?: Record<string, { type?: string; enum?: unknown[] }>;
  required?: string[];
}

/** Rule-grounded suggestions in the same shape as the response suggester. */
export interface RuleExpectationSuggestions {
  textContains: string[];
  regex: string[];
}

export interface GenerateRuleCasesOptions {
  /** Prefix for generated case ids. @default tool.name */
  idPrefix?: string;
  /** Valid args to seed "happy-path" cases. @default {} */
  args?: Record<string, unknown>;
}

/** Maps a named format token to a regex assertion. */
const FORMAT_PATTERNS: Record<string, string> = {
  url: 'https?://[^\\s]+',
  uri: 'https?://[^\\s]+',
  iso: '\\d{4}-\\d{2}-\\d{2}',
  timestamp: '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}',
  // "JSON" is structural (parseability), not assertable via regex — omitted.
};

/** Named output formats to detect in a description, with a projection token. */
const NAMED_FORMATS: Array<{ token: string; re: RegExp; summary: string }> = [
  { token: 'json', re: /\bJSON\b/i, summary: 'Returns JSON' },
  { token: 'url', re: /\bURL\b|\bURI\b/i, summary: 'Returns a URL' },
  {
    token: 'iso',
    re: /ISO[-\s]?8601|ISO date/i,
    summary: 'Returns an ISO 8601 date',
  },
  { token: 'timestamp', re: /\btimestamp\b/i, summary: 'Returns a timestamp' },
];

/**
 * Extract output/behavior rules from a tool's description and input schema.
 *
 * @param tool - The MCP tool whose contract to mine.
 * @returns De-duplicated rules; empty when the description is uninformative.
 */
export function extractToolRules(tool: Tool): ToolRule[] {
  const rules: ToolRule[] = [];
  const description = tool.description ?? '';

  // Enum constraints: "must be one of: asc, desc" style phrases.
  const oneOf = description.match(/one of[:\s]+([^.\n;]+)/i);
  if (oneOf && oneOf[1]) {
    const items = splitList(oneOf[1]);
    if (items.length >= 2) {
      rules.push({
        kind: 'enum',
        summary: `Must be one of: ${items.join(', ')}`,
        detail: items.map(escapeRegex).join('|'),
      });
    }
  }

  // Field guarantees: "includes a `status` field" / "`id` key".
  for (const field of description.matchAll(
    /\b(?:includes?|contains?|returns?)\s+(?:a|an|the)?\s*`([a-zA-Z_][\w-]*)`/gi
  )) {
    if (field[1]) {
      rules.push({
        kind: 'contains',
        summary: `Includes field: ${field[1]}`,
        detail: field[1],
      });
    }
  }
  for (const field of description.matchAll(
    /`([a-zA-Z_][\w-]*)`\s+(?:field|key|property|column)/gi
  )) {
    if (field[1]) {
      rules.push({
        kind: 'contains',
        summary: `Includes field: ${field[1]}`,
        detail: field[1],
      });
    }
  }

  // Named output formats.
  for (const fmt of NAMED_FORMATS) {
    if (fmt.re.test(description)) {
      rules.push({ kind: 'pattern', summary: fmt.summary, detail: fmt.token });
    }
  }

  // Error conditions stated in prose.
  if (
    /\b(throws?|errors?|fails?|invalid|not found|does not exist|missing|unauthorized|forbidden)\b/i.test(
      description
    )
  ) {
    rules.push({ kind: 'error', summary: 'Rejects invalid input' });
  }

  // Structural rules from the input schema.
  const schema = readSchema(tool);
  const required = schema.required ?? [];
  if (required.length > 0) {
    rules.push({
      kind: 'error',
      summary: `Requires: ${required.join(', ')}`,
      detail: required.join(', '),
    });
  }
  const properties = schema.properties ?? {};
  for (const [name, prop] of Object.entries(properties)) {
    if (Array.isArray(prop.enum) && prop.enum.length >= 2) {
      const items = prop.enum.map((v) => escapeRegex(String(v)));
      rules.push({
        kind: 'enum',
        summary: `${name} must be one of: ${prop.enum.join(', ')}`,
        detail: items.join('|'),
      });
    }
  }

  return dedupeRules(rules);
}

/**
 * Project a tool's rules onto the same { textContains, regex } shape the
 * response-driven suggester emits, so the generate command can surface
 * contract-derived assertions alongside response-derived ones.
 */
export function suggestRuleExpectations(
  tool: Tool
): RuleExpectationSuggestions {
  const textContains: string[] = [];
  const regex: string[] = [];
  for (const rule of extractToolRules(tool)) {
    if (rule.kind === 'contains' && rule.detail) {
      textContains.push(rule.detail);
    } else if (rule.kind === 'enum' && rule.detail) {
      regex.push(rule.detail);
    } else if (rule.kind === 'pattern' && rule.detail) {
      const pattern = FORMAT_PATTERNS[rule.detail] ?? null;
      if (pattern) regex.push(pattern);
    }
  }
  return {
    textContains: [...new Set(textContains)],
    regex: [...new Set(regex)],
  };
}

/**
 * Generate rule-grounded eval cases for a tool.
 *
 * Emits the repo's { toolName, args, expect } case shape:
 *  - a positive case asserting the output honors the stated
 *    format/fields/enums (when any such rule exists), and
 *  - a negative case asserting that violating a required or
 *    enum-constrained input is rejected with an error (only when a concrete
 *    violation can be synthesized without a solver).
 *
 * @param tool - The MCP tool to generate cases for.
 * @param options - id prefix and seed args.
 * @returns Rule-grounded cases ready for validateEvalCase / a dataset.
 */
export function generateRuleCases(
  tool: Tool,
  options: GenerateRuleCasesOptions = {}
): EvalCase[] {
  const prefix = options.idPrefix ?? tool.name;
  const args = options.args ?? {};
  const cases: EvalCase[] = [];

  // Positive case: output honors the described format/fields/enums.
  const projected = suggestRuleExpectations(tool);
  if (projected.textContains.length > 0 || projected.regex.length > 0) {
    const expect: EvalExpectBlock = {};
    if (projected.textContains.length > 0) {
      expect.containsText = projected.textContains;
    }
    if (projected.regex.length > 0) {
      expect.matchesPattern = projected.regex;
    }
    cases.push({
      id: `${prefix}-rules-output`,
      description: 'Rule-grounded: output honors the tool description contract',
      toolName: tool.name,
      args,
      expect,
      tags: ['promptpex', 'rule-grounded'],
    });
  }

  // Negative case: an invalid input vector should be rejected.
  const violation = buildViolatingArgs(tool);
  if (violation !== null) {
    cases.push({
      id: `${prefix}-rules-invalid-input`,
      description: 'Rule-grounded: invalid input is rejected with an error',
      toolName: tool.name,
      args: violation,
      expect: { isError: true },
      tags: ['promptpex', 'rule-grounded', 'negative'],
    });
  }

  return cases;
}

/** Read a tool's input schema as the minimal shape this module needs. */
function readSchema(tool: Tool): InputSchemaShape {
  return tool.inputSchema as InputSchemaShape;
}

/**
 * Build an args object that violates the tool's input contract, or null when
 * no reliable violation can be synthesized (Mode 2 substitution boundary:
 * the paper's solver is unavailable, so we only emit a negative case when
 * omitting a required field or passing an out-of-enum value is possible).
 */
function buildViolatingArgs(
  tool: Tool
): Record<string, unknown> | null {
  const schema = readSchema(tool);
  const required = schema.required ?? [];
  if (required.length > 0) {
    // Omitting all required args is a guaranteed contract violation.
    return {};
  }
  const properties = schema.properties ?? {};
  for (const [name, prop] of Object.entries(properties)) {
    if (Array.isArray(prop.enum) && prop.enum.length > 0) {
      return { [name]: '__invalid_enum__' };
    }
  }
  return null;
}

/** Split a prose list ("a, b, or c") into trimmed items. */
function splitList(raw: string): string[] {
  return raw
    .split(/,|\bor\b|\band\b|\//)
    .map((s) => s.trim().replace(/[`"'().]/g, ''))
    .filter((s) => s.length > 0 && s.length <= 24 && !/\s/.test(s));
}

/** Escape a literal for safe embedding in an alternation regex. */
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** De-duplicate rules by kind + summary. */
function dedupeRules(rules: ToolRule[]): ToolRule[] {
  const seen = new Set<string>();
  const unique: ToolRule[] = [];
  for (const rule of rules) {
    const key = `${rule.kind}:${rule.summary}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(rule);
    }
  }
  return unique;
}
