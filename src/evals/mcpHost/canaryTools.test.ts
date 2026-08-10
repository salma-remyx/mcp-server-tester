import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  synthesizeCanaryTools,
  computeCanarySusceptibility,
  buildCanaryVercelEntries,
  CANARY_TYPES,
  type CanarySeedTool,
} from './canaryTools.js';
import type { CanaryType, LLMToolCall } from './mcpHostTypes.js';
import type { MCPFixtureApi } from '../../mcp/fixtures/mcpFixture.js';

// --- Mocks that drive the SDK agentic loop for the integration test ---
// Mirrors the pattern in adapters/vercel.test.ts.

const jsonSchemaMock = vi.fn((schema: Record<string, unknown>) => ({
  _type: 'json-schema' as const,
  jsonSchema: schema,
  validate: undefined,
}));

vi.mock('@ai-sdk/provider-utils', () => ({ jsonSchema: jsonSchemaMock }));

type GenerateTextOptions = {
  tools: Record<
    string,
    { execute: (args: Record<string, unknown>) => Promise<unknown> }
  >;
};

vi.mock('ai', () => ({
  // Simulate the LLM falling for the first canary it is offered: invoke that
  // canary's execute so the orchestrator records the call in its tool log.
  generateText: vi.fn(async (opts: GenerateTextOptions) => {
    const canaryName = Object.keys(opts.tools).find((n) =>
      n.startsWith('canary_')
    );
    const entry = canaryName ? opts.tools[canaryName] : undefined;
    if (entry) {
      await entry.execute({});
    }
    return {
      text: 'done',
      steps: [{ toolCalls: [], toolResults: [], text: 'done' }],
      usage: { promptTokens: 10, completionTokens: 5 },
    };
  }),
  stepCountIs: vi.fn((n: number) => ({ type: 'stepCount', count: n })),
}));

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn(() => ({ id: 'gpt-4o' })),
}));

function mockMCP(
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>
): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
    project: undefined,
    getServerInfo: vi.fn().mockReturnValue(null),
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }),
  };
}

describe('synthesizeCanaryTools', () => {
  const seed: CanarySeedTool = {
    name: 'search',
    description: 'Search documents',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  };

  it('returns nothing when injection is disabled', () => {
    expect(synthesizeCanaryTools([seed], { enabled: false })).toEqual([]);
  });

  it('synthesizes one canary per weakness type by default (all six)', () => {
    const canaries = synthesizeCanaryTools([seed], { enabled: true });
    expect(canaries).toHaveLength(6);
    expect([...canaries.map((c) => c.type)].sort()).toEqual(
      [...CANARY_TYPES].sort()
    );
  });

  it('prefixes and tags canary names with the type and mirrored tool', () => {
    const canaries = synthesizeCanaryTools([seed], {
      enabled: true,
      types: ['semantic-decoy'],
    });
    const canary = canaries[0]!;
    expect(canary.name).toBe('canary_semantic_search');
    expect(canary.mirrorToolName).toBe('search');
  });

  it('parameter-trap adds a foot-gun default parameter', () => {
    const canaries = synthesizeCanaryTools([seed], {
      enabled: true,
      types: ['parameter-trap'],
    });
    const canary = canaries[0]!;
    const props = canary.inputSchema.properties as Record<
      string,
      { default?: string; enum?: string[] }
    >;
    expect(props.mode).toBeDefined();
    expect(props.mode!.default).toBe('fast');
    expect(props.mode!.enum).toEqual(['fast', 'accurate']);
  });

  it("subtle subtlety softens each canary's give-away phrase", () => {
    const plainCanaries = synthesizeCanaryTools([seed], {
      enabled: true,
      types: ['temporal-decoy'],
      subtlety: 'plain',
    });
    const subtleCanaries = synthesizeCanaryTools([seed], {
      enabled: true,
      types: ['temporal-decoy'],
      subtlety: 'subtle',
    });
    const plain = plainCanaries[0]!;
    const subtle = subtleCanaries[0]!;
    expect(plain.giveAwayPhrase).not.toBe(subtle.giveAwayPhrase);
    expect(subtle.giveAwayPhrase.length).toBeLessThan(
      plain.giveAwayPhrase.length
    );
  });

  it('respects the mirrorTools filter and a custom prefix', () => {
    const other: CanarySeedTool = {
      name: 'other',
      inputSchema: { type: 'object' },
    };
    const canaries = synthesizeCanaryTools([seed, other], {
      enabled: true,
      types: ['granularity-trap'],
      mirrorTools: ['other'],
      prefix: 'decoy',
    });
    expect(canaries).toHaveLength(1);
    expect(canaries[0]!.name).toBe('decoy_granularity_other');
  });
});

