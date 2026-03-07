import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  reporter: [['list'], ['@gleanwork/mcp-server-tester/reporters/mcpReporter']],
  projects: [
    {
      name: 'my-server',
      use: {
        mcpConfig: {
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
        },
      },
    },
  ],
});
