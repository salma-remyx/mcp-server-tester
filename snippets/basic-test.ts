import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';

test('read_file returns file contents', async ({ mcp }) => {
  const result = await mcp.callTool('read_file', { path: '/tmp/test.txt' });
  expect(result).toContainToolText('Hello, world');
  expect(result).not.toBeToolError();
});

test('server exposes required tools', async ({ mcp }) => {
  const tools = await mcp.listTools();
  expect(tools.map((t) => t.name)).toContain('read_file');
});