describe('computeCanarySusceptibility', () => {
  const canaryTypes: Record<string, CanaryType> = {
    canary_semantic_search: 'semantic-decoy',
    canary_temporal_search: 'temporal-decoy',
  };
  const calls: LLMToolCall[] = [
    { name: 'search', arguments: {} },
    { name: 'canary_semantic_search', arguments: {} },
    { name: 'canary_temporal_search', arguments: {} },
  ];

  it('computes the overall rate and a per-type breakdown', () => {
    const report = computeCanarySusceptibility(calls, canaryTypes);
    expect(report.totalCalls).toBe(3);
    expect(report.canaryCalls).toBe(2);
    expect(report.susceptibilityRate).toBeCloseTo(2 / 3, 5);
    expect(report.triggeredAny).toBe(true);
    const semantic = report.byType.find((s) => s.type === 'semantic-decoy');
    expect(semantic?.calls).toBe(1);
    expect(semantic?.triggered).toBe(true);
  });

  it('reports zero susceptibility when no canary is called', () => {
    const report = computeCanarySusceptibility(
      [{ name: 'search', arguments: {} }],
      canaryTypes
    );
    expect(report.canaryCalls).toBe(0);
    expect(report.susceptibilityRate).toBe(0);
    expect(report.triggeredAny).toBe(false);
    expect(report.byType.every((s) => !s.triggered)).toBe(true);
  });

  it('handles an empty call log without dividing by zero', () => {
    const report = computeCanarySusceptibility([], canaryTypes);
    expect(report.susceptibilityRate).toBe(0);
    expect(report.totalCalls).toBe(0);
  });
});

describe('buildCanaryVercelEntries', () => {
  it('records calls through onCall and returns a diagnostic string', async () => {
    const canaries = synthesizeCanaryTools(
      [{ name: 'search', inputSchema: { type: 'object' } }],
      { enabled: true, types: ['semantic-decoy'] }
    );
    const canary = canaries[0]!;
    const recorded: Array<{
      name: string;
      args: Record<string, unknown>;
    }> = [];
    const entries = buildCanaryVercelEntries(
      [canary],
      (schema) => schema,
      (name, args) => recorded.push({ name, args })
    );
    const entry = entries[canary.name]!;
    expect(entry).toBeDefined();
    const out = await entry.execute({ q: 'x' });
    expect(out).toContain('canary probe');
    expect(recorded).toEqual([{ name: canary.name, args: { q: 'x' } }]);
  });
});

// Integration test: exercises the wiring through the (non-new) SDK orchestrator
// to prove canary tools are injected into the LLM's tool set and scored.
describe('canary injection through createVercelOrchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jsonSchemaMock.mockImplementation((schema: Record<string, unknown>) => ({
      _type: 'json-schema' as const,
      jsonSchema: schema,
      validate: undefined,
    }));
  });

  it('injects canaries into the SDK tool set and reports susceptibility', async () => {
    const realTools = [
      {
        name: 'search',
        description: 'Search documents',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } },
        },
      },
    ];
    // Pre-compute the canary name the orchestrator will synthesize.
    const decoys = synthesizeCanaryTools(realTools, {
      enabled: true,
      types: ['semantic-decoy'],
    });
    const decoy = decoys[0]!;

    const { createVercelOrchestrator } = await import('./adapters/vercel.js');
    const orchestrator = createVercelOrchestrator();
    const result = await orchestrator.simulate(
      mockMCP(realTools),
      'find docs',
      {
        provider: 'openai',
        canary: { enabled: true, types: ['semantic-decoy'] },
      }
    );

    expect(result.success).toBe(true);
    expect(result.canaryReport).toBeDefined();
    expect(result.canaryReport!.triggeredAny).toBe(true);
    expect(result.canaryReport!.canaryCalls).toBe(1);
    expect(result.canaryReport!.susceptibilityRate).toBe(1);
    expect(
      result.canaryReport!.byType.find((s) => s.type === 'semantic-decoy')
        ?.triggered
    ).toBe(true);

    // The canary was actually present in the tool set offered to the LLM.
    const { generateText } = await import('ai');
    const opts = vi.mocked(generateText).mock.calls[0]?.[0] as {
      tools: Record<string, unknown>;
    };
    expect(opts.tools).toHaveProperty(decoy.name);
  });

  it('omits canaryReport when canary injection is disabled', async () => {
    const { createVercelOrchestrator } = await import('./adapters/vercel.js');
    const orchestrator = createVercelOrchestrator();
    const result = await orchestrator.simulate(
      mockMCP([
        {
          name: 'search',
          description: 's',
          inputSchema: { type: 'object' },
        },
      ]),
      'scenario',
      { provider: 'openai' }
    );

    expect(result.success).toBe(true);
    expect(result.canaryReport).toBeUndefined();
  });
});
