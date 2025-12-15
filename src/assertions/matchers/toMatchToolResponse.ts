/**
 * toMatchToolResponse Matcher
 *
 * Validates that a response exactly matches an expected value.
 */

import { validateResponse } from '../validators/response.js';

/**
 * Creates the toMatchToolResponse matcher function
 */
export function toMatchToolResponse(
  this: { isNot: boolean },
  received: unknown,
  expected: unknown
) {
  const result = validateResponse(received, expected);

  return {
    pass: result.pass,
    message: () => {
      if (this.isNot) {
        return result.pass
          ? 'Expected response NOT to match, but it did'
          : result.message;
      }
      return result.message;
    },
  };
}
