/**
 * Argument-format validators for mcp_host simulation results.
 *
 * Inspired by IFEval-FC (arXiv:2509.18420), "Instruction-Following Evaluation
 * in Function Calling for Large Language Models" — which observes that existing
 * function-calling benchmarks check argument correctness but never check
 * adherence to the FORMAT instructions embedded in parameter descriptions
 * (quote-wrapping, ISO dates, enums, comma-separated lists, primitive types).
 *
 * This validator ports that core idea: given an MCPHostSimulationResult it
 * checks whether the arguments the LLM emitted for each tool call conform to
 * declared format rules. It complements validateToolCalls (which checks WHICH
 * tools fired) by checking the SHAPE of the arguments.
 *
 * Adaptation note (Mode 2 port): the paper ships a benchmark DATASET of prompts
 * carrying verifiable format instructions. That dataset is auxiliary — a
 * downstream eval dataset is the natural home for it. What is ported here at
 * full fidelity is the format-adherence taxonomy itself, applied to the parsed
 * tool-call arguments the MCP host simulation already produces. Because the host
 * returns parsed JSON arguments, the paper's "enclose the value in double
 * quotes" instruction is checked as "the value was emitted as a JSON string"
 * (`kind: 'quoted'`); the remaining families (ISO dates, enums, comma-separated
 * lists, integers) map directly onto the parsed values.
 */
import type { ValidationResult } from './types.js';
import type { MCPHostSimulationResult } from '../../evals/mcpHost/mcpHostTypes.js';

/**
 * Format families a single argument value can be checked against.
 *
 * Maps onto IFEval-FC's verifiable instruction categories.
 */
export type ArgumentFormatKind =
  | 'quoted' // value emitted as a JSON string (quote-wrapped)
  | 'integer' // whole number
  | 'number' // numeric (int or float)
  | 'boolean' // JSON boolean
  | 'iso-date' // YYYY-MM-DD
  | 'iso-datetime' // ISO 8601 date-time
  | 'uuid' // RFC 4122 UUID
  | 'enum' // one of `values`
  | 'comma-list' // comma-separated string of >= 2 items
  | 'regex'; // matches `pattern` (with optional `flags`)

/**
 * A format rule applied to a single argument value.
 */
export interface ArgumentFormatRule {
  /** Format family to check against. */
  kind: ArgumentFormatKind;
  /** Allowed values for `kind: 'enum'`. */
  values?: Array<string | number>;
  /** Regex source for `kind: 'regex'`. */
  pattern?: string;
  /** Regex flags for `kind: 'regex'`. */
  flags?: string;
  /** Minimum length of the stringified value (checked in addition to `kind`). */
  minLength?: number;
  /** Maximum length of the stringified value (checked in addition to `kind`). */
  maxLength?: number;
}

/**
 * Per-call argument format expectation.
 */
export interface ArgumentFormatCall {
  /** Tool name whose arguments to check. */
  name: string;
  /** Per-argument format rules (keys are argument names). */
  arguments?: Record<string, ArgumentFormatRule | ArgumentFormatRule[]>;
  /** Whether this call MUST have occurred (default: true). */
  required?: boolean;
}

/**
 * Expectation describing the format of tool-call arguments.
 */
export interface ArgumentFormatExpectation {
  /** Tool calls and the argument formats expected of them. */
  calls: ArgumentFormatCall[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isSimulationResult(value: unknown): value is MCPHostSimulationResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    'toolCalls' in value &&
    Array.isArray((value as MCPHostSimulationResult).toolCalls)
  );
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') return JSON.stringify(value);
  // Remaining types are primitives (number, boolean, bigint, symbol) which
  // stringify safely.
  return String(value as number | boolean | bigint | symbol);
}

function isIntegerLike(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value);
  if (typeof value === 'string') return /^-?\d+$/.test(value.trim());
  return false;
}

function isNumberLike(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isNaN(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed !== '' && !Number.isNaN(Number(trimmed));
  }
  return false;
}

/**
 * Checks a single value against one format rule.
 * Returns null on pass, or a human-readable reason on failure.
 */
