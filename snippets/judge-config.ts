import { createJudge, runEvalDataset } from '@gleanwork/mcp-server-tester';

const judge = createJudge({
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  temperature: 0.0,
});

const result = await runEvalDataset({ dataset, judge }, { mcp, testInfo });
