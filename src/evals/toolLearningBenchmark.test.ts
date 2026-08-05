import { describe, it, expect } from 'vitest';
// Existing (non-new) modules — exercising these proves the benchmark integrates
// with the framework's verified dataset contract, not just self-consistency.
import {
  EvalCaseSchema,
  EvalDatasetSchema,
  validateEvalDataset,
} from './datasetTypes.js';
import { loadEvalDatasetFromObject } from './datasetLoader.js';
import {
  buildToolLearningBenchmark,
  countBenchmarkDifficulty,
  loadToolLearningBenchmark,
  sealToolsCatalog,
} from './toolLearningBenchmark.js';

describe('toolLearningBenchmark', () => {
  const dataset = buildToolLearningBenchmark();

  describe('contract conformance (existing validators)', () => {
    it('is accepted by the existing EvalDatasetSchema validator', () => {
      // This is the integration assertion: the framework's real validator
      // (the one loadEvalDataset / runEvalDataset rely on) parses the dataset.
      const parsed = validateEvalDataset(dataset);
      expect(parsed.name).toBe('seal-tools-tool-learning');
      expect(parsed.cases.length).toBe(dataset.cases.length);
    });

    it('parses as a full EvalDataset via the existing loader', () => {
      const loaded = loadToolLearningBenchmark();
      // loadEvalDatasetFromObject re-validates and attaches a schemas record.
      expect(loaded.schemas).toEqual({});
      expect(EvalDatasetSchema.safeParse(loaded).success).toBe(true);
    });

    it('loadToolLearningBenchmark and loadEvalDatasetFromObject agree', () => {
      const viaExisting = loadEvalDatasetFromObject(dataset);
      const viaBenchmark = loadToolLearningBenchmark();
      expect(viaBenchmark.cases.map((c) => c.id)).toEqual(
        viaExisting.cases.map((c) => c.id)
      );
    });
  });

  describe('instance shape', () => {
    it('every case parses against the existing EvalCaseSchema', () => {
      for (const entry of dataset.cases) {
        expect(EvalCaseSchema.safeParse(entry).success).toBe(true);
      }
    });

    it('direct cases carry toolName + args', () => {
      const direct = dataset.cases.filter(
        (c) => (c.mode ?? 'direct') === 'direct'
      );
      expect(direct.length).toBeGreaterThanOrEqual(1);
      for (const entry of direct) {
        expect(entry.toolName).toBeDefined();
        expect(entry.args).toBeDefined();
      }
    });

    it('mcp_host cases carry a scenario + toolsTriggered expectation', () => {
      const host = dataset.cases.filter((c) => c.mode === 'mcp_host');
      expect(host.length).toBeGreaterThanOrEqual(1);
      for (const entry of host) {
        expect(entry.scenario).toBeDefined();
        expect(entry.expect?.toolsTriggered).toBeDefined();
      }
    });

    it('includes hard multi-tool instances requiring 2+ composed calls', () => {
      const hard = dataset.cases.filter((c) => c.tags?.includes('hard'));
      expect(hard.length).toBeGreaterThanOrEqual(1);
      for (const entry of hard) {
        const required = (entry.expect?.toolsTriggered?.calls ?? []).filter(
          (c) => c.required !== false
        );
        expect(required.length).toBeGreaterThanOrEqual(2);
        // Hard cases assert a tool-call budget via the existing toolCallCount block.
        expect(entry.expect?.toolCallCount).toBeDefined();
      }
    });
  });

  describe('catalog + metadata', () => {
    it('every tool referenced by a case exists in the catalog', () => {
      const known = new Set(sealToolsCatalog.map((t) => t.name));
      const referenced = new Set<string>();
      for (const entry of dataset.cases) {
        if (entry.toolName) referenced.add(entry.toolName);
        for (const call of entry.expect?.toolsTriggered?.calls ?? []) {
          referenced.add(call.name);
        }
      }
      for (const name of referenced) {
        expect(known.has(name)).toBe(true);
      }
    });

    it('difficulty bands sum to the case count and include hard cases', () => {
      const bands = countBenchmarkDifficulty(dataset.cases);
      const total = bands.easy + bands.medium + bands.hard;
      expect(total).toBe(dataset.cases.length);
      expect(bands.hard).toBeGreaterThanOrEqual(1);
      expect(dataset.metadata?.bands).toEqual(bands);
    });
  });
});
