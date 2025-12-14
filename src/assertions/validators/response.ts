/**
 * Response Validator
 *
 * Validates that a response exactly matches an expected value.
 */

import type { ValidationResult } from './types.js';
import { stringifyResponse } from './utils.js';

/**
 * Validates that a response exactly matches the expected value
 *
 * Performs deep equality comparison using JSON serialization.
 *
 * @param actual - The actual response
 * @param expected - The expected response
 * @returns Validation result
 *
 * @example
 * ```typescript
 * const result = validateResponse(response, { status: 'ok', count: 42 });
 * if (!result.pass) {
 *   console.log(result.message);
 * }
 * ```
 */
export function validateResponse(
  actual: unknown,
  expected: unknown
): ValidationResult {
  const actualStr = stringifyResponse(actual);
  const expectedStr = stringifyResponse(expected);

  if (actualStr === expectedStr) {
    return {
      pass: true,
      message: 'Response matches expected value',
    };
  }

  return {
    pass: false,
    message: `Response does not match expected value`,
    details: {
      actual: truncateForDisplay(actualStr),
      expected: truncateForDisplay(expectedStr),
    },
  };
}

/**
 * Truncates a string for display in error messages
 */
function truncateForDisplay(str: string, maxLength = 500): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength) + '... (truncated)';
}
