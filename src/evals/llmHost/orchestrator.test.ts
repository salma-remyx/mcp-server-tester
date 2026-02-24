import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSimulation } from './orchestrator.js';
import type { LLMAdapter, LLMChatResult } from './adapter.js';
import type { MCPFixtureApi } from '../../mcp/fixtures/mcpFixture.js';
import type { LLMHostConfig } from './llmHostTypes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAdapter(responses: LLMChatResult[]): LLMAdapter {
  let callIndex = 0;
  return {
    provider: 'openai',
    createClient: vi.fn().mockResolvedValue({}),
    formatTools: vi.fn().mockReturnValue([]),
    chat: vi.fn().mockImplementation(async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return response;
    }),
    createUserMessage: vi
      .fn()
      .mockReturnValue({ role: 'user', content: 'scenario' }),
    createAssistantMessage: vi
      .fn()
      .mockReturnValue({ role: 'assistant', content: '' }),
    createToolResultMessage: vi
      .fn()
      .mockReturnValue({ role: 'tool', content: 'result' }),
  };
}

function createMockMCP(): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
    project: undefined,
    getServerInfo: vi.fn().mockReturnValue(null),
    listTools: vi.fn().mockResolvedValue([
      {
        name: 'search',
        description: 'Search for information',
        inputSchema: { type: 'object', properties: {} },
      },
    ]),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'results' }],
      isError: false,
    }),
  };
}

