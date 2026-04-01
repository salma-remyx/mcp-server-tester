import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MCPFixtureApi } from '../../mcp/fixtures/mcpFixture.js';
import type { StdioMCPConfig } from '../../config/mcpConfig.js';

// Mock the Vercel orchestrator — it's the only runtime path now
vi.mock('./adapters/vercel.js', () => ({
  createVercelOrchestrator: vi.fn(() => ({
    simulate: vi.fn().mockResolvedValue({
      success: true,
      toolCalls: [{ name: 'search', arguments: { query: 'test' } }],
      response: 'Found results',
      llmDurationMs: 100,
      mcpDurationMs: 20,
    }),
  })),
}));

import {
  simulateMCPHost,
  isProviderAvailable,
  getMissingDependencyMessage,
} from './mcpHostSimulation.js';
import {
  registerCLIHost,
  clearCLIHostRegistry,
} from './adapters/cli/registry.js';
import { claudeCodeAdapter } from './adapters/cli/claudeCode.js';
import type { CLIHostAdapter } from './adapters/cli/types.js';

function createMockMCP(): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
    project: 'test-project',
    getServerInfo: vi.fn().mockReturnValue(null),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Tool result' }],
    }),
  };
}

describe('simulateMCPHost', () => {
  it('routes all providers through the Vercel orchestrator', async () => {
    const mcp = createMockMCP();
    const result = await simulateMCPHost(mcp, 'Find recent docs', {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
    });

    expect(result.success).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe('search');
  });

  it('works for openai provider', async () => {
    const mcp = createMockMCP();
    const result = await simulateMCPHost(mcp, 'scenario', {
      provider: 'openai',
      model: 'gpt-4o',
    });
    expect(result.success).toBe(true);
  });

  it('works for google provider', async () => {
    const mcp = createMockMCP();
    const result = await simulateMCPHost(mcp, 'scenario', {
      provider: 'google',
    });
    expect(result.success).toBe(true);
  });

  it('throws for unsupported provider', async () => {
    const mcp = createMockMCP();
    await expect(
      simulateMCPHost(mcp, 'scenario', {
        provider: 'unknown-provider',
      })
    ).rejects.toThrow('Unsupported provider');
  });
});

describe('isProviderAvailable', () => {
  const supportedProviders = [
    'openai',
    'anthropic',
    'google',
    'azure',
    'mistral',
    'deepseek',
    'openrouter',
    'xai',
  ] as const;

  for (const provider of supportedProviders) {
    it(`returns true for ${provider}`, () => {
      expect(isProviderAvailable(provider)).toBe(true);
    });
  }

  it('returns true for claude-code', () => {
    expect(isProviderAvailable('claude-code')).toBe(true);
  });

  it('returns false for unknown provider', () => {
    expect(isProviderAvailable('unknown')).toBe(false);
  });
});

describe('getMissingDependencyMessage', () => {
  it('returns install command for openai', () => {
    const msg = getMissingDependencyMessage('openai');
    expect(msg).toContain('@ai-sdk/openai');
    expect(msg).toContain('npm install');
  });

  it('returns install command for anthropic', () => {
    const msg = getMissingDependencyMessage('anthropic');
    expect(msg).toContain('@ai-sdk/anthropic');
  });

  it('returns install command for all providers', () => {
    const providers = [
      'openai',
      'anthropic',
      'google',
      'azure',
      'mistral',
      'deepseek',
      'openrouter',
      'xai',
    ] as const;

    for (const provider of providers) {
      const msg = getMissingDependencyMessage(provider);
      expect(msg).toContain('npm install');
    }
  });

  it('returns CLI-specific message for claude-code', () => {
    const msg = getMissingDependencyMessage('claude-code');
    expect(msg).toContain('CLI host provider');
  });

  it('returns generic message for unknown provider', () => {
    const msg = getMissingDependencyMessage('unknown');
    expect(msg).toContain('Unknown provider');
  });
});

describe('CLI host routing', () => {
  const testMcpConfig: StdioMCPConfig = {
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
  };

  beforeEach(() => {
    clearCLIHostRegistry();
    registerCLIHost('claude-code', claudeCodeAdapter);
  });

  it('throws when CLI host is used without mcpConfig', async () => {
    const mcp = createMockMCP();
    await expect(
      simulateMCPHost(mcp, 'scenario', { provider: 'claude-code' })
    ).rejects.toThrow('requires mcpConfig');
  });

  it('routes to CLI adapter when provider is a registered CLI host', async () => {
    const mockAdapter: CLIHostAdapter = {
      buildCommand: () => ({ command: 'echo', args: ['{}'] }),
      parseOutput: () => ({
        success: true,
        toolCalls: [{ name: 'my_tool', arguments: {} }],
        response: 'CLI response',
      }),
    };
    registerCLIHost('my-cli', mockAdapter);

    const mcp = createMockMCP();
    const result = await simulateMCPHost(
      mcp,
      'test scenario',
      { provider: 'my-cli' },
      testMcpConfig
    );

    expect(result.success).toBe(true);
    expect(result.toolCalls[0]!.name).toBe('my_tool');
  });

  it('isProviderAvailable returns true for registered CLI hosts', () => {
    registerCLIHost('my-cli', {
      buildCommand: () => ({ command: 'test', args: [] }),
      parseOutput: () => ({ success: true, toolCalls: [] }),
    });
    expect(isProviderAvailable('my-cli')).toBe(true);
  });

  it('getMissingDependencyMessage returns CLI-specific message for custom host', () => {
    registerCLIHost('my-cli', {
      buildCommand: () => ({ command: 'test', args: [] }),
      parseOutput: () => ({ success: true, toolCalls: [] }),
    });
    const msg = getMissingDependencyMessage('my-cli');
    expect(msg).toContain('CLI host provider');
  });
});
