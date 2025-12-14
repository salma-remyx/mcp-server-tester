/**
 * toSatisfyToolPredicate Matcher
 *
 * Validates that a response satisfies a custom predicate function.
 * This is an escape hatch for custom validation logic when built-in
 * matchers don't cover the use case.
 */

import { extractText } from '../validators/utils.js';
import type { PredicateResult, ToolPredicate } from './types.js';

/**
 * Normalizes predicate result to PredicateResult object
 */
function normalizeResult(result: boolean | PredicateResult): PredicateResult {
  if (typeof result === 'boolean') {
    return {
      pass: result,
      message: result ? 'Predicate passed' : 'Predicate returned false',
    };
  }
  return result;
}

/**
 * Creates the toSatisfyToolPredicate matcher function
 *
 * This matcher allows custom validation logic via a predicate function.
 * The predicate receives both the raw response and extracted text.
 *
 * @example
 * ```typescript
 * // Simple boolean predicate
 * expect(result).toSatisfyToolPredicate((response) => {
 *   return response.data?.length > 0;
 * });
 *
 * // Predicate with custom message
 * expect(result).toSatisfyToolPredicate((response, text) => {
 *   const hasTemperature = text.includes('temperature');
 *   return {
 *     pass: hasTemperature,
 *     message: hasTemperature
 *       ? 'Found temperature in response'
 *       : 'Expected response to contain temperature',
 *   };
 * });
 *
 * // Async predicate
 * expect(result).toSatisfyToolPredicate(async (response) => {
 *   const isValid = await validateWithExternalService(response);
 *   return isValid;
 * });
 * ```
 */
export async function toSatisfyToolPredicate(
  this: { isNot: boolean },
  received: unknown,
  predicate: ToolPredicate,
  description?: string
): Promise<{ pass: boolean; message: () => string }> {
  const predicateDescription = description ?? 'custom predicate';

  try {
    // Extract text for convenience
    const text = extractText(received);

    // Run the predicate
    const rawResult = await predicate(received, text);
    const result = normalizeResult(rawResult);

    // Handle .not
    if (this.isNot) {
      return {
        pass: !result.pass,
        message: () =>
          result.pass
            ? `Expected response NOT to satisfy ${predicateDescription}`
            : `Response does not satisfy ${predicateDescription} as expected`,
      };
    }

    return {
      pass: result.pass,
      message: () =>
        result.pass
          ? (result.message ?? `Response satisfies ${predicateDescription}`)
          : (result.message ??
            `Expected response to satisfy ${predicateDescription}`),
    };
  } catch (error) {
    // Predicate threw an error
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      pass: this.isNot, // If using .not, an error means the predicate didn't pass
      message: () => `Predicate threw error: ${errorMessage}`,
    };
  }
}
