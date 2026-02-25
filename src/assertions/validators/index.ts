/**
 * Validators Module
 *
 * Pure validation functions that power both Playwright matchers and the eval runner.
 * Each validator returns a ValidationResult indicating pass/fail with a message.
 */

// Export types
export type {
  ValidationResult,
  TextValidatorOptions,
  SizeValidatorOptions,
  SchemaValidatorOptions,
  PatternValidatorOptions,
  BuiltInSanitizer,
  RegexSanitizer,
  FieldRemovalSanitizer,
  SnapshotSanitizer,
  SchemaRegistry,
} from './types.js';

// Export validators
export { validateResponse } from './response.js';
export { validateSchema } from './schema.js';
export { validateText } from './text.js';
export { validatePattern } from './pattern.js';
export { validateError } from './error.js';
export { validateSize } from './size.js';
export { validateToolCalls, validateToolCallCount } from './toolCalls.js';
export type { ToolCallExpectation, ToolCallCountOptions } from './toolCalls.js';
export { validateJudge } from './judge.js';
export type { JudgeValidatorConfig } from './judge.js';

// Export utilities
export {
  extractText,
  getResponseSizeBytes,
  stringifyResponse,
  isErrorResponse,
  extractErrorMessage,
  normalizeWhitespace,
} from './utils.js';
