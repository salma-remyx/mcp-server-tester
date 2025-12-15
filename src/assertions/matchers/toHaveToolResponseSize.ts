/**
 * toHaveToolResponseSize Matcher
 *
 * Validates that a response meets size constraints.
 */

import { validateSize } from '../validators/size.js';
import type { SizeValidatorOptions } from '../validators/types.js';

/**
 * Creates the toHaveToolResponseSize matcher function
 */
export function toHaveToolResponseSize(
  this: { isNot: boolean },
  received: unknown,
  options: SizeValidatorOptions
) {
  const result = validateSize(received, options);

  return {
    pass: result.pass,
    message: () => {
      if (this.isNot) {
        return result.pass
          ? 'Expected response size NOT to be within bounds, but it was'
          : result.message;
      }
      return result.message;
    },
  };
}
