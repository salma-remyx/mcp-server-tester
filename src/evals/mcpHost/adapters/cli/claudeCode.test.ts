import { describe, it, expect } from 'vitest';
import { claudeCodeAdapter } from './claudeCode.js';
import type {
  StdioMCPConfig,
  HttpMCPConfig,
} from '../../../../config/mcpConfig.js';

describe('claudeCodeAdapter', () => {
  describe('buildCommand', () => {
    it('builds command for stdio transport', () => {
      const mcpConfig: StdioMCPConfig = {
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { DEBUG: '1' },
      };

      const invocation = claudeCodeAdapter.buildCommand(
        'Find docs about testing',
        mcpConfig
      );

      expect(invocation.command).toBe('claude');
      expect(invocation.args).toContain('-p');
      expect(invocation.args).toContain('Find docs about testing');
      expect(invocation.args).toContain('--output-format');
      expect(invocation.args).toContain('stream-json');
      expect(invocation.args).toContain('--verbose');
      expect(invocation.args).toContain('--allowedTools');
      expect(invocation.args).toContain('mcp__test-server__*');

      // Check MCP config JSON
      const mcpConfigIdx = invocation.args.indexOf('--mcp-config');
      const mcpConfigJson = JSON.parse(
        invocation.args[mcpConfigIdx + 1]!
      ) as Record<string, unknown>;
      expect(mcpConfigJson).toEqual({
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
            env: { DEBUG: '1' },
          },
        },
      });
    });

    it('builds command for HTTP transport', () => {
      const mcpConfig: HttpMCPConfig = {
        transport: 'http',
        serverUrl: 'http://localhost:3000/mcp',
      };

      const invocation = claudeCodeAdapter.buildCommand('scenario', mcpConfig);

      const mcpConfigIdx = invocation.args.indexOf('--mcp-config');
      const mcpConfigJson = JSON.parse(
        invocation.args[mcpConfigIdx + 1]!
      ) as Record<string, unknown>;
      expect(mcpConfigJson).toEqual({
        mcpServers: {
          'test-server': {
            type: 'http',
            url: 'http://localhost:3000/mcp',
          },
        },
      });
    });

    it('includes model when specified', () => {
      const mcpConfig: StdioMCPConfig = {
        transport: 'stdio',
        command: 'node',
        args: [],
      };
      const invocation = claudeCodeAdapter.buildCommand('scenario', mcpConfig, {
        model: 'sonnet',
      });

      expect(invocation.args).toContain('--model');
      expect(invocation.args).toContain('sonnet');
    });

    it('uses custom binary when specified', () => {
      const mcpConfig: StdioMCPConfig = {
        transport: 'stdio',
        command: 'node',
        args: [],
      };
      const invocation = claudeCodeAdapter.buildCommand('scenario', mcpConfig, {
        binary: '/usr/local/bin/claude',
      });

      expect(invocation.command).toBe('/usr/local/bin/claude');
    });
  });

  describe('parseOutput', () => {
    it('delegates to parseStreamJson', () => {
      const stdout = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello' }],
        },
      });

      const result = claudeCodeAdapter.parseOutput(stdout);
      expect(result.success).toBe(true);
      expect(result.response).toBe('Hello');
    });
  });
});
