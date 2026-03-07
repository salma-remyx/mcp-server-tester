import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import {
  createJudge,
  loadEvalDataset,
  runEvalDataset,
} from '@gleanwork/mcp-server-tester';

const judge = createJudge({
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  temperature: 0.0,
});

test('search relevance eval with judge', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');
  const result = await runEvalDataset({ dataset, judge }, { mcp, testInfo });
  expect(result.passed).toBe(result.total);
});