function checkRule(value: unknown, rule: ArgumentFormatRule): string | null {
  switch (rule.kind) {
    case 'quoted':
      if (typeof value !== 'string') {
        return `expected a string (quote-wrapped) value, got ${describeType(value)}`;
      }
      break;
    case 'integer':
      if (!isIntegerLike(value)) {
        return `expected an integer, got ${describeValue(value)}`;
      }
      break;
    case 'number':
      if (!isNumberLike(value)) {
        return `expected a number, got ${describeValue(value)}`;
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        return `expected a boolean, got ${describeType(value)}`;
      }
      break;
    case 'iso-date':
      if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
        return `expected an ISO date (YYYY-MM-DD), got ${describeValue(value)}`;
      }
      break;
    case 'iso-datetime':
      if (typeof value !== 'string' || !ISO_DATETIME_RE.test(value)) {
        return `expected an ISO 8601 date-time, got ${describeValue(value)}`;
      }
      break;
    case 'uuid':
      if (typeof value !== 'string' || !UUID_RE.test(value)) {
        return `expected a UUID, got ${describeValue(value)}`;
      }
      break;
    case 'enum': {
      const values = rule.values;
      if (!Array.isArray(values) || values.length === 0) {
        return `enum rule requires a non-empty 'values' array`;
      }
      if (!values.includes(value as string | number)) {
        return `expected one of [${values.join(', ')}], got ${describeValue(value)}`;
      }
      break;
    }
    case 'comma-list': {
      if (typeof value !== 'string') {
        return `expected a comma-separated string, got ${describeType(value)}`;
      }
      if (value.split(',').length < 2) {
        return `expected a comma-separated list (>= 2 items), got ${describeValue(value)}`;
      }
      break;
    }
    case 'regex': {
      if (typeof rule.pattern !== 'string') {
        return `regex rule requires a 'pattern'`;
      }
      if (typeof value !== 'string') {
        return `expected a string matching /${rule.pattern}/${rule.flags ?? ''}, got ${describeType(value)}`;
      }
      const re = new RegExp(rule.pattern, rule.flags ?? '');
      if (!re.test(value)) {
        return `expected a string matching /${rule.pattern}/${rule.flags ?? ''}, got ${describeValue(value)}`;
      }
      break;
    }
  }

  // Length bounds apply to the stringified value, on top of the kind check.
  if (rule.minLength !== undefined || rule.maxLength !== undefined) {
    const len = String(value).length;
    if (rule.minLength !== undefined && len < rule.minLength) {
      return `expected length >= ${rule.minLength}, got ${len}`;
    }
    if (rule.maxLength !== undefined && len > rule.maxLength) {
      return `expected length <= ${rule.maxLength}, got ${len}`;
    }
  }

  return null;
}

/**
 * Validates that tool-call arguments adhere to declared format instructions.
 *
 * @param response - Must be an MCPHostSimulationResult (from mcp_host mode)
 * @param expectation - Per-call argument format rules
 */
export function validateArgumentFormat(
  response: unknown,
  expectation: ArgumentFormatExpectation
): ValidationResult {
  if (!isSimulationResult(response)) {
    return {
      pass: false,
      message:
        'argumentFormat expectation requires mcp_host mode — response must be an MCPHostSimulationResult',
    };
  }

  const actual = response.toolCalls;
  let checked = 0;
  const failures: string[] = [];

  for (const expectedCall of expectation.calls) {
    const matching = actual.filter((c) => c.name === expectedCall.name);

    if (matching.length === 0) {
      if (expectedCall.required !== false) {
        failures.push(
          `tool '${expectedCall.name}' was not called, so its argument formats could not be checked`
        );
      }
      continue;
    }

    const rules = expectedCall.arguments;
    if (!rules) {
      continue;
    }

    for (const call of matching) {
      for (const [argName, ruleOrRules] of Object.entries(rules)) {
        const ruleList = Array.isArray(ruleOrRules)
          ? ruleOrRules
          : [ruleOrRules];
        const argValue = (call.arguments ?? {})[argName];

        for (const rule of ruleList) {
          checked++;
          const reason = checkRule(argValue, rule);
          if (reason) {
            failures.push(
              `tool '${call.name}' argument '${argName}': ${reason}`
            );
          }
        }
      }
    }
  }

  if (failures.length > 0) {
    return {
      pass: false,
      message: `Argument format violations (${failures.length}):\n  - ${failures.join('\n  - ')}`,
      details: { checked, violations: failures },
    };
  }

  return {
    pass: true,
    message: `All argument format expectations met (${checked} check(s))`,
    details: { checked },
  };
}
