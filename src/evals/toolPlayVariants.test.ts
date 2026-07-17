import { describe, it, expect, vi } from 'vitest';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import type { EvalContext, EvalRunnerResult } from './evalRunner.js';
import type { EvalDataset } from './datasetTypes.js';
import type { ToolOverrideVariant } from './evalRunner.js';

const mocks = vi.hoisted(() => ({ runEvalDataset: vi.fn() }));
vi.mock('./evalRunner.js', () => ({ runEvalDataset: mocks.runEvalDataset }));

// Imports from NON-NEW modules (proves the wiring integrates with the existing
// experiment spine) plus the new module under test.
import { runVariantExperiment } from './variantExperiment.js';
import { proposeToolPlayVariants } from './toolPlayVariants.js';

function makeResult(
  cases: Array<{ id: string; pass: boolean }>
): EvalRunnerResult {
  return {
    total: cases.length,
    passed: cases.filter((c) => c.pass).length,
    failed: cases.filter((c) => !c.pass).length,
    caseResults: cases.map((c) => ({
      id: c.id,
      datasetName: 'ds',
      toolName: 't',
      source: 'eval' as const,
      pass: c.pass,
      expectations: {},
      durationMs: 1,
    })),
    durationMs: 1,
  };
}

const TEST_TOOLS: Tool[] = [
  {
    name: 'get_weather',
    description: 'Get the weather',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
  {
    name: 'search',
    description: '',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1 },
        mode: { type: 'string', enum: ['fast', 'slow'] },
      },
    },
  },
];

function makeFakeMcp(
  tools: Tool[],
  callToolImpl: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<CallToolResult>
): MCPFixtureApi & {
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
} {
  return {
    listTools: vi.fn(async () => tools),
    callTool: vi.fn(callToolImpl),
  } as unknown as MCPFixtureApi & {
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
  };
}

function describeOverride(
  variants: ToolOverrideVariant[],
  toolName: string,
  strategy: string
): string {
  const variant = variants.find(
    (v) => v.id === `${toolName}__play__${strategy}`
  );
  return variant?.tools[toolName]?.description ?? '';
}

const PLAY_MCP = makeFakeMcp(TEST_TOOLS, async (name) => {
  if (name === 'get_weather') {
    return {
      content: [{ type: 'text', text: 'Sunny, 21C, light rain' }],
      isError: false,
    };
  }
  return {
    content: [{ type: 'text', text: 'missing required parameter' }],
    isError: true,
  };
});

describe('proposeToolPlayVariants — play then propose', () => {
  it('plays each tool once and yields one candidate per tool x strategy', async () => {
    const variants = await proposeToolPlayVariants(PLAY_MCP);

    expect(variants.length).toBe(6); // 2 tools x 3 strategies
    const ids = variants.map((v) => v.id);
    expect(new Set(ids).size).toBe(6);
    expect(PLAY_MCP.listTools).toHaveBeenCalledTimes(1);
    expect(PLAY_MCP.callTool).toHaveBeenCalledTimes(2);
  });

  it('augments the description with observed output and required input', async () => {
    const variants = await proposeToolPlayVariants(PLAY_MCP);
    const augmented = describeOverride(variants, 'get_weather', 'augmented');

    expect(augmented).toContain('Get the weather');
    expect(augmented).toContain('Required input: city');
    expect(augmented).toContain('Returns: Sunny, 21C, light rain');
  });

  it('embeds a concrete example call built from sampled probe args', async () => {
    const variants = await proposeToolPlayVariants(PLAY_MCP);
    const example = describeOverride(variants, 'get_weather', 'example');

    // city is a known param -> sampled as 'London'
    expect(example).toContain('Example call: get_weather(');
    expect(example).toContain('London');
    expect(example).toContain('Observed output: Sunny, 21C, light rain');
  });

  it('records observed rejection without claiming a return value', async () => {
    const variants = await proposeToolPlayVariants(PLAY_MCP);
    const augmented = describeOverride(variants, 'search', 'augmented');

    expect(augmented).not.toContain('Returns:');
    expect(augmented).toContain('May reject invalid or placeholder input.');
  });

  it('honors strategies and toolNames filters', async () => {
    const oneStrategy = await proposeToolPlayVariants(PLAY_MCP, {
      strategies: ['minimal'],
    });
    expect(oneStrategy.length).toBe(2);

    const oneTool = await proposeToolPlayVariants(PLAY_MCP, {
      toolNames: ['get_weather'],
    });
    expect(oneTool.length).toBe(3);
    expect(oneTool.every((v) => v.tools['get_weather'])).toBe(true);
  });

  it('samples optional params when includeOptional is set', async () => {
    const variants = await proposeToolPlayVariants(PLAY_MCP, {
      toolNames: ['search'],
      includeOptional: true,
      strategies: ['example'],
    });
    const example = describeOverride(variants, 'search', 'example');

    // limit minimum -> 1, mode enum -> 'fast'
    expect(example).toContain('limit');
    expect(example).toContain('fast');
  });

  it('treats a thrown tool call as an observed rejection', async () => {
    const throwingMcp = makeFakeMcp(
      [
        {
          name: 'boom',
          description: 'flaky',
          inputSchema: {
            type: 'object',
            properties: { x: { type: 'string' } },
            required: ['x'],
          },
        },
      ],
      async () => {
        throw new Error('network down');
      }
    );
    const variants = await proposeToolPlayVariants(throwingMcp, {
      strategies: ['example'],
    });
    const example = describeOverride(variants, 'boom', 'example');

    expect(example).toContain('rejected this input');
    expect(example).toContain('network down');
  });
});

describe('tool-play wiring into runVariantExperiment', () => {
  it('plays tools and feeds candidates through the experiment when toolPlay is true', async () => {
    mocks.runEvalDataset.mockResolvedValue(
      makeResult([{ id: 'c1', pass: true }])
    );
    const mcp = makeFakeMcp(TEST_TOOLS, async () => ({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }));
    const dataset: EvalDataset = { name: 'play-wiring', cases: [] };
    const ctx = { mcp, testInfo: undefined } as unknown as EvalContext;

    const result = await runVariantExperiment({ dataset, toolPlay: true }, ctx);

    expect(mcp.listTools).toHaveBeenCalledTimes(1);
    expect(mcp.callTool).toHaveBeenCalled();
    expect(result.reason).not.toBe('no-variants');
    expect(result.rounds[0]?.candidates.length).toBe(6);
  });

  it('does not play when an explicit proposeVariants is supplied', async () => {
    mocks.runEvalDataset.mockResolvedValue(
      makeResult([{ id: 'c1', pass: true }])
    );
    const mcp = makeFakeMcp(TEST_TOOLS, async () => ({
      content: [],
      isError: false,
    }));
    const dataset: EvalDataset = { name: 'no-play', cases: [] };
    const ctx = { mcp, testInfo: undefined } as unknown as EvalContext;
    const proposeVariants = vi.fn(async () => [{ id: 'manual', tools: {} }]);

    await runVariantExperiment(
      { dataset, proposeVariants, toolPlay: true },
      ctx
    );

    expect(proposeVariants).toHaveBeenCalled();
    expect(mcp.listTools).not.toHaveBeenCalled();
  });
});
