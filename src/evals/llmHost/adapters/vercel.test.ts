import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVercelOrchestrator } from './vercel.js';
import type { MCPFixtureApi } from '../../../mcp/fixtures/mcpFixture.js';

// Mock the 'ai' package
vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({
    text: 'Final answer',
    steps: [
      {
        toolCalls: [{ toolName: 'get_weather', args: { city: 'London' } }],
        toolResults: [{ result: 'Sunny, 20°C' }],
        text: '',
      },
    ],
    usage: { promptTokens: 100, completionTokens: 50 },
  }),
  tool: vi.fn(
    (config: {
      description: string;
      parameters: unknown;
      execute: (args: unknown) => Promise<string>;
    }) => config
  ),
  stepCountIs: vi.fn((n: number) => ({ type: 'stepCount', count: n })),
}));

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn(() => ({ id: 'gpt-4o' })),
}));

function createMockMCP(): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
    project: undefined,
    getServerInfo: vi.fn().mockReturnValue(null),
    listTools: vi.fn().mockResolvedValue([
      {
        name: 'get_weather',
        description: 'Get weather',
        inputSchema: { type: 'object', properties: {} },
      },
    ]),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Sunny, 20°C' }],
      isError: false,
    }),
  };
}

describe('createVercelOrchestrator', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockResolvedValue({
      text: 'Final answer',
      steps: [
        {
          stepType: 'tool-result',
          toolCalls: [{ toolName: 'get_weather', args: { city: 'London' } }],
          toolResults: [{ result: 'Sunny, 20°C' }],
          text: '',
        },
      ],
      usage: { promptTokens: 100, completionTokens: 50 },
    } as never);
  });

  it('should return a simulation result with tool calls', async () => {
    const orchestrator = createVercelOrchestrator();
    const result = await orchestrator.simulate(
      createMockMCP(),
      'What is the weather in London?',
      { provider: 'openai', model: 'gpt-4o' }
    );

    expect(result.success).toBe(true);
    expect(result.response).toBe('Final answer');
    expect(result.llmDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.mcpDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('should return success:false on error', async () => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockRejectedValueOnce(new Error('API error'));

    const orchestrator = createVercelOrchestrator();
    const result = await orchestrator.simulate(createMockMCP(), 'scenario', {
      provider: 'openai',
      model: 'gpt-4o',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('API error');
  });
});
