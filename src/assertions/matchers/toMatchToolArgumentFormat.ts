/**
 * toMatchToolArgumentFormat Matcher
 *
 * Validates that tool-call arguments adhere to declared format instructions
 * (quote-wrapping, ISO dates, enums, comma-separated lists, primitive types).
 * Operates on mcp_host simulation results.
 */

import { validateArgumentFormat } from '../validators/argumentFormat.js';
import type { ArgumentFormatExpectation } from '../validators/argumentFormat.js';

/**
 * Creates the toMatchToolArgumentFormat matcher function
 */
export function toMatchToolArgumentFormat(
  this: { isNot: boolean },
  received: unknown,
  expectation: ArgumentFormatExpectation
) {
  const result = validateArgumentFormat(received, expectation);

  return {
    pass: result.pass,
    message: () => result.message,
  };
}
