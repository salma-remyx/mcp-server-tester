import { describe, it, expect, vi } from 'vitest';
// Import from the NON-NEW eval runner module — this exercises the wiring edit
// (the difficultyFilter option + classifyTaskDifficulty call) on the real
// runEvalDataset entry point.
import { runEvalDataset, type EvalContext } from './evalRunner.js';
import type { EvalCase, EvalDataset } from './datasetTypes.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';

function createMockMCP(): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
    project: 'test-project',
    getServerInfo: vi.fn().mockReturnValue({ name: 'test', version: '1.0.0' }),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'response' }],
      isError: false,
    }),
  };
}

function createContext(): EvalContext {
  return {
    mcp: createMockMCP(),
    testInfo: {
      attach: vi.fn().mockResolvedValue(undefined),
    } as unknown as EvalContext['testInfo'],
  };
}

// Direct-mode cases whose tier comes from the metadata.difficultyTier override.
// Direct mode is deterministic and free (no LLM host), so the filter wiring can
// be exercised without real tool-call traces.
function buildDataset(): EvalDataset {
  const cases: EvalCase[] = [
    {
      id: 'single-a',
      toolName: 'echo',
      args: {},
      metadata: { difficultyTier: 'single-tool' },
    },
    {
      id: 'multi-a',
      toolName: 'echo',
      args: {},
      metadata: { difficultyTier: 'multi-tool' },
    },
    {
      id: 'multi-server-a',
      toolName: 'echo',
      args: {},
      metadata: { difficultyTier: 'multi-server' },
    },
    {
      id: 'single-b',
      toolName: 'echo',
      args: {},
      metadata: { difficultyTier: 'single-tool' },
    },
  ];
  return { name: 'difficulty-filter-test', cases };
}

describe('runEvalDataset difficultyFilter', () => {
  it('runs only cases whose computed tier is in the filter', async () => {
    const result = await runEvalDataset(
      { dataset: buildDataset(), difficultyFilter: ['single-tool'] },
      createContext()
    );
    expect(result.total).toBe(2);
    const ids = result.caseResults.map((r) => r.id).sort();
    expect(ids).toEqual(['single-a', 'single-b']);
  });

  it('runs all cases when difficultyFilter is omitted', async () => {
    const result = await runEvalDataset(
      { dataset: buildDataset() },
      createContext()
    );
    expect(result.total).toBe(4);
  });

  it('runs all cases when difficultyFilter is an empty array', async () => {
    const result = await runEvalDataset(
      { dataset: buildDataset(), difficultyFilter: [] },
      createContext()
    );
    expect(result.total).toBe(4);
  });

  it('composes with filterTags (intersection)', async () => {
    const dataset: EvalDataset = {
      name: 'compose-test',
      cases: [
        {
          id: 'keep',
          toolName: 'echo',
          args: {},
          tags: ['smoke'],
          metadata: { difficultyTier: 'single-tool' },
        },
        {
          id: 'wrong-tier',
          toolName: 'echo',
          args: {},
          tags: ['smoke'],
          metadata: { difficultyTier: 'multi-tool' },
        },
        {
          id: 'wrong-tag',
          toolName: 'echo',
          args: {},
          tags: ['release'],
          metadata: { difficultyTier: 'single-tool' },
        },
      ],
    };
    const result = await runEvalDataset(
      { dataset, filterTags: ['smoke'], difficultyFilter: ['single-tool'] },
      createContext()
    );
    expect(result.caseResults.map((r) => r.id)).toEqual(['keep']);
  });
});
