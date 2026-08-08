/**
 * toAvoidCanaryTools Matcher
 *
 * Validates that an mcp_host simulation result avoided canary probe tools —
 * i.e. the model's canary susceptibility rate (CSR) stays within limits.
 * Backed by {@link validateCanarySusceptibility}. Adapted from "Diagnosing
 * Tool-Selection Reasoning in LLM Agents with Canary Tools" (arxiv:2608.04719).
 */

import {
  validateCanarySusceptibility,
  type CanarySusceptibilityExpectation,
} from '../validators/canary.js';

/**
 * Creates the toAvoidCanaryTools matcher function.
 */
export function toAvoidCanaryTools(
  this: { isNot: boolean },
  received: unknown,
  expectation: CanarySusceptibilityExpectation
) {
  const result = validateCanarySusceptibility(received, expectation);

  return {
    pass: result.pass,
    message: () => result.message,
  };
}
