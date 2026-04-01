import { isStdioConfig, type MCPConfig } from '../../../../config/mcpConfig.js';
import type { CLIHostAdapter, CLIInvocation, CLIHostOptions } from './types.js';
import { parseStreamJson } from './parsers.js';

const DEFAULT_BINARY = 'claude';
const DEFAULT_TIMEOUT = 120_000; // 2 minutes — LLM calls can be slow

function toClaudeCodeMCPConfig(mcpConfig: MCPConfig): Record<string, unknown> {
  if (isStdioConfig(mcpConfig)) {
    const server: Record<string, unknown> = {
      command: mcpConfig.command,
    };
    if (mcpConfig.args) server.args = mcpConfig.args;
    if (mcpConfig.env) server.env = mcpConfig.env;

    return {
      mcpServers: {
        'test-server': server,
      },
    };
  }

  const server: Record<string, unknown> = {
    type: 'http',
    url: mcpConfig.serverUrl,
  };
  if (mcpConfig.headers) server.headers = mcpConfig.headers;

  return {
    mcpServers: {
      'test-server': server,
    },
  };
}

export const claudeCodeAdapter: CLIHostAdapter = {
  buildCommand(
    scenario: string,
    mcpConfig: MCPConfig,
    options?: CLIHostOptions
  ): CLIInvocation {
    const binary = options?.binary ?? DEFAULT_BINARY;
    const mcpConfigJson = JSON.stringify(toClaudeCodeMCPConfig(mcpConfig));

    const args = [
      '-p',
      scenario,
      '--output-format',
      'stream-json',
      '--verbose',
      '--mcp-config',
      mcpConfigJson,
      '--allowedTools',
      'mcp__test-server__*',
    ];

    if (options?.model) {
      args.push('--model', options.model);
    }

    return {
      command: binary,
      args,
      timeout: DEFAULT_TIMEOUT,
    };
  },

  parseOutput: parseStreamJson,
};
