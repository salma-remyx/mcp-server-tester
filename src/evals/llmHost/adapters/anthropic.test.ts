import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock must be hoisted above the import of the module under test.
// The adapter does `const module = await import('@anthropic-ai/sdk')` and
// accesses `module.default`, so we expose the constructor as `default`.
const mockMessagesCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: {
      create: mockMessagesCreate,
    },
  }));
  return {
    default: MockAnthropic,
  };
});

import { createAnthropicAdapter } from './anthropic.js';
import type { LLMChatResult } from '../adapter.js';
import type { LLMHostConfig } from '../llmHostTypes.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const baseConfig: LLMHostConfig = {
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
};

function makeToolUseResponse(
  name: string,
  input: Record<string, unknown>,
  id = 'tu_1'
) {
  return {
    content: [
      {
        type: 'tool_use',
        id,
        name,
        input,
      },
    ],
    stop_reason: 'tool_use',
  };
}

function makeTextResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
  };
}

function makeMixedResponse(
  text: string,
  name: string,
  input: Record<string, unknown>,
  id = 'tu_mix'
) {
  return {
    content: [
      { type: 'text', text },
      { type: 'tool_use', id, name, input },
    ],
    stop_reason: 'tool_use',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAnthropicAdapter', () => {
  let adapter: ReturnType<typeof createAnthropicAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    adapter = createAnthropicAdapter();
  });

  // -------------------------------------------------------------------------
  // provider property
  // -------------------------------------------------------------------------

  it('has provider === "anthropic"', () => {
    expect(adapter.provider).toBe('anthropic');
  });

  // -------------------------------------------------------------------------
  // createClient
  // -------------------------------------------------------------------------

  describe('createClient', () => {
    it('returns a client when the API key env var is set', async () => {
      const client = await adapter.createClient(baseConfig);
      expect(client).toBeDefined();
    });

    it('throws when the API key env var is not set', async () => {
      delete process.env['ANTHROPIC_API_KEY'];
      await expect(adapter.createClient(baseConfig)).rejects.toThrow(
        'Anthropic API key not found'
      );
    });

    it('reads the API key from a custom apiKeyEnvVar', async () => {
      process.env['MY_ANTHROPIC_KEY'] = 'custom-key';
      const config: LLMHostConfig = {
        ...baseConfig,
        apiKeyEnvVar: 'MY_ANTHROPIC_KEY',
      };
      const client = await adapter.createClient(config);
      expect(client).toBeDefined();
      delete process.env['MY_ANTHROPIC_KEY'];
    });
  });

  // -------------------------------------------------------------------------
  // formatTools
  // -------------------------------------------------------------------------

  describe('formatTools', () => {
    it('converts MCP tools to Anthropic tool format', () => {
      const tools: Tool[] = [
        {
          name: 'search',
          description: 'Search for information',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
      ];

      const formatted = adapter.formatTools(tools) as Array<{
        name: string;
        description: string;
        input_schema: Record<string, unknown>;
      }>;

      expect(formatted).toHaveLength(1);
      expect(formatted[0]!.name).toBe('search');
      expect(formatted[0]!.description).toBe('Search for information');
      expect(formatted[0]!.input_schema).toEqual({
        type: 'object',
        properties: { query: { type: 'string' } },
      });
    });

    it('does NOT include a "type" wrapper key (differs from OpenAI format)', () => {
      const tools: Tool[] = [
        {
          name: 'search',
          description: 'Search',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      const formatted = adapter.formatTools(tools) as Array<
        Record<string, unknown>
      >;
      expect(formatted[0]!['type']).toBeUndefined();
    });

    it('uses input_schema instead of parameters', () => {
      const tools: Tool[] = [
        {
          name: 'lookup',
          description: 'Lookup tool',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'number' } },
          },
        },
      ];

      const formatted = adapter.formatTools(tools) as Array<{
        input_schema: Record<string, unknown>;
      }>;

      expect(formatted[0]!.input_schema).toBeDefined();
    });

    it('uses empty string for description when tool has no description', () => {
      const tools: Tool[] = [
        {
          name: 'no_desc_tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      const formatted = adapter.formatTools(tools) as Array<{
        description: string;
      }>;
      expect(formatted[0]!.description).toBe('');
    });

    it('handles tools with empty inputSchema', () => {
      const tools: Tool[] = [
        {
          name: 'empty_schema_tool',
          description: 'No params',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      const formatted = adapter.formatTools(tools) as Array<{
        input_schema: Record<string, unknown>;
      }>;

      expect(formatted[0]!.input_schema).toEqual({
        type: 'object',
        properties: {},
      });
    });

    it('converts multiple tools', () => {
      const tools: Tool[] = [
        {
          name: 'tool_a',
          description: 'Tool A',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'tool_b',
          description: 'Tool B',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      const formatted = adapter.formatTools(tools);
      expect(formatted).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // createUserMessage
  // -------------------------------------------------------------------------

  describe('createUserMessage', () => {
    it('returns an object with role "user"', () => {
      const msg = adapter.createUserMessage('Hello') as { role: string };
      expect(msg.role).toBe('user');
    });

    it('sets content to the scenario string', () => {
      const scenario = 'Search for climate change articles';
      const msg = adapter.createUserMessage(scenario) as { content: string };
      expect(msg.content).toBe(scenario);
    });

    it('preserves the exact scenario text', () => {
      const scenario = 'Find top results for "machine learning" in 2024';
      const msg = adapter.createUserMessage(scenario) as { content: string };
      expect(msg.content).toBe(scenario);
    });
  });

  // -------------------------------------------------------------------------
  // createAssistantMessage
  // -------------------------------------------------------------------------

  describe('createAssistantMessage', () => {
    it('returns a message with role "assistant"', () => {
      const rawResponse = makeTextResponse('Hello there');
      const chatResult: LLMChatResult = {
        wantsToolCalls: false,
        toolCalls: [],
        textContent: 'Hello there',
        rawResponse,
      };

      const msg = adapter.createAssistantMessage(chatResult) as {
        role: string;
      };
      expect(msg.role).toBe('assistant');
    });

    it('sets content to the raw response content array (text response)', () => {
      const rawResponse = makeTextResponse('Here is the answer.');
      const chatResult: LLMChatResult = {
        wantsToolCalls: false,
        toolCalls: [],
        textContent: 'Here is the answer.',
        rawResponse,
      };

      const msg = adapter.createAssistantMessage(chatResult) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(Array.isArray(msg.content)).toBe(true);
      expect(msg.content[0]!.type).toBe('text');
      expect(msg.content[0]!.text).toBe('Here is the answer.');
    });

    it('sets content to the raw response content array (tool call response)', () => {
      const rawResponse = makeToolUseResponse('search', { query: 'hello' });
      const chatResult: LLMChatResult = {
        wantsToolCalls: true,
        toolCalls: [
          { name: 'search', arguments: { query: 'hello' }, id: 'tu_1' },
        ],
        textContent: null,
        rawResponse,
      };

      const msg = adapter.createAssistantMessage(chatResult) as {
        content: Array<{ type: string }>;
      };

      expect(Array.isArray(msg.content)).toBe(true);
      expect(msg.content[0]!.type).toBe('tool_use');
    });

    it('preserves all content blocks from the raw response (mixed response)', () => {
      const rawResponse = makeMixedResponse('Thinking...', 'search', {
        query: 'ai',
      });
      const chatResult: LLMChatResult = {
        wantsToolCalls: true,
        toolCalls: [
          { name: 'search', arguments: { query: 'ai' }, id: 'tu_mix' },
        ],
        textContent: 'Thinking...',
        rawResponse,
      };

      const msg = adapter.createAssistantMessage(chatResult) as {
        content: Array<{ type: string }>;
      };

      expect(msg.content).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // createToolResultMessage
  // -------------------------------------------------------------------------

  describe('createToolResultMessage', () => {
    it('returns an object with type "tool_result"', () => {
      const toolCall = { name: 'search', arguments: {}, id: 'tu_1' };
      const msg = adapter.createToolResultMessage(toolCall, 'some result') as {
        type: string;
      };
      expect(msg.type).toBe('tool_result');
    });

    it('includes the tool_use_id from the tool call id', () => {
      const toolCall = { name: 'search', arguments: {}, id: 'tu_abc' };
      const msg = adapter.createToolResultMessage(toolCall, 'result') as {
        tool_use_id?: string;
      };
      expect(msg.tool_use_id).toBe('tu_abc');
    });

    it('includes the result as content', () => {
      const toolCall = { name: 'search', arguments: {}, id: 'tu_1' };
      const resultText = 'Found 10 articles about climate change.';
      const msg = adapter.createToolResultMessage(toolCall, resultText) as {
        content: string;
      };
      expect(msg.content).toBe(resultText);
    });

    it('does NOT have a role property (Anthropic tool results are content blocks)', () => {
      const toolCall = { name: 'search', arguments: {}, id: 'tu_1' };
      const msg = adapter.createToolResultMessage(toolCall, 'result') as Record<
        string,
        unknown
      >;
      // Anthropic tool results are content blocks within a user message, not top-level messages
      expect(msg['role']).toBeUndefined();
    });

    it('handles tool calls without an id (id is undefined)', () => {
      const toolCall = { name: 'search', arguments: {} };
      const msg = adapter.createToolResultMessage(toolCall, 'result') as {
        tool_use_id?: string;
      };
      expect(msg.tool_use_id).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // chat
  // -------------------------------------------------------------------------

  describe('chat', () => {
    let client: unknown;

    beforeEach(async () => {
      client = await adapter.createClient(baseConfig);
    });

    it('returns wantsToolCalls=true when stop_reason is "tool_use"', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeToolUseResponse('search', { query: 'hello' })
      );

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.wantsToolCalls).toBe(true);
    });

    it('parses the tool call name correctly', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeToolUseResponse('search', { query: 'hello' })
      );

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.toolCalls[0]!.name).toBe('search');
    });

    it('parses the tool call arguments directly from input (no JSON.parse needed)', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeToolUseResponse('search', { query: 'hello', limit: 5 })
      );

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.toolCalls[0]!.arguments).toEqual({
        query: 'hello',
        limit: 5,
      });
    });

    it('captures the tool call id', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeToolUseResponse('search', { query: 'x' }, 'tu_xyz')
      );

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.toolCalls[0]!.id).toBe('tu_xyz');
    });

    it('returns multiple tool calls when the response contains multiple tool_use blocks', async () => {
      mockMessagesCreate.mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'tool_a', input: { x: 1 } },
          { type: 'tool_use', id: 'tu_2', name: 'tool_b', input: { y: 2 } },
        ],
        stop_reason: 'tool_use',
      });

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.wantsToolCalls).toBe(true);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0]!.name).toBe('tool_a');
      expect(result.toolCalls[1]!.name).toBe('tool_b');
    });

    it('returns wantsToolCalls=false when stop_reason is "end_turn"', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeTextResponse('Here is the answer.')
      );

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.wantsToolCalls).toBe(false);
    });

    it('returns the text content when stop_reason is "end_turn"', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeTextResponse('Here is the answer.')
      );

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.textContent).toBe('Here is the answer.');
    });

    it('returns an empty toolCalls array for a text response', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeTextResponse('No tools needed.')
      );

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.toolCalls).toEqual([]);
    });

    it('extracts text content even when tool calls are present (mixed response)', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeMixedResponse('Let me search that for you.', 'search', {
          query: 'ai',
        })
      );

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.wantsToolCalls).toBe(true);
      expect(result.textContent).toBe('Let me search that for you.');
    });

    it('returns null textContent when there is no text block', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeToolUseResponse('search', { query: 'hello' })
      );

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.textContent).toBeNull();
    });

    it('attaches the rawResponse to the result', async () => {
      const raw = makeTextResponse('raw check');
      mockMessagesCreate.mockResolvedValueOnce(raw);

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.rawResponse).toBe(raw);
    });

    it('throws when stop_reason is "max_tokens"', async () => {
      mockMessagesCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'truncated...' }],
        stop_reason: 'max_tokens',
      });

      await expect(adapter.chat(client, [], [], baseConfig)).rejects.toThrow(
        'Response exceeded max tokens'
      );
    });

    it('propagates errors thrown by the Anthropic SDK', async () => {
      mockMessagesCreate.mockRejectedValueOnce(new Error('Overloaded error'));

      await expect(adapter.chat(client, [], [], baseConfig)).rejects.toThrow(
        'Overloaded error'
      );
    });

    it('passes the model from config to the API call', async () => {
      mockMessagesCreate.mockResolvedValueOnce(makeTextResponse('ok'));
      const config: LLMHostConfig = {
        ...baseConfig,
        model: 'claude-3-haiku-20240307',
      };

      await adapter.chat(client, [], [], config);

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-3-haiku-20240307' })
      );
    });

    it('defaults to claude-3-5-sonnet-20241022 when no model is specified', async () => {
      mockMessagesCreate.mockResolvedValueOnce(makeTextResponse('ok'));
      const config: LLMHostConfig = { provider: 'anthropic' };

      await adapter.chat(client, [], [], config);

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-3-5-sonnet-20241022' })
      );
    });

    it('defaults max_tokens to 4096 when not specified', async () => {
      mockMessagesCreate.mockResolvedValueOnce(makeTextResponse('ok'));

      await adapter.chat(client, [], [], baseConfig);

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: 4096 })
      );
    });

    it('passes max_tokens from config when specified', async () => {
      mockMessagesCreate.mockResolvedValueOnce(makeTextResponse('ok'));
      const config: LLMHostConfig = { ...baseConfig, maxTokens: 1024 };

      await adapter.chat(client, [], [], config);

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: 1024 })
      );
    });

    it('defaults temperature to 0.0 when not specified', async () => {
      mockMessagesCreate.mockResolvedValueOnce(makeTextResponse('ok'));

      await adapter.chat(client, [], [], baseConfig);

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0.0 })
      );
    });

    it('passes temperature from config when specified', async () => {
      mockMessagesCreate.mockResolvedValueOnce(makeTextResponse('ok'));
      const config: LLMHostConfig = { ...baseConfig, temperature: 0.5 };

      await adapter.chat(client, [], [], config);

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0.5 })
      );
    });
  });
});
