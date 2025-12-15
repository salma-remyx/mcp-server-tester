/**
 * Text Validator
 *
 * Validates that a response contains expected text substrings.
 */

import type { ValidationResult, TextValidatorOptions } from './types.js';
import { extractText } from './utils.js';

/**
 * Validates that a response contains all expected text substrings
 *
 * Extracts text from the response and checks that each expected substring
 * is present. By default, matching is case-sensitive.
 *
 * @param response - The response to validate
 * @param expected - Expected substring(s) to find
 * @param options - Validation options
 * @returns Validation result
 *
 * @example
 * ```typescript
 * const result = validateText(response, ['temperature', 'conditions']);
 * if (!result.pass) {
 *   console.log(result.message);
 * }
 *
 * // Case-insensitive matching
 * const result2 = validateText(response, 'HELLO', { caseSensitive: false });
 * ```
 */
export function validateText(
  response: unknown,
  expected: string | string[],
  options: TextValidatorOptions = {}
): ValidationResult {
  const { caseSensitive = true } = options;

  // Normalize expected to array
  const expectedStrings = Array.isArray(expected) ? expected : [expected];

  // Extract text from response
  const text = extractText(response);

  // Apply case sensitivity
  const compareText = caseSensitive ? text : text.toLowerCase();

  // Check each expected substring
  const missing: string[] = [];
  for (const substring of expectedStrings) {
    const compareSubstring = caseSensitive
      ? substring
      : substring.toLowerCase();

    if (!compareText.includes(compareSubstring)) {
      missing.push(substring);
    }
  }

  if (missing.length === 0) {
    return {
      pass: true,
      message:
        expectedStrings.length === 1
          ? `Response contains expected text`
          : `Response contains all ${expectedStrings.length} expected substrings`,
    };
  }

  return {
    pass: false,
    message:
      missing.length === 1
        ? `Response does not contain expected text: "${missing[0]}"`
        : `Response is missing ${missing.length} expected substrings: ${missing.map((s) => `"${s}"`).join(', ')}`,
    details: {
      missing,
      textLength: text.length,
      textPreview: truncateForDisplay(text),
    },
  };
}

/**
 * Truncates a string for display in error messages
 */
function truncateForDisplay(str: string, maxLength = 200): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength) + '... (truncated)';
}
