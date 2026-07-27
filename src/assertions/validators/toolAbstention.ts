/**
 * Tool abstention validation — the "when NOT to call a tool" decision dimension.
 *
 * Conventional tool-call assertions (see {@link validateToolCalls}) encode only
 * POSITIVE expectations: "the model must call tool X". They cannot express
 * "the model must NOT call tool X in this scenario" — the complementary
 * decision that a tool-using LLM also has to get right. A model that calls a
 * search tool for a question it can already answer, or fires a destructive
 * write for a read-only request, is wrong in a way `required: true` can never
 * catch.
 *
 * Adapted from the When2Call benchmark (Raman et al., 2025,
 * https://arxiv.org/abs/2504.18851), which argues tool-calling evaluation must
 * measure decision-making, not just call accuracy: when to call, when to ask a
 * clarifying question, and when NOT to call. This module ports the "when not
 * to call" dimension onto the repo's mcp_host tool-call trace. The paper's full
 * benchmark dataset and its "ask a follow-up question" category are intentionally
 * out of scope: the dataset is test data (lives downstream), and
 * MCPHostSimulationResult carries no structured clarifying-question signal to
 * evaluate that category against.
 *
 * This module is pure and dependency-free at runtime; the caller supplies the
 * tool-call matcher (the partial-argument matcher shared with the positive
 * tool-call assertions) via {@link ToolCallMatcher}, keeping the dependency
 * one-directional.
 */

import type { LLMToolCall } from '../../evals/mcpHost/mcpHostTypes.js';
import type { ToolCallExpectation } from './toolCalls.js';

/**
 * Locates a call matching `expected` within `actual`, returning its index or
 * -1. Matches the shape of the positive tool-call matcher so abstention reuses
 * the same partial-argument (including `$pattern`) matching semantics.
 */
export type ToolCallMatcher = (
  actual: LLMToolCall[],
  expected: { name: string; arguments?: Record<string, unknown> }
) => number;

/**
 * A tool the model is expected NOT to call in a scenario.
 *
 * `arguments` is optional and partial-matched (same semantics as a positive
 * expected call): when present, only a call to `name` with matching arguments
 * counts as a violation. Omit it to forbid the tool entirely.
 */
export interface ToolAbstentionCall {
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * Outcome of evaluating the abstention dimension for one trace.
 */
export interface ToolAbstentionResult {
  pass: boolean;
  message: string;
  /**
   * "When-not-to-call accuracy" (0–1): the fraction of forbidden tools the
   * model correctly abstained from (true negatives / forbidden tools). The
   * negative-decision analogue of recall. 1.0 means the model left every
   * forbidden tool uncalled; 0.0 means it called all of them.
   */
  specificity: number;
  /** Forbidden calls that were made anyway. */
  violations: Array<{ name: string }>;
}

/**
 * Returns true when an expectation asks for at least one tool to be abstained from.
 */
export function hasAbstentionExpectation(
  expectation: ToolCallExpectation
): boolean {
  return expectation.calls.some((c) => c.forbidden === true);
}

/**
 * Extracts the abstention spec (forbidden calls) from a tool-call expectation,
 * dropping the positive-only `required`/`forbidden` flags so the result is a
 * clean list of "do not call" entries.
 */
export function extractAbstentionSpec(
  expectation: ToolCallExpectation
): ToolAbstentionCall[] {
  return expectation.calls
    .filter((c) => c.forbidden === true)
    .map((c) => {
      const spec: ToolAbstentionCall = { name: c.name };
      if (c.arguments !== undefined) {
        spec.arguments = c.arguments;
      }
      return spec;
    });
}

/**
 * Evaluates the abstention dimension: none of the forbidden tools should
 * appear in the trace.
 *
 * @param actual - The tool calls the LLM actually made.
 * @param forbidden - Tools the LLM was expected NOT to call.
 * @param findMatch - Matcher used to detect a forbidden call (shared with the
 *   positive tool-call assertions so argument/`$pattern` semantics match).
 */
export function evaluateToolAbstention(
  actual: LLMToolCall[],
  forbidden: ToolAbstentionCall[],
  findMatch: ToolCallMatcher
): ToolAbstentionResult {
  if (forbidden.length === 0) {
    return {
      pass: true,
      message: 'No forbidden tool calls were specified',
      specificity: 1,
      violations: [],
    };
  }

  const violations = forbidden
    .filter((f) => findMatch(actual, f) !== -1)
    .map((f) => ({ name: f.name }));

  const correctlyAbstained = forbidden.length - violations.length;
  const specificity = correctlyAbstained / forbidden.length;

  if (violations.length === 0) {
    return {
      pass: true,
      message: 'No forbidden tool calls were made',
      specificity,
      violations: [],
    };
  }

  const names = violations.map((v) => `'${v.name}'`).join(', ');
  return {
    pass: false,
    message: `Forbidden tool calls were made: ${names}`,
    specificity,
    violations,
  };
}
