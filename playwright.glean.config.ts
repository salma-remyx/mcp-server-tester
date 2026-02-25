/**
 * Playwright configuration for Glean remote MCP server evals.
 *
 * Targets the live Glean MCP server at scio-prod-be.glean.com using OAuth.
 * Requires prior authentication via:
 *
 *   npx mcp-server-tester login https://scio-prod-be.glean.com/mcp/default
 *
 * Run (with Vertex AI for LLM host evals):
 *   GOOGLE_VERTEX_PROJECT=dev-sandbox-334901 GOOGLE_VERTEX_LOCATION=us-east5 \
 *   npm run test:playwright -- --config playwright.glean.config.ts
 *
 * Run a specific test group:
 *   npm run test:playwright -- --config playwright.glean.config.ts --grep "Direct Mode"
 *   npm run test:playwright -- --config playwright.glean.config.ts --grep "LLM Host"
 *   npm run test:playwright -- --config playwright.glean.config.ts --grep "Conformance"
 */

import { defineConfig } from '@playwright/test';

const GLEAN_MCP_URL = 'https://scio-prod-be.glean.com/mcp/default';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/glean-mcp-evals.spec.ts',

  // Sequential — avoids rate limiting from the Glean API
  fullyParallel: false,
  workers: 1,

  // LLM host evals: 5 cases × 3 iterations × ~10s each = ~150s minimum
  // Add buffer for Glean MCP tool execution time
  timeout: 600_000,

  forbidOnly: !!process.env.CI,
  retries: 0,

  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '.mcp-test-results/glean-html' }],
    [
      './dist/reporters/mcpReporter.cjs',
      {
        outputDir: '.mcp-test-results/glean',
        autoOpen: !process.env.CI,
        historyLimit: 20,
        quiet: false,
      },
    ],
  ],

  use: {
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'glean-mcp-oauth',
      use: {
        mcpConfig: {
          transport: 'http' as const,
          serverUrl: GLEAN_MCP_URL,
        },
      },
    },
  ],
});
