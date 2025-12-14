/**
 * toContainToolText Matcher
 *
 * Validates that a response contains expected text substrings.
 */

import { validateText } from '../validators/text.js';
import type { TextValidatorOptions } from '../validators/types.js';

/**
 * Creates the toContainToolText matcher function
 */
export function toContainToolText(
  this: { isNot: boolean },
  received: unknown,
  expected: string | string[],
  options: TextValidatorOptions = {}
) {
  const result = validateText(received, expected, options);

  return {
    pass: result.pass,
    message: () => {
      if (this.isNot) {
        const expectedStr = Array.isArray(expected)
          ? expected.map((s) => `"${s}"`).join(', ')
          : `"${expected}"`;
        return result.pass
          ? `Expected response NOT to contain ${expectedStr}, but it did`
          : result.message;
      }
      return result.message;
    },
  };
}
