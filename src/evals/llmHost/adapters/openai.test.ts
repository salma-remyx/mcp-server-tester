import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock must be hoisted above the import of the module under test.
// The adapter uses a dynamic `import('openai')` so we mock the module
// at the module registry level. The adapter accesses `module.OpenAI`
// (the named export), so we expose it as a named export on the mock.
const mockCreate = vi.fn();

vi.mock('openai', () => {
  const MockOpenAI = vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  }));
  return {
    default: MockOpenAI,
    OpenAI: MockOpenAI,
  };
});

import { createOpenAIAdapter } from './openai.js';
import type { LLMChatResult } from '../adapter.js';
import type { LLMHostConfig } from '../llmHostTypes.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const baseConfig: LLMHostConfig = {
  provider: 'openai',
  model: 'gpt-4o',
};

function makeToolCallResponse(
  name: string,
  args: Record<string, unknown>,
  id = 'call_1'
) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id,
              type: 'function',
              function: {
                name,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
  };
}

function makeTextResponse(text: string) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: text,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createOpenAIAdapter', () => {
  let adapter: ReturnType<typeof createOpenAIAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Set a dummy API key so createClient does not throw
    process.env['OPENAI_API_KEY'] = 'test-key';
    adapter = createOpenAIAdapter();
  });

  // -------------------------------------------------------------------------
  // provider property
  // -------------------------------------------------------------------------

  it('has provider === "openai"', () => {
    expect(adapter.provider).toBe('openai');
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
      delete process.env['OPENAI_API_KEY'];
      await expect(adapter.createClient(baseConfig)).rejects.toThrow(
        'OpenAI API key not found'
      );
    });

    it('reads the API key from a custom apiKeyEnvVar', async () => {
      process.env['CUSTOM_OPENAI_KEY'] = 'custom-key';
      const config: LLMHostConfig = {
        ...baseConfig,
        apiKeyEnvVar: 'CUSTOM_OPENAI_KEY',
      };
      const client = await adapter.createClient(config);
      expect(client).toBeDefined();
      delete process.env['CUSTOM_OPENAI_KEY'];
    });
  });

  // -------------------------------------------------------------------------
  // formatTools
  // -------------------------------------------------------------------------

  describe('formatTools', () => {
    it('converts MCP tools to OpenAI function format', () => {
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
        type: string;
        function: { name: string; description: string; parameters: unknown };
      }>;

      expect(formatted).toHaveLength(1);
      expect(formatted[0]!.type).toBe('function');
      expect(formatted[0]!.function.name).toBe('search');
      expect(formatted[0]!.function.description).toBe('Search for information');
      expect(formatted[0]!.function.parameters).toEqual({
        type: 'object',
        properties: { query: { type: 'string' } },
      });
    });

    it('preserves name, description, and parameters (inputSchema)', () => {
      const tools: Tool[] = [
        {
          name: 'get_weather',
          description: 'Get the weather for a city',
          inputSchema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ];

      const formatted = adapter.formatTools(tools) as Array<{
        type: string;
        function: {
          name: string;
          description: string;
          parameters: Record<string, unknown>;
        };
      }>;

      expect(formatted[0]!.function.name).toBe('get_weather');
      expect(formatted[0]!.function.description).toBe(
        'Get the weather for a city'
      );
      expect(formatted[0]!.function.parameters['required']).toEqual(['city']);
    });

    it('uses empty string for description when tool has no description', () => {
      const tools: Tool[] = [
        {
          name: 'no_desc_tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      const formatted = adapter.formatTools(tools) as Array<{
        function: { description: string };
      }>;

      expect(formatted[0]!.function.description).toBe('');
    });

    it('handles tools with empty inputSchema', () => {
      const tools: Tool[] = [
        {
          name: 'empty_schema_tool',
          description: 'A tool with no params',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      const formatted = adapter.formatTools(tools) as Array<{
        function: { parameters: Record<string, unknown> };
      }>;

      expect(formatted[0]!.function.parameters).toEqual({
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
      const msg = adapter.createUserMessage('Hello world') as {
        role: string;
        content: string;
      };
      expect(msg.role).toBe('user');
    });

    it('sets content to the scenario string', () => {
      const scenario = 'Search for papers about LLMs';
      const msg = adapter.createUserMessage(scenario) as {
        role: string;
        content: string;
      };
      expect(msg.content).toBe(scenario);
    });

    it('preserves the exact scenario text including special characters', () => {
      const scenario = 'Find "top 10" results for <AI>';
      const msg = adapter.createUserMessage(scenario) as { content: string };
      expect(msg.content).toBe(scenario);
    });
  });

  // -------------------------------------------------------------------------
  // createAssistantMessage
  // -------------------------------------------------------------------------

  describe('createAssistantMessage', () => {
    it('returns a message with role "assistant"', () => {
      const chatResult: LLMChatResult = {
        wantsToolCalls: false,
        toolCalls: [],
        textContent: 'Hello there',
        rawResponse: makeTextResponse('Hello there'),
      };

      const msg = adapter.createAssistantMessage(chatResult) as {
        role: string;
        content: string | null;
        tool_calls?: unknown[];
      };

      expect(msg.role).toBe('assistant');
    });

    it('includes text content when there are no tool calls', () => {
      const chatResult: LLMChatResult = {
        wantsToolCalls: false,
        toolCalls: [],
        textContent: 'Here is the answer.',
        rawResponse: makeTextResponse('Here is the answer.'),
      };

      const msg = adapter.createAssistantMessage(chatResult) as {
        content: string | null;
      };

      expect(msg.content).toBe('Here is the answer.');
    });

    it('includes tool_calls from the raw response when wantsToolCalls is true', () => {
      const rawResponse = makeToolCallResponse('search', { query: 'hello' });
      const chatResult: LLMChatResult = {
        wantsToolCalls: true,
        toolCalls: [
          { name: 'search', arguments: { query: 'hello' }, id: 'call_1' },
        ],
        textContent: null,
        rawResponse,
      };

      const msg = adapter.createAssistantMessage(chatResult) as {
        role: string;
        content: string | null;
        tool_calls?: unknown[];
      };

      expect(msg.role).toBe('assistant');
      expect(msg.tool_calls).toBeDefined();
      expect(Array.isArray(msg.tool_calls)).toBe(true);
      expect((msg.tool_calls as unknown[]).length).toBeGreaterThan(0);
    });

    it('has null content when the raw response has null content (tool call turn)', () => {
      const rawResponse = makeToolCallResponse('search', { query: 'hello' });
      const chatResult: LLMChatResult = {
        wantsToolCalls: true,
        toolCalls: [
          { name: 'search', arguments: { query: 'hello' }, id: 'call_1' },
        ],
        textContent: null,
        rawResponse,
      };

      const msg = adapter.createAssistantMessage(chatResult) as {
        content: string | null;
      };
      expect(msg.content).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // createToolResultMessage
  // -------------------------------------------------------------------------

  describe('createToolResultMessage', () => {
    it('returns a message with role "tool"', () => {
      const toolCall = {
        name: 'search',
        arguments: { query: 'hello' },
        id: 'call_1',
      };
      const msg = adapter.createToolResultMessage(toolCall, 'result text') as {
        role: string;
      };
      expect(msg.role).toBe('tool');
    });

    it('includes the tool_call_id from the tool call', () => {
      const toolCall = { name: 'search', arguments: {}, id: 'call_abc' };
      const msg = adapter.createToolResultMessage(toolCall, 'result') as {
        tool_call_id?: string;
      };
      expect(msg.tool_call_id).toBe('call_abc');
    });

    it('includes the result content', () => {
      const toolCall = { name: 'search', arguments: {}, id: 'call_1' };
      const resultText = 'Here are the search results';
      const msg = adapter.createToolResultMessage(toolCall, resultText) as {
        content: string;
      };
      expect(msg.content).toBe(resultText);
    });

    it('handles tool calls without an id (id is undefined)', () => {
      const toolCall = { name: 'search', arguments: {} };
      const msg = adapter.createToolResultMessage(toolCall, 'result') as {
        tool_call_id?: string;
      };
      expect(msg.tool_call_id).toBeUndefined();
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

    it('returns wantsToolCalls=true when the LLM requests tool calls', async () => {
      mockCreate.mockResolvedValueOnce(
        makeToolCallResponse('search', { query: 'hello' })
      );

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.wantsToolCalls).toBe(true);
    });

    it('parses the tool call name correctly', async () => {
      mockCreate.mockResolvedValueOnce(
        makeToolCallResponse('search', { query: 'hello' })
      );

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.toolCalls[0]!.name).toBe('search');
    });

    it('parses the tool call arguments from the JSON string', async () => {
      mockCreate.mockResolvedValueOnce(
        makeToolCallResponse('search', { query: 'hello', limit: 5 })
      );

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.toolCalls[0]!.arguments).toEqual({
        query: 'hello',
        limit: 5,
      });
    });

    it('captures the tool call id', async () => {
      mockCreate.mockResolvedValueOnce(
        makeToolCallResponse('search', { query: 'x' }, 'call_xyz')
      );

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.toolCalls[0]!.id).toBe('call_xyz');
    });

    it('returns multiple tool calls when the response contains multiple', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'tool_a', arguments: '{"x":1}' },
                },
                {
                  id: 'c2',
                  type: 'function',
                  function: { name: 'tool_b', arguments: '{"y":2}' },
                },
              ],
            },
          },
        ],
      });

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.wantsToolCalls).toBe(true);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0]!.name).toBe('tool_a');
      expect(result.toolCalls[1]!.name).toBe('tool_b');
    });

    it('returns wantsToolCalls=false when the LLM responds with text', async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse('Here is the answer.'));

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.wantsToolCalls).toBe(false);
    });

    it('returns the text content when the LLM responds with text', async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse('Here is the answer.'));

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.textContent).toBe('Here is the answer.');
    });

    it('returns an empty toolCalls array for a text response', async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse('No tools needed.'));

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.toolCalls).toEqual([]);
    });

    it('attaches the rawResponse to the result', async () => {
      const raw = makeTextResponse('raw check');
      mockCreate.mockResolvedValueOnce(raw);

      const result = await adapter.chat(client, [], [], baseConfig);

      expect(result.rawResponse).toBe(raw);
    });

    it('throws when the API returns no choices', async () => {
      mockCreate.mockResolvedValueOnce({ choices: [] });

      await expect(adapter.chat(client, [], [], baseConfig)).rejects.toThrow(
        'No response from OpenAI'
      );
    });

    it('propagates errors thrown by the OpenAI SDK', async () => {
      mockCreate.mockRejectedValueOnce(new Error('API rate limit exceeded'));

      await expect(adapter.chat(client, [], [], baseConfig)).rejects.toThrow(
        'API rate limit exceeded'
      );
    });

    it('passes the model from config to the API call', async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse('ok'));
      const config: LLMHostConfig = { ...baseConfig, model: 'gpt-3.5-turbo' };

      await adapter.chat(client, [], [], config);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-3.5-turbo' })
      );
    });

    it('defaults to gpt-4o when no model is specified in config', async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse('ok'));
      const config: LLMHostConfig = { provider: 'openai' };

      await adapter.chat(client, [], [], config);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4o' })
      );
    });

    it('passes temperature from config', async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse('ok'));
      const config: LLMHostConfig = { ...baseConfig, temperature: 0.7 };

      await adapter.chat(client, [], [], config);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0.7 })
      );
    });

    it('defaults temperature to 0.0 when not specified', async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse('ok'));

      await adapter.chat(client, [], [], baseConfig);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0.0 })
      );
    });
  });
});
