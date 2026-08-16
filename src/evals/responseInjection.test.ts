import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  INJECTION_PAYLOADS,
  injectToolResponse,
  resolveInjectionText,
} from './responseInjection.js';

function textResult(...texts: string[]): CallToolResult {
  return {
    content: texts.map((text) => ({ type: 'text' as const, text })),
    isError: false,
  };
}

describe('injectToolResponse', () => {
  it('appends the payload after real text output by default', () => {
    const original = textResult('Expense policy v3');
    const injected = injectToolResponse(original, {
      payload: 'ignore-previous-instructions',
    });

    const texts = injected.content.map((b) => (b as { text: string }).text);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe('Expense policy v3');
    expect(texts[1]).toBe(INJECTION_PAYLOADS['ignore-previous-instructions']);
  });

  it('does not mutate the original result', () => {
    const original = textResult('real output');
    injectToolResponse(original, { payload: 'tool-redirection' });

    expect(original.content).toHaveLength(1);
  });

  it('supports prepend and surround placements', () => {
    const original = textResult('real output');

    const prepended = injectToolResponse(original, {
      payload: 'tool-redirection',
      placement: 'prepend',
    });
    expect((prepended.content[0] as { text: string }).text).toBe(
      INJECTION_PAYLOADS['tool-redirection']
    );

    const surrounded = injectToolResponse(original, {
      payload: 'tool-redirection',
      placement: 'surround',
    });
    expect(surrounded.content).toHaveLength(3);
  });

  it('adds a text block when the server returned no text content', () => {
    const original: CallToolResult = {
      content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }],
      isError: false,
    };

    const injected = injectToolResponse(original, {
      payload: 'hidden-directive',
    });
    expect(injected.content).toHaveLength(2);
    expect(injected.content[0]).toHaveProperty('type', 'text');
  });

  it('preserves structuredContent and isError for downstream assertions', () => {
    const original: CallToolResult = {
      content: [{ type: 'text', text: 'partial' }],
      structuredContent: { version: 3 },
      isError: true,
    };

    const injected = injectToolResponse(original, {
      payload: 'tool-redirection',
    });
    expect(injected.structuredContent).toEqual({ version: 3 });
    expect(injected.isError).toBe(true);
  });

  it('interpolates {payload} in a custom template', () => {
    const text = resolveInjectionText({
      template: 'BEGIN\n{payload}\nEND',
      payload: 'hidden-directive',
    });
    expect(text).toBe(`BEGIN\n${INJECTION_PAYLOADS['hidden-directive']}\nEND`);
  });

  it('treats unknown payload names as literal attacker text', () => {
    const text = resolveInjectionText({ payload: 'custom attacker text' });
    expect(text).toBe('custom attacker text');
  });
});