const baseConfig: LLMHostConfig = {
  provider: 'openai',
  model: 'gpt-4o',
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('runSimulation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('single-turn (no tool calls)', () => {
    it('returns success=true when LLM responds with text and no tool calls', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: 'Here is your answer.',
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();

      const result = await runSimulation(
        adapter,
        mcp,
        'What is the capital of France?',
        baseConfig
      );

      expect(result.success).toBe(true);
    });

    it('returns the LLM text in result.response', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: 'Paris is the capital of France.',
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();

      const result = await runSimulation(
        adapter,
        mcp,
        'Capital of France?',
        baseConfig
      );

      expect(result.response).toBe('Paris is the capital of France.');
    });

    it('returns an empty toolCalls array', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: 'Direct answer.',
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();

      const result = await runSimulation(
        adapter,
        mcp,
        'Simple question',
        baseConfig
      );

      expect(result.toolCalls).toEqual([]);
    });

    it('does NOT call MCP callTool', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: 'No tools needed.',
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();

      await runSimulation(adapter, mcp, 'No tools scenario', baseConfig);

      expect(mcp.callTool).not.toHaveBeenCalled();
    });

    it('handles null textContent gracefully (returns empty string)', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: null,
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();

      const result = await runSimulation(
        adapter,
        mcp,
        'Null content',
        baseConfig
      );

      expect(result.success).toBe(true);
      expect(result.response).toBe('');
    });
  });

  describe('multi-turn with tool call', () => {
    it('calls MCP callTool when LLM requests a tool', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: true,
          toolCalls: [{ name: 'search', arguments: { query: 'Paris' } }],
          textContent: null,
          rawResponse: {},
        },
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: 'Paris is in France.',
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();

      await runSimulation(adapter, mcp, 'Find info about Paris', baseConfig);

      expect(mcp.callTool).toHaveBeenCalledTimes(1);
      expect(mcp.callTool).toHaveBeenCalledWith('search', { query: 'Paris' });
    });

    it('records the tool call in result.toolCalls', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: true,
          toolCalls: [
            { name: 'search', arguments: { query: 'Paris' }, id: 'call-1' },
          ],
          textContent: null,
          rawResponse: {},
        },
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: 'Done.',
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();

      const result = await runSimulation(
        adapter,
        mcp,
        'Tool call scenario',
        baseConfig
      );

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.name).toBe('search');
      expect(result.toolCalls[0]!.arguments).toEqual({ query: 'Paris' });
    });

    it('returns success=true after successful tool execution', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: true,
          toolCalls: [{ name: 'search', arguments: { query: 'test' } }],
          textContent: null,
          rawResponse: {},
        },
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: 'Final answer.',
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();

      const result = await runSimulation(
        adapter,
        mcp,
        'Tool scenario',
        baseConfig
      );

      expect(result.success).toBe(true);
    });

    it('handles multiple sequential tool calls', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: true,
          toolCalls: [{ name: 'search', arguments: { query: 'first' } }],
          textContent: null,
          rawResponse: {},
        },
        {
          wantsToolCalls: true,
          toolCalls: [{ name: 'search', arguments: { query: 'second' } }],
          textContent: null,
          rawResponse: {},
        },
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: 'Combined result.',
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();

      const result = await runSimulation(
        adapter,
        mcp,
        'Multi-tool scenario',
        baseConfig
      );

      expect(mcp.callTool).toHaveBeenCalledTimes(2);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0]!.arguments).toEqual({ query: 'first' });
      expect(result.toolCalls[1]!.arguments).toEqual({ query: 'second' });
    });

    it('handles multiple tool calls in a single LLM turn', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: true,
          toolCalls: [
            { name: 'search', arguments: { query: 'a' } },
            { name: 'search', arguments: { query: 'b' } },
          ],
          textContent: null,
          rawResponse: {},
        },
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: 'Both done.',
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();

      const result = await runSimulation(
        adapter,
        mcp,
        'Parallel tools',
        baseConfig
      );

      expect(mcp.callTool).toHaveBeenCalledTimes(2);
      expect(result.toolCalls).toHaveLength(2);
    });

    it('passes tool result text back via createToolResultMessage', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: true,
          toolCalls: [{ name: 'search', arguments: { query: 'test' } }],
          textContent: null,
          rawResponse: {},
        },
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: 'Answer.',
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();
      vi.mocked(mcp.callTool).mockResolvedValue({
        content: [{ type: 'text', text: 'Tool output text' }],
        isError: false,
      });

      await runSimulation(adapter, mcp, 'Tool result passing', baseConfig);

      expect(adapter.createToolResultMessage).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'search' }),
        'Tool output text'
      );
    });

    it('wraps tool results in a user message for anthropic provider', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: true,
          toolCalls: [{ name: 'search', arguments: { query: 'test' } }],
          textContent: null,
          rawResponse: {},
        },
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: 'Anthropic final answer.',
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      // Switch provider to anthropic
      (adapter as { provider: string }).provider = 'anthropic';
      const mcp = createMockMCP();

      const result = await runSimulation(
        adapter,
        mcp,
        'Anthropic scenario',
        baseConfig
      );

      // Should still succeed — tool results are wrapped differently but the loop completes
      expect(result.success).toBe(true);
      expect(mcp.callTool).toHaveBeenCalledTimes(1);
    });
  });

  describe('max iterations respected', () => {
    it('stops after maxToolCalls iterations when LLM always wants more tools', async () => {
      // LLM always says it wants tool calls — never gives a final answer
      const infiniteToolResponse: LLMChatResult = {
        wantsToolCalls: true,
        toolCalls: [{ name: 'search', arguments: { query: 'loop' } }],
        textContent: null,
        rawResponse: {},
      };
      const adapter = createMockAdapter([infiniteToolResponse]);
      const mcp = createMockMCP();

      const config: LLMHostConfig = {
        ...baseConfig,
        maxToolCalls: 2,
      };

      const result = await runSimulation(
        adapter,
        mcp,
        'Infinite loop scenario',
        config
      );

      // Should not throw, should return a result
      expect(result).toBeDefined();
      // The loop ran at most maxToolCalls=2 iterations
      expect(mcp.callTool).toHaveBeenCalledTimes(2);
    });

    it('returns success=true even when max iterations reached with no final response', async () => {
      const infiniteToolResponse: LLMChatResult = {
        wantsToolCalls: true,
        toolCalls: [{ name: 'search', arguments: {} }],
        textContent: null,
        rawResponse: {},
      };
      const adapter = createMockAdapter([infiniteToolResponse]);
      const mcp = createMockMCP();

      const config: LLMHostConfig = {
        ...baseConfig,
        maxToolCalls: 1,
      };

      const result = await runSimulation(adapter, mcp, 'Hit limit', config);

      // The loop exhausts without error — orchestrator returns success
      expect(result.success).toBe(true);
    });
  });

  describe('error handling', () => {
    it('returns success=false when adapter.createClient throws', async () => {
      const responses: LLMChatResult[] = [];
      const adapter = createMockAdapter(responses);
      vi.mocked(adapter.createClient).mockRejectedValue(
        new Error('No API key')
      );
      const mcp = createMockMCP();

      const result = await runSimulation(
        adapter,
        mcp,
        'Auth failure',
        baseConfig
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No API key');
    });

    it('returns success=false when adapter.chat throws', async () => {
      const adapter = createMockAdapter([]);
      vi.mocked(adapter.chat).mockRejectedValue(new Error('Network error'));
      const mcp = createMockMCP();

      const result = await runSimulation(
        adapter,
        mcp,
        'Chat failure',
        baseConfig
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });

    it('captures MCP callTool errors in result rather than throwing', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: true,
          toolCalls: [{ name: 'search', arguments: { query: 'fail' } }],
          textContent: null,
          rawResponse: {},
        },
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: 'Recovery answer.',
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();
      vi.mocked(mcp.callTool).mockRejectedValue(new Error('MCP tool failed'));

      // Should not throw — the error propagates to the catch block
      const result = await runSimulation(
        adapter,
        mcp,
        'Tool failure',
        baseConfig
      );

      expect(result).toBeDefined();
      // Error is captured
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('includes partial toolCalls collected before the error', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: true,
          toolCalls: [{ name: 'search', arguments: { query: 'first' } }],
          textContent: null,
          rawResponse: {},
        },
        {
          wantsToolCalls: true,
          toolCalls: [{ name: 'search', arguments: { query: 'second' } }],
          textContent: null,
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();
      // First call succeeds, second throws
      vi.mocked(mcp.callTool)
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'first result' }],
          isError: false,
        })
        .mockRejectedValueOnce(new Error('Second tool failed'));

      const result = await runSimulation(
        adapter,
        mcp,
        'Partial failure',
        baseConfig
      );

      // At least the first tool call was tracked
      expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);
      expect(result.toolCalls[0]!.name).toBe('search');
    });

    it('returns success=false with error string for non-Error throws', async () => {
      const adapter = createMockAdapter([]);
      vi.mocked(adapter.createClient).mockRejectedValue('plain string error');
      const mcp = createMockMCP();

      const result = await runSimulation(
        adapter,
        mcp,
        'String throw',
        baseConfig
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('plain string error');
    });
  });

  describe('conversation history', () => {
    it('includes user message in conversationHistory', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: 'Answer',
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();

      const result = await runSimulation(
        adapter,
        mcp,
        'My scenario',
        baseConfig
      );

      const userEntry = result.conversationHistory?.find(
        (h) => h.role === 'user'
      );
      expect(userEntry).toBeDefined();
      expect(userEntry?.content).toBe('My scenario');
    });

    it('includes assistant message in conversationHistory after response', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: 'The answer is 42.',
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();

      const result = await runSimulation(adapter, mcp, 'Question', baseConfig);

      const assistantEntry = result.conversationHistory?.find(
        (h) => h.role === 'assistant'
      );
      expect(assistantEntry).toBeDefined();
      expect(assistantEntry?.content).toBe('The answer is 42.');
    });

    it('includes tool results in conversationHistory', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: true,
          toolCalls: [{ name: 'search', arguments: { query: 'test' } }],
          textContent: null,
          rawResponse: {},
        },
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: 'Final',
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();
      vi.mocked(mcp.callTool).mockResolvedValue({
        content: [{ type: 'text', text: 'search results here' }],
        isError: false,
      });

      const result = await runSimulation(
        adapter,
        mcp,
        'Tool scenario',
        baseConfig
      );

      const toolEntry = result.conversationHistory?.find(
        (h) => h.role === 'tool'
      );
      expect(toolEntry).toBeDefined();
      expect(toolEntry?.content).toBe('search results here');
    });
  });

  describe('LLM client and tools setup', () => {
    it('calls adapter.createClient with the config', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: 'ok',
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();

      await runSimulation(adapter, mcp, 'scenario', baseConfig);

      expect(adapter.createClient).toHaveBeenCalledWith(baseConfig);
    });

    it('calls mcp.listTools to get available tools', async () => {
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: 'ok',
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();

      await runSimulation(adapter, mcp, 'scenario', baseConfig);

      expect(mcp.listTools).toHaveBeenCalledTimes(1);
    });

    it('calls adapter.formatTools with the MCP tool list', async () => {
      const tools = [
        {
          name: 'search',
          description: 'Search',
          inputSchema: { type: 'object' as const, properties: {} },
        },
      ];
      const responses: LLMChatResult[] = [
        {
          wantsToolCalls: false,
          toolCalls: [],
          textContent: 'ok',
          rawResponse: {},
        },
      ];
      const adapter = createMockAdapter(responses);
      const mcp = createMockMCP();
      vi.mocked(mcp.listTools).mockResolvedValue(tools);

      await runSimulation(adapter, mcp, 'scenario', baseConfig);

      expect(adapter.formatTools).toHaveBeenCalledWith(tools);
    });

    it('uses maxToolCalls=10 by default', async () => {
      // LLM always requests tools — if the default is 10 the loop runs 10 times
      const infiniteToolResponse: LLMChatResult = {
        wantsToolCalls: true,
        toolCalls: [{ name: 'search', arguments: {} }],
        textContent: null,
        rawResponse: {},
      };
      const adapter = createMockAdapter([infiniteToolResponse]);
      const mcp = createMockMCP();

      // No maxToolCalls in config — should default to 10
      const result = await runSimulation(adapter, mcp, 'Default limit', {
        provider: 'openai',
      });

      expect(result).toBeDefined();
      expect(mcp.callTool).toHaveBeenCalledTimes(10);
    });
  });
});
