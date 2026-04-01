/**
 * MCP Host Simulation - Main entry point
 *
 * SDK providers (openai, anthropic, google, azure, mistral, deepseek,
 * openrouter, xai) run through the Vercel AI SDK orchestrator, which uses
 * generateText with maxSteps for a uniform multi-turn tool-calling loop
 * with built-in latency decomposition.
 *
 * The 'claude-code' provider spawns the Claude Code CLI process instead,
 * passing the MCP server config via `--mcp-config`.
 *
 * Required packages per SDK provider:
 *   openai      → npm install ai @ai-sdk/openai
 *   anthropic   → npm install ai @ai-sdk/anthropic
 *   google      → npm install ai @ai-sdk/google
 *   azure       → npm install ai @ai-sdk/azure
 *   mistral     → npm install ai @ai-sdk/mistral
 *   deepseek    → npm install ai @ai-sdk/deepseek
 *   openrouter  → npm install ai @openrouter/ai-sdk-provider
 *   xai         → npm install ai @ai-sdk/xai
 */

import type { MCPFixtureApi } from '../../mcp/fixtures/mcpFixture.js';
import type { MCPConfig } from '../../config/mcpConfig.js';
import type {
  MCPHostConfig,
  MCPHostSimulationResult,
  MCPHostSimulator,
  SDKProvider,
} from './mcpHostTypes.js';
import { createVercelOrchestrator } from './adapters/vercel.js';
import { claudeCodeAdapter, runCLIHost } from './adapters/cli/index.js';

const vercelOrchestrator: MCPHostSimulator = createVercelOrchestrator();

const sdkProviders: SDKProvider[] = [
  'openai',
  'anthropic',
  'azure',
  'google',
  'mistral',
  'deepseek',
  'openrouter',
  'xai',
  'vertex-anthropic',
];

const simulatorRegistry = new Map<string, MCPHostSimulator>(
  sdkProviders.map((p) => [p, vercelOrchestrator])
);

/**
 * Simulates an MCP host interacting with an MCP server.
 *
 * The LLM chooses which tools to call based solely on their descriptions and
 * schemas, testing discoverability and parameter clarity at the level a real
 * user (via Claude Desktop, ChatGPT, etc.) would experience.
 *
 * @param mcp - MCP fixture API
 * @param scenario - Natural language prompt describing what the LLM should do
 * @param config - MCP host configuration (provider, model, temperature, etc.)
 * @param mcpConfig - MCP server connection details (required for 'claude-code' provider)
 * @returns Simulation result with tool calls, final response, and latency data
 *
 * @example
 * ```typescript
 * const result = await simulateMCPHost(mcp,
 *   "Find recent documents about MCP testing frameworks",
 *   { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' }
 * );
 *
 * expect(result.success).toBe(true);
 * expect(result.toolCalls.map(c => c.name)).toContain('search');
 * ```
 */
export async function simulateMCPHost(
  mcp: MCPFixtureApi,
  scenario: string,
  config: MCPHostConfig,
  mcpConfig?: MCPConfig
): Promise<MCPHostSimulationResult> {
  if (config.provider === 'claude-code') {
    if (!mcpConfig) {
      throw new Error(
        `CLI host "claude-code" requires mcpConfig (the MCP server connection details) ` +
          `to be available. Ensure mcpConfig is set in your Playwright project configuration ` +
          `(project.use.mcpConfig in playwright.config.ts).`
      );
    }
    return runCLIHost(claudeCodeAdapter, scenario, mcpConfig, {
      model: config.model,
      maxToolCalls: config.maxToolCalls,
      temperature: config.temperature,
    });
  }

  const simulator = simulatorRegistry.get(config.provider);
  if (!simulator) {
    throw new Error(
      `Unsupported provider: "${config.provider}". ` +
        `Supported: ${[...sdkProviders, 'claude-code'].join(', ')}`
    );
  }
  return simulator.simulate(mcp, scenario, config);
}

/**
 * Returns true if the given provider is supported.
 *
 * Note: this does not check whether the required @ai-sdk/* package is
 * installed — that is validated at simulation time with a helpful error.
 */
export function isProviderAvailable(provider: string): boolean {
  return provider === 'claude-code' || simulatorRegistry.has(provider);
}

/**
 * Returns a human-readable installation message for a given provider.
 *
 * @remarks This is a diagnostic utility for checking whether optional
 * @ai-sdk/* packages are installed. Not part of the primary usage path.
 */
export function getMissingDependencyMessage(provider: string): string {
  if (provider === 'claude-code') {
    return 'claude-code requires the Claude Code CLI to be installed. See https://docs.anthropic.com/en/docs/claude-code';
  }

  const packageMap: Record<string, string> = {
    openai: 'npm install ai @ai-sdk/openai',
    anthropic: 'npm install ai @ai-sdk/anthropic',
    google: 'npm install ai @ai-sdk/google',
    azure: 'npm install ai @ai-sdk/azure',
    mistral: 'npm install ai @ai-sdk/mistral',
    deepseek: 'npm install ai @ai-sdk/deepseek',
    openrouter: 'npm install ai @openrouter/ai-sdk-provider',
    xai: 'npm install ai @ai-sdk/xai',
    'vertex-anthropic':
      'npm install ai @ai-sdk/google-vertex (requires Application Default Credentials — see docs/mcp-host.md)',
  };

  const pkg = packageMap[provider];
  return pkg
    ? `${String(provider)} provider requires: ${pkg}`
    : `Unknown provider: ${String(provider)}`;
}
