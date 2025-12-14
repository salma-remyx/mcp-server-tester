/**
 * Validator Utilities
 *
 * Shared utility functions for validation operations.
 * Re-exports core utilities from mcp/response.ts and adds validation-specific helpers.
 */

import { extractText as extractTextFromResponse } from '../../mcp/response.js';

/**
 * Re-export extractText from mcp/response.ts
 * This extracts text content from any response format.
 */
export const extractText = extractTextFromResponse;

/**
 * Gets the size of a response in bytes
 *
 * Serializes the response to JSON (with pretty printing for consistency)
 * and returns the byte length using UTF-8 encoding.
 *
 * @param response - Response in any format
 * @returns Size in bytes
 */
export function getResponseSizeBytes(response: unknown): number {
  if (response === null || response === undefined) {
    return 0;
  }

  // For strings, get direct byte length
  if (typeof response === 'string') {
    return Buffer.byteLength(response, 'utf8');
  }

  // For objects/arrays, serialize with formatting
  const serialized = JSON.stringify(response, null, 2);
  return Buffer.byteLength(serialized, 'utf8');
}

/**
 * Converts a response to a string for comparison
 *
 * @param response - Response in any format
 * @returns String representation
 */
export function stringifyResponse(response: unknown): string {
  if (response === null || response === undefined) {
    return '';
  }

  if (typeof response === 'string') {
    return response;
  }

  return JSON.stringify(response, null, 2);
}

/**
 * Checks if a response represents an error
 *
 * @param response - Response to check
 * @returns true if the response is an error
 */
export function isErrorResponse(response: unknown): boolean {
  if (response === null || response === undefined) {
    return false;
  }

  if (typeof response !== 'object') {
    return false;
  }

  const r = response as Record<string, unknown>;

  // Check isError flag directly
  if (r.isError === true) {
    return true;
  }

  // Check for normalized response with isError
  if ('raw' in r && typeof r.raw === 'object' && r.raw !== null) {
    const raw = r.raw as Record<string, unknown>;
    return raw.isError === true;
  }

  return false;
}

/**
 * Extracts error message from an error response
 *
 * @param response - Error response
 * @returns Error message or empty string if not an error
 */
export function extractErrorMessage(response: unknown): string {
  if (!isErrorResponse(response)) {
    return '';
  }

  // Extract text content which typically contains the error message
  return extractText(response);
}
