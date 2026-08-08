import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { MCPFixtureApi } from '../../mcp/fixtures/mcpFixture.js';
import {
  CANARY_TYPES,
  CANARY_TYPE_DESCRIPTIONS,
  createCanaryTool,
  generateCanaryProbes,
  createCanaryAugmentedMCP,
  computeCanarySusceptibility,
} from './canaryTools.js';

function createMockMCP(tools: Tool[]): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
    project: 'test',
    getServerInfo: vi.fn().mockReturnValue(null),
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'real' }],
      isError: false,
    }),
  };
}

describe('canaryTools taxonomy + generation', () => {
  it('exposes all six taxonomy types with descriptions', () => {
    expect(CANARY_TYPES).toHaveLength(6);
    for (const type of CANARY_TYPES) {
      expect(typeof CANARY_TYPE_DESCRIPTIONS[type]).toBe('string');
    }
  });

  it('builds a canary from a per-type template', () => {
    const canary = createCanaryTool({
      name: 'canary_semantic_decoy',
      type: 'semantic_decoy',
      topic: 'invoice',
    });
    expect(canary.name).toBe('canary_semantic_decoy');
    expect(canary.type).toBe('semantic_decoy');
    expect(canary.description).toContain('invoice');
    expect(canary.inputSchema).toBeDefined();
    expect(canary.responseText).toContain('canary decoy');
  });

  it('honors explicit overrides over templates', () => {
    const canary = createCanaryTool({
      name: 'lure',
      type: 'capability_mirage',
      description: 'custom lure',
      inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
      responseText: 'custom decoy',
    });
    expect(canary.description).toBe('custom lure');
    expect(canary.responseText).toBe('custom decoy');
  });

  it('generates one probe per taxonomy type with stable names', () => {
    const probes = generateCanaryProbes({ prefix: 'trap', topic: 'policy' });
    expect(probes).toHaveLength(6);
    expect(probes.map((p) => p.name).sort()).toEqual(
      [...CANARY_TYPES].map((t) => `trap_${t}`).sort()
    );
    expect(probes[0]).toMatchObject({ type: CANARY_TYPES[0] });
  });
});

describe('createCanaryAugmentedMCP', () => {
  it('plants canaries alongside real tools without overriding them', async () => {
    const mcp = createMockMCP([
      {
        name: 'search',
        description: 'Search',
        inputSchema: { type: 'object' },
      },
    ]);
    const canaries = generateCanaryProbes({ topic: 'doc' });

    const augmented = createCanaryAugmentedMCP(mcp, canaries);
    const tools = await augmented.listTools();

    expect(tools.map((t) => t.name)).toEqual([
      'search',
      ...canaries.map((c) => c.name),
    ]);
    // Planted canary carries its lure description + schema.
    const planted = tools.find((t) => t.name === canaries[0]!.name)!;
    expect(planted.description).toBe(canaries[0]!.description);
    expect(planted.inputSchema).toBe(canaries[0]!.inputSchema);
  });

  it('returns a decoy result when a canary is called and forwards real calls', async () => {
    const mcp = createMockMCP([
      {
        name: 'search',
        description: 'Search',
        inputSchema: { type: 'object' },
      },
    ]);
    const canary = createCanaryTool({
      name: 'trap_capability_mirage',
      type: 'capability_mirage',
    });

    const augmented = createCanaryAugmentedMCP(mcp, [canary]);
    const decoy = await augmented.callTool('trap_capability_mirage', {});
    expect(decoy).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: canary.responseText }],
    });
    expect(mcp.callTool).not.toHaveBeenCalled();

    await augmented.callTool('search', { q: 'x' });
    expect(mcp.callTool).toHaveBeenCalledWith('search', { q: 'x' });
  });
});

describe('computeCanarySusceptibility', () => {
  const probes = generateCanaryProbes({ topic: 'doc' });

  it('reports csr 0 with an empty trace (model avoided every canary)', () => {
    const profile = computeCanarySusceptibility([], probes);
    expect(profile.csr).toBe(0);
    expect(profile.triggeredCanaries).toEqual([]);
    expect(profile.avoidedCanaries).toEqual(probes.map((p) => p.name));
    for (const type of CANARY_TYPES) {
      expect(profile.perType[type]).toBe(0);
    }
  });

  it('profiles a multi-dimensional susceptibility from a tool-call trace', () => {
    const baitName = probes[0]!.name; // semantic_decoy
    const profile = computeCanarySusceptibility(
      [{ name: baitName, arguments: {} }],
      probes
    );
    expect(profile.csr).toBeCloseTo(1 / 6, 5);
    expect(profile.triggeredCanaries).toEqual([baitName]);
    expect(profile.perType.semantic_decoy).toBe(1);
    // Other types unaffected.
    expect(profile.perType.capability_mirage).toBe(0);
  });

  it('handles an empty canary set without dividing by zero', () => {
    const profile = computeCanarySusceptibility(
      [{ name: 'whatever', arguments: {} }],
      []
    );
    expect(profile.csr).toBe(0);
    expect(profile.triggeredCanaries).toEqual([]);
  });
});
