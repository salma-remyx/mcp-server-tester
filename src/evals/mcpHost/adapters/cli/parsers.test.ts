import { describe, it, expect } from 'vitest';
import { parseStreamJson, createJsonParser } from './parsers.js';

describe('parseStreamJson', () => {
  it('extracts tool calls from assistant messages', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_123',
              name: 'mcp__test-server__search',
              input: { query: 'test' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Here are the results' }],
        },
      }),
    ].join('\n');

    const result = parseStreamJson(stdout);
    expect(result.success).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      name: 'search',
      arguments: { query: 'test' },
      id: 'toolu_123',
    });
    expect(result.response).toBe('Here are the results');
  });

  it('strips mcp__ prefix from tool names', () => {
    const stdout = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'mcp__test-server__get_weather',
            input: { city: 'London' },
          },
        ],
      },
    });

    const result = parseStreamJson(stdout);
    expect(result.toolCalls[0]!.name).toBe('get_weather');
  });

  it('keeps non-MCP tool names as-is', () => {
    const stdout = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
    });

    const result = parseStreamJson(stdout);
    expect(result.toolCalls[0]!.name).toBe('Bash');
  });

  it('handles empty output', () => {
    const result = parseStreamJson('');
    expect(result.success).toBe(true);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.response).toBeUndefined();
  });

  it('skips non-JSON lines', () => {
    const stdout = [
      'debug: starting up',
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello' }],
        },
      }),
      'another debug line',
    ].join('\n');

    const result = parseStreamJson(stdout);
    expect(result.response).toBe('Hello');
  });

  it('extracts tool results into conversation history', () => {
    const stdout = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_123',
            content: '{"echo":"hello"}',
          },
        ],
      },
    });

    const result = parseStreamJson(stdout);
    expect(result.conversationHistory).toHaveLength(1);
    expect(result.conversationHistory![0]).toEqual({
      role: 'tool',
      content: '{"echo":"hello"}',
    });
  });

  it('handles final result event when no text was captured', () => {
    const stdout = JSON.stringify({
      type: 'result',
      result: 'Final answer',
    });

    const result = parseStreamJson(stdout);
    expect(result.response).toBe('Final answer');
  });

  it('prefers text from assistant messages over result event', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'From assistant' }],
        },
      }),
      JSON.stringify({
        type: 'result',
        result: 'From result',
      }),
    ].join('\n');

    const result = parseStreamJson(stdout);
    expect(result.response).toBe('From assistant');
  });

  it('accumulates text from multiple assistant messages', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello ' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'world' }],
        },
      }),
    ].join('\n');

    const result = parseStreamJson(stdout);
    expect(result.response).toBe('Hello world');
  });

  it('returns error when result event has is_error=true', () => {
    const stdout = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'Model not found',
    });

    const result = parseStreamJson(stdout);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Model not found');
  });

  it('skips system events', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', tools: ['Bash'] }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hi' }],
        },
      }),
    ].join('\n');

    const result = parseStreamJson(stdout);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.response).toBe('Hi');
  });
});

describe('createJsonParser', () => {
  it('extracts fields using dot paths', () => {
    const parser = createJsonParser({
      toolCalls: 'result.tools',
      response: 'result.text',
    });

    const stdout = JSON.stringify({
      result: {
        tools: [{ name: 'search', arguments: { q: 'test' } }],
        text: 'Found results',
      },
    });

    const result = parser(stdout);
    expect(result.success).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe('search');
    expect(result.response).toBe('Found results');
  });

  it('handles missing tool calls array', () => {
    const parser = createJsonParser({
      toolCalls: 'result.tools',
      response: 'result.text',
    });

    const stdout = JSON.stringify({
      result: { text: 'No tools used' },
    });

    const result = parser(stdout);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.response).toBe('No tools used');
  });

  it('supports custom success path', () => {
    const parser = createJsonParser({
      toolCalls: 'data.calls',
      response: 'data.answer',
      success: 'data.ok',
    });

    const stdout = JSON.stringify({
      data: { calls: [], answer: 'done', ok: false },
    });

    const result = parser(stdout);
    expect(result.success).toBe(false);
  });
});
