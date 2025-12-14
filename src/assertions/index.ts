/**
 * Assertions Module
 *
 * Unified assertion architecture for MCP tool response validation.
 *
 * This module provides:
 * - **Matchers**: Playwright custom matchers for use in tests
 * - **Validators**: Pure validation functions for programmatic use
 *
 * @example Using matchers in Playwright tests
 * ```typescript
 * import { expect } from '@mcp-testing/server-tester';
 *
 * test('weather tool', async ({ mcp }) => {
 *   const result = await mcp.callTool('get_weather', { city: 'London' });
 *
 *   expect(result).toContainToolText('temperature');
 *   expect(result).toMatchToolSchema(WeatherSchema);
 *   expect(result).not.toBeToolError();
 * });
 * ```
 *
 * @example Using validators programmatically
 * ```typescript
 * import { validateText, validateSchema } from '@mcp-testing/server-tester';
 *
 * const result = validateText(response, ['temperature', 'conditions']);
 * if (!result.pass) {
 *   console.log(result.message);
 * }
 * ```
 */

// Export matchers (primary API)
export { expect } from './matchers/index.js';
export type { JudgeMatcherOptions } from './matchers/types.js';

// Export validators (for advanced/programmatic usage)
export {
  validateResponse,
  validateSchema,
  validateText,
  validatePattern,
  validateError,
  validateSize,
  extractText,
  getResponseSizeBytes,
  stringifyResponse,
  isErrorResponse,
  extractErrorMessage,
} from './validators/index.js';

// Export validator types
export type {
  ValidationResult,
  TextValidatorOptions,
  SizeValidatorOptions,
  SchemaValidatorOptions,
  PatternValidatorOptions,
  SnapshotSanitizer,
  SchemaRegistry,
} from './validators/types.js';
