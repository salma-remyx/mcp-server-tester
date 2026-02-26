/**
 * Validator Types
 *
 * Core types for the unified assertion architecture.
 * These types are used by both Playwright matchers and the eval runner.
 */

import type { ZodType } from 'zod';

/**
 * Result of a validation operation
 */
export interface ValidationResult {
  /** Whether the validation passed */
  pass: boolean;
  /** Human-readable message explaining the result */
  message: string;
  /** Additional structured details about the validation */
  details?: Record<string, unknown>;
  /**
   * Optional quantitative metrics from the validation.
   * Populated by validateToolCalls for precision/recall.
   */
  metrics?: {
    precision?: number;
    recall?: number;
  };
}

/**
 * Options for text validation
 */
export interface TextValidatorOptions {
  /** Whether to perform case-sensitive matching (default: true) */
  caseSensitive?: boolean;
}

/**
 * Options for response size validation
 */
export interface SizeValidatorOptions {
  /** Maximum allowed size in bytes */
  maxBytes?: number;
  /** Minimum required size in bytes */
  minBytes?: number;
}

/**
 * Options for schema validation
 */
export interface SchemaValidatorOptions {
  /** Whether to use strict mode (fail on extra properties) */
  strict?: boolean;
}

/**
 * Options for pattern validation
 */
export interface PatternValidatorOptions {
  /** Whether to perform case-sensitive matching (default: true) */
  caseSensitive?: boolean;
}

/**
 * Built-in sanitizer names for common variable patterns
 */
export type BuiltInSanitizer =
  | 'timestamp' // Unix timestamps (milliseconds and seconds)
  | 'uuid' // UUIDs v1-v5
  | 'iso-date' // ISO 8601 date strings
  | 'objectId' // MongoDB ObjectIds
  | 'jwt'; // JWT tokens

/**
 * Custom regex-based sanitizer
 */
export interface RegexSanitizer {
  /** Regex pattern to match */
  pattern: string | RegExp;
  /** Replacement string (default: "[SANITIZED]") */
  replacement?: string;
}

/**
 * Field removal sanitizer - removes specified fields from objects
 */
export interface FieldRemovalSanitizer {
  /** Field paths to remove (supports dot notation for nested fields) */
  remove: string[];
}

/**
 * Snapshot sanitizer configuration
 *
 * Sanitizers transform response data before snapshot comparison,
 * allowing variable content (timestamps, IDs, etc.) to be normalized.
 *
 * Can be:
 * - A built-in sanitizer name: 'timestamp', 'uuid', 'iso-date', 'objectId', 'jwt'
 * - A regex sanitizer: { pattern: /regex/, replacement: '[REPLACED]' }
 * - A field removal sanitizer: { remove: ['field1', 'nested.field'] }
 */
export type SnapshotSanitizer =
  | BuiltInSanitizer
  | RegexSanitizer
  | FieldRemovalSanitizer;

/**
 * Schema registry for named schemas in datasets
 */
export type SchemaRegistry = Record<string, ZodType>;
