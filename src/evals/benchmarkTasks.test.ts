import { describe, it, expect } from 'vitest';
// Import from NON-NEW modules to prove the dataset round-trips through the
// repo's existing serialization / loader path.
import { validateEvalDataset } from './datasetTypes.js';
import { loadEvalDatasetFromObject } from './datasetLoader.js';
import {
  benchmarkDataset,
  buildBenchmarkDataset,
  loadBenchmarkDataset,
} from './benchmarkTasks.js';
import {
  classifyTaskDifficulty,
  type TaskDifficultyTier,
} from './taskDifficulty.js';

describe('benchmarkDataset', () => {
  it('spans all three difficulty tiers', () => {
    const tiers = new Set(
      benchmarkDataset.cases.map((c) => classifyTaskDifficulty(c))
    );
    expect(tiers.has('single-tool')).toBe(true);
    expect(tiers.has('multi-tool')).toBe(true);
    expect(tiers.has('multi-server')).toBe(true);
  });

  it('every case is mcp_host mode with a tier-consistent difficulty tag', () => {
    for (const evalCase of benchmarkDataset.cases) {
      expect(evalCase.mode).toBe('mcp_host');
      const tierTag = evalCase.tags?.find((t) => t.startsWith('difficulty:'));
      expect(
        tierTag,
        `case ${evalCase.id} lacks a difficulty:<tier> tag`
      ).toBeTruthy();
      const declared = tierTag!.slice(
        'difficulty:'.length
      ) as TaskDifficultyTier;
      // Computed classifier and the declared tag must agree.
      expect(classifyTaskDifficulty(evalCase)).toBe(declared);
    }
  });

  it('validates against the existing EvalDatasetSchema', () => {
    const { schemas: _schemas, ...serializable } = benchmarkDataset;
    // Must not throw — proves the dataset is consumable by runEvalDataset's
    // loader path.
    expect(() => validateEvalDataset(serializable)).not.toThrow();
  });

  it('round-trips through loadEvalDatasetFromObject', () => {
    const { schemas: _schemas, ...serializable } = benchmarkDataset;
    const loaded = loadEvalDatasetFromObject(serializable);
    expect(loaded.cases).toHaveLength(benchmarkDataset.cases.length);
    expect(loaded.name).toBe('mcp-universe-benchmark');
  });
});

describe('buildBenchmarkDataset', () => {
  it('overrides provider, iterations, and accuracyThreshold', () => {
    const dataset = buildBenchmarkDataset({
      provider: 'openai',
      iterations: 5,
      accuracyThreshold: 0.6,
    });
    for (const evalCase of dataset.cases) {
      expect(evalCase.mcpHostConfig?.provider).toBe('openai');
      expect(evalCase.iterations).toBe(5);
      expect(evalCase.accuracyThreshold).toBe(0.6);
    }
  });

  it('restricts to the requested tiers', () => {
    const dataset = buildBenchmarkDataset({ tiers: ['single-tool'] });
    expect(dataset.cases).toHaveLength(2);
    for (const evalCase of dataset.cases) {
      expect(classifyTaskDifficulty(evalCase)).toBe('single-tool');
    }
  });

  it('loadBenchmarkDataset validates and returns the full set', () => {
    const dataset = loadBenchmarkDataset();
    expect(dataset.cases.length).toBeGreaterThanOrEqual(5);
    expect(dataset.metadata?.tiers).toEqual(
      expect.arrayContaining(['single-tool', 'multi-tool', 'multi-server'])
    );
  });
});
