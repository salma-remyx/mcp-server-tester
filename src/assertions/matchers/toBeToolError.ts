/**
 * toBeToolError Matcher
 *
 * Validates that a response is (or is not) an error.
 */

import { validateError } from '../validators/error.js';

/**
 * Creates the toBeToolError matcher function
 */
export function toBeToolError(
  this: { isNot: boolean },
  received: unknown,
  expected: boolean | string | string[] = true
) {
  // Handle .not case specially
  const effectiveExpected = this.isNot
    ? typeof expected === 'boolean'
      ? !expected
      : false // .not with string message means "should not be error"
    : expected;

  const result = validateError(received, effectiveExpected);

  return {
    pass: this.isNot ? !result.pass : result.pass,
    message: () => {
      if (this.isNot) {
        // When using .not, we want the opposite behavior
        if (typeof expected === 'boolean') {
          return result.pass
            ? 'Expected response NOT to be an error, but it was'
            : 'Response is not an error as expected';
        }
        const expectedStr = Array.isArray(expected)
          ? expected.join(', ')
          : expected;
        return result.pass
          ? `Expected response NOT to be an error with "${expectedStr}", but it was`
          : result.message;
      }
      return result.message;
    },
  };
}
