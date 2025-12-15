/**
 * Size Validator
 *
 * Validates that a response meets size constraints.
 */

import type { ValidationResult, SizeValidatorOptions } from './types.js';
import { getResponseSizeBytes } from './utils.js';

/**
 * Validates that a response meets size constraints
 *
 * Checks that the response size in bytes is within the specified bounds.
 * At least one of minBytes or maxBytes must be provided.
 *
 * @param response - The response to validate
 * @param options - Size constraints
 * @returns Validation result
 *
 * @example
 * ```typescript
 * // Maximum size check
 * const result = validateSize(response, { maxBytes: 10000 });
 *
 * // Minimum size check
 * const result2 = validateSize(response, { minBytes: 100 });
 *
 * // Both bounds
 * const result3 = validateSize(response, { minBytes: 100, maxBytes: 10000 });
 * ```
 */
export function validateSize(
  response: unknown,
  options: SizeValidatorOptions
): ValidationResult {
  const { maxBytes, minBytes } = options;

  // Require at least one bound
  if (maxBytes === undefined && minBytes === undefined) {
    return {
      pass: false,
      message: 'Size validation requires at least one of maxBytes or minBytes',
    };
  }

  const actualSize = getResponseSizeBytes(response);
  const issues: string[] = [];

  // Check minimum
  if (minBytes !== undefined && actualSize < minBytes) {
    issues.push(
      `Response size (${formatBytes(actualSize)}) is below minimum (${formatBytes(minBytes)})`
    );
  }

  // Check maximum
  if (maxBytes !== undefined && actualSize > maxBytes) {
    issues.push(
      `Response size (${formatBytes(actualSize)}) exceeds maximum (${formatBytes(maxBytes)})`
    );
  }

  if (issues.length === 0) {
    return {
      pass: true,
      message: `Response size (${formatBytes(actualSize)}) is within bounds`,
      details: {
        actualBytes: actualSize,
      },
    };
  }

  return {
    pass: false,
    message: issues.join('; '),
    details: {
      actualBytes: actualSize,
      minBytes,
      maxBytes,
    },
  };
}

/**
 * Formats bytes as a human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
