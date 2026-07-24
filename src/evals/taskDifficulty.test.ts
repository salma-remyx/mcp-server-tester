import { describe, it, expect } from 'vitest';
import type { EvalCase } from './datasetTypes.js';
import {
  classifyTaskDifficulty,
  difficultyTierTag,
  groupCasesByDifficulty,
  isTaskDifficultyTier,
  sliceByDifficulty,
  DIFFICULTY_TIERS,
} from './taskDifficulty.js';

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return { id: 'c', toolName: 't', args: {}, ...overrides };
}

describe('isTaskDifficultyTier', () => {
  it('accepts the three known tiers', () => {
    for (const tier of DIFFICULTY_TIERS) {
      expect(isTaskDifficultyTier(tier)).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(isTaskDifficultyTier('hard')).toBe(false);
    expect(isTaskDifficultyTier(undefined)).toBe(false);
    expect(isTaskDifficultyTier(3)).toBe(false);
  });
});

describe('difficultyTierTag', () => {
  it('prefixes the tier with difficulty:', () => {
    expect(difficultyTierTag('single-tool')).toBe('difficulty:single-tool');
    expect(difficultyTierTag('multi-server')).toBe('difficulty:multi-server');
  });
});

describe('classifyTaskDifficulty', () => {
  it('honors the metadata.difficultyTier override above all structural signals', () => {
    const evalCase = makeCase({
      metadata: { difficultyTier: 'multi-server' },
      expect: { toolsTriggered: { calls: [{ name: 'a' }] } },
    });
    // structurally single-tool, but override wins
    expect(classifyTaskDifficulty(evalCase)).toBe('multi-server');
  });

  it('honors a difficulty:<tier> tag when no metadata override is set', () => {
    const evalCase = makeCase({
      tags: ['difficulty:multi-tool', 'filesystem'],
      expect: { toolsTriggered: { calls: [{ name: 'a' }] } },
    });
    expect(classifyTaskDifficulty(evalCase)).toBe('multi-tool');
  });

  it('prefers the metadata override over a conflicting tag', () => {
    const evalCase = makeCase({
      tags: ['difficulty:single-tool'],
      metadata: { difficultyTier: 'multi-tool' },
    });
    expect(classifyTaskDifficulty(evalCase)).toBe('multi-tool');
  });

  it('classifies a single expected tool as single-tool', () => {
    const evalCase = makeCase({
      expect: { toolsTriggered: { calls: [{ name: 'read_file' }] } },
    });
    expect(classifyTaskDifficulty(evalCase)).toBe('single-tool');
  });

  it('classifies several expected tools as multi-tool', () => {
    const evalCase = makeCase({
      expect: {
        toolsTriggered: {
          calls: [{ name: 'list_directory' }, { name: 'read_file' }],
        },
      },
    });
    expect(classifyTaskDifficulty(evalCase)).toBe('multi-tool');
  });

  it('classifies a large toolCallCount.max budget as multi-tool', () => {
    const evalCase = makeCase({
      expect: { toolCallCount: { max: 6 } },
    });
    expect(classifyTaskDifficulty(evalCase)).toBe('multi-tool');
  });

  it('detects multi-server from metadata.crossServer', () => {
    const evalCase = makeCase({
      metadata: { crossServer: true },
      expect: { toolsTriggered: { calls: [{ name: 'a' }] } },
    });
    expect(classifyTaskDifficulty(evalCase)).toBe('multi-server');
  });

  it('detects multi-server from cross-server scenario phrasing', () => {
    const evalCase = makeCase({
      scenario:
        'Using both the filesystem server and the github server, compare versions.',
      expect: { toolsTriggered: { calls: [{ name: 'a' }] } },
    });
    expect(classifyTaskDifficulty(evalCase)).toBe('multi-server');
  });

  it('defaults a signal-less case to single-tool', () => {
    expect(classifyTaskDifficulty(makeCase())).toBe('single-tool');
  });
});

describe('sliceByDifficulty', () => {
  it('keeps only cases whose tier is in the allow-list', () => {
    const cases = [
      makeCase({ id: 'a', tags: ['difficulty:single-tool'] }),
      makeCase({ id: 'b', tags: ['difficulty:multi-tool'] }),
      makeCase({ id: 'c', tags: ['difficulty:multi-server'] }),
      makeCase({ id: 'd', tags: ['difficulty:single-tool'] }),
    ];
    const result = sliceByDifficulty(cases, ['single-tool']);
    expect(result.map((c) => c.id)).toEqual(['a', 'd']);
  });
});

describe('groupCasesByDifficulty', () => {
  it('buckets every case under its computed tier', () => {
    const cases = [
      makeCase({ id: 'a', tags: ['difficulty:single-tool'] }),
      makeCase({ id: 'b', tags: ['difficulty:multi-tool'] }),
      makeCase({ id: 'c', metadata: { crossServer: true } }),
    ];
    const groups = groupCasesByDifficulty(cases);
    expect(groups['single-tool'].map((c) => c.id)).toEqual(['a']);
    expect(groups['multi-tool'].map((c) => c.id)).toEqual(['b']);
    expect(groups['multi-server'].map((c) => c.id)).toEqual(['c']);
  });
});
