/**
 * Smoke test: CLI host (claude-code) with the mock MCP server.
 *
 * Verifies that the framework correctly:
 * 1. Extracts mcpConfig from the Playwright project
 * 2. Passes it to the Claude Code CLI adapter
 * 3. The CLI connects to the MCP server and calls tools
 */
import { test, expect } from '../src/fixtures/mcp.js';
import { simulateMCPHost } from '../src/evals/mcpHost/mcpHostSimulation.js';
import type { MCPConfig } from '../src/config/mcpConfig.js';
// Side-effect import: registers the built-in 'claude-code' adapter
import '../src/evals/mcpHost/adapters/cli/index.js';

test('claude-code CLI host calls echo tool via MCP', async ({
  mcp,
}, testInfo) => {
  test.setTimeout(120_000);

  const mcpConfig = (testInfo.project.use as { mcpConfig?: unknown }).mcpConfig;

  const result = await simulateMCPHost(
    mcp,
    'Use the echo tool to echo the message "hello from cli host test"',
    {
      provider: 'claude-code',
      model: 'sonnet',
      maxToolCalls: 3,
    },
    mcpConfig as MCPConfig
  );

  console.log('=== CLI Host Result ===');
  console.log('Success:', result.success);
  console.log('Tool calls:', JSON.stringify(result.toolCalls, null, 2));
  console.log('Response:', result.response?.slice(0, 200));
  if (result.error) console.log('Error:', result.error);

  expect(result.success).toBe(true);
  expect(result.toolCalls.length).toBeGreaterThan(0);
  expect(result.toolCalls.some((tc) => tc.name === 'echo')).toBe(true);
});
