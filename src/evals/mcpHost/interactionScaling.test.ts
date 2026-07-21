import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MCPFixtureApi } from '../../mcp/fixtures/mcpFixture.js';
import type { MCPHostSimulationResult } from './mcpHostTypes.js';

// Mutable queues shared with the hoisted mock. vi.hoisted runs before the
// vi.mock factory so the closures capture initialized bindings.
const { results, calls } = vi.hoisted(() => ({
  results: [] as Array<MCPHostSimulationResult>,
  calls: [] as Array<{ scenario: string }>,
}));

// Mock the Vercel orchestrator — the only runtime path simulateMCPHost
// uses for the 'sdk' host type. Each call records the scenario it was given
// and returns the next queued result, so the revision loop's per-attempt
// proposals are observable.
vi.mock('./adapters/vercel.js', () => ({
  createVercelOrchestrator: () => ({
    simulate: vi.fn(async (_mcp, scenario: string, _config) => {
      calls.push({ scenario });
      const next = results.shift();
      return next ?? { success: true, toolCalls: [], response: 'empty' };
    }),
  }),
}));

// Imported AFTER vi.mock so the real simulateMCPHost (non-new module) drives
// the revision delegation under test.
import { simulateMCPHost } from './mcpHostSimulation.js';
import { runInteractionScaling } from './interactionScaling.js';

function createMockMCP(): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
    project: 'test-project',
    getServerInfo: vi.fn().mockReturnValue(null),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Tool result' }],
    }),
  };
}

function searchResult(): MCPHostSimulationResult {
  return {
    success: true,
    toolCalls: [{ name: 'search', arguments: { query: 'docs' } }],
    response: 'Found results',
  };
}

function emptyResult(): MCPHostSimulationResult {
  return { success: true, toolCalls: [], response: 'I am not sure' };
}

describe('simulateMCPHost — interaction scaling delegation', () => {
  beforeEach(() => {
    results.length = 0;
    calls.length = 0;
  });

  it('runs the forward path unchanged when no revision is configured', async () => {
    results.push(searchResult());
    const mcp = createMockMCP();
    const result = await simulateMCPHost(mcp, 'Find docs', {
      provider: 'anthropic',
    });

    expect(calls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe('search');
  });

  it('revises across attempts using grounded feedback, then returns the resolved result', async () => {
    // Attempt 1: host proposes nothing useful. Attempt 2: after the observer
    // feeds the flaw back, host calls search.
    results.push(emptyResult(), searchResult());
    const mcp = createMockMCP();

    const result = await simulateMCPHost(mcp, 'Find recent docs', {
      provider: 'anthropic',
      revision: {
        observe: (sim, _mcp, _attempt) => {
          const searched = sim.toolCalls.some((c) => c.name === 'search');
          return searched
            ? { resolved: true }
            : {
                resolved: false,
                feedback: 'You did not call the search tool.',
              };
        },
        maxAttempts: 3,
      },
    });

    // Two forward simulations ran (proposal + one revision).
    expect(calls).toHaveLength(2);
    // The revision imported the real observation into the second proposal.
    expect(calls[1]!.scenario).toContain('You did not call the search tool.');
    // The returned result is the resolved (second) attempt.
    expect(result.toolCalls[0]!.name).toBe('search');
  });

  it('stops as soon as the grounded observer resolves', async () => {
    results.push(searchResult(), emptyResult());
    const mcp = createMockMCP();

    await simulateMCPHost(mcp, 'Find docs', {
      provider: 'anthropic',
      revision: {
        observe: () => ({ resolved: true }),
        maxAttempts: 3,
      },
    });

    expect(calls).toHaveLength(1);
  });

  it('hits maxAttempts without resolving and returns the last attempt', async () => {
    results.push(emptyResult(), emptyResult(), emptyResult());
    const mcp = createMockMCP();

    const result = await simulateMCPHost(mcp, 'Find docs', {
      provider: 'anthropic',
      revision: {
        observe: () => ({ resolved: false, feedback: 'still missing' }),
        maxAttempts: 3,
      },
    });

    expect(calls).toHaveLength(3);
    expect(result.toolCalls).toHaveLength(0);
  });
});

describe('runInteractionScaling — outcome shape', () => {
  beforeEach(() => {
    results.length = 0;
    calls.length = 0;
  });

  it('reports revisedToResolve only when revision beat the first proposal', async () => {
    results.push(emptyResult(), searchResult());
    const mcp = createMockMCP();

    const outcome = await runInteractionScaling(
      mcp,
      'Find docs',
      { provider: 'anthropic' },
      {
        observe: (sim) =>
          sim.toolCalls.some((c) => c.name === 'search')
            ? { resolved: true }
            : { resolved: false, feedback: 'no search' },
        maxAttempts: 3,
      }
    );

    expect(outcome.resolved).toBe(true);
    expect(outcome.resolvedAtAttempt).toBe(2);
    expect(outcome.revisedToResolve).toBe(true);
    expect(outcome.attempts).toHaveLength(2);
  });

  it('does not claim a revision win when already resolved on attempt 1', async () => {
    results.push(searchResult());
    const mcp = createMockMCP();

    const outcome = await runInteractionScaling(
      mcp,
      'Find docs',
      { provider: 'anthropic' },
      {
        observe: () => ({ resolved: true }),
        maxAttempts: 3,
      }
    );

    expect(outcome.resolvedAtAttempt).toBe(1);
    expect(outcome.revisedToResolve).toBe(false);
  });

  it('rejects maxAttempts below 1', async () => {
    const mcp = createMockMCP();
    await expect(
      runInteractionScaling(
        mcp,
        'Find docs',
        { provider: 'anthropic' },
        { observe: () => ({ resolved: true }), maxAttempts: 0 }
      )
    ).rejects.toThrow('maxAttempts must be at least 1');
  });
});
