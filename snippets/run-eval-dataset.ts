import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

test('file operations eval', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json', {
    schemas: { 'file-content': z.object({ content: z.string() }) },
  });
  const result = await runEvalDataset({ dataset }, { mcp, testInfo });
  expect(result.passed).toBe(result.total);
});
