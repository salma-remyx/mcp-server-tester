import { describe, it, expect } from 'vitest';
import {
  validateEvalCase,
  validateEvalDataset,
  EvalCaseSchema,
  type EvalCase,
  type SerializedEvalDataset,
} from './datasetTypes.js';
import { ZodError } from 'zod';

describe('datasetTypes', () => {
  describe('validateEvalCase', () => {
    it('should validate minimal eval case', () => {
      const evalCase = {
        id: 'test-1',
        toolName: 'get_weather',
        args: { city: 'London' },
      };

      const result = validateEvalCase(evalCase);

      expect(result).toEqual(evalCase);
    });

    it('should validate eval case with all fields', () => {
      const evalCase: EvalCase = {
        id: 'test-1',
        description: 'Get weather for London',
        toolName: 'get_weather',
        args: { city: 'London' },
        expect: {
          response: { temperature: 20 },
          schema: 'weather-response',
          passesJudge: {
            rubric: 'Should contain temperature',
            configId: 'weather-judge',
          },
        },
        metadata: { priority: 'high' },
      };

      const result = validateEvalCase(evalCase);

      expect(result).toEqual(evalCase);
    });

    it('should reject eval case without id', () => {
      const evalCase = {
        toolName: 'get_weather',
        args: {},
      };

      expect(() => validateEvalCase(evalCase)).toThrow(ZodError);
    });

    it('should reject eval case with empty id', () => {
      const evalCase = {
        id: '',
        toolName: 'get_weather',
        args: {},
      };

      expect(() => validateEvalCase(evalCase)).toThrow(ZodError);
    });

    it('should accept eval case without toolName (for llm_host mode)', () => {
      const evalCase = {
        id: 'test-1',
        mode: 'llm_host' as const,
        scenario: 'Get the weather for London',
      };

      expect(() => validateEvalCase(evalCase)).not.toThrow();
    });

    it('should reject eval case with empty toolName', () => {
      const evalCase = {
        id: 'test-1',
        toolName: '',
        args: {},
      };

      expect(() => validateEvalCase(evalCase)).toThrow(ZodError);
    });

    it('should accept eval case without args (for llm_host mode)', () => {
      const evalCase = {
        id: 'test-1',
        mode: 'llm_host' as const,
        scenario: 'Get the weather for London',
      };

      expect(() => validateEvalCase(evalCase)).not.toThrow();
    });

    it('should accept eval case with complex args', () => {
      const evalCase = {
        id: 'test-1',
        toolName: 'search',
        args: {
          query: 'test',
          filters: { type: 'document', date: '2024-01-01' },
          limit: 10,
        },
      };

      const result = validateEvalCase(evalCase);

      expect(result.args).toEqual(evalCase.args);
    });
  });

  describe('iterations and accuracyThreshold', () => {
    it('should accept iterations and accuracyThreshold on a case', () => {
      const raw = {
        name: 'test',
        cases: [
          {
            id: 'multi-iter',
            toolName: 'add',
            args: { a: 1, b: 2 },
            iterations: 5,
            accuracyThreshold: 0.8,
          },
        ],
      };
      const result = validateEvalDataset(raw);
      expect(result.cases[0]!.iterations).toBe(5);
      expect(result.cases[0]!.accuracyThreshold).toBe(0.8);
    });

    it('should reject iterations below 1', () => {
      const raw = {
        name: 'test',
        cases: [{ id: 'bad', toolName: 'add', args: {}, iterations: 0 }],
      };
      expect(() => validateEvalDataset(raw)).toThrow();
    });

    it('should reject accuracyThreshold outside 0-1', () => {
      const raw = {
        name: 'test',
        cases: [
          { id: 'bad', toolName: 'add', args: {}, accuracyThreshold: 1.5 },
        ],
      };
      expect(() => validateEvalDataset(raw)).toThrow();
    });
  });

  describe('judgeReps', () => {
    it('accepts judgeReps as a positive integer', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        judgeReps: 3,
      });
      expect(result.success).toBe(true);
    });

    it('rejects judgeReps: 0', () => {
      const result = EvalCaseSchema.safeParse({ id: 'test', judgeReps: 0 });
      expect(result.success).toBe(false);
    });

    it('rejects judgeReps: -1', () => {
      const result = EvalCaseSchema.safeParse({ id: 'test', judgeReps: -1 });
      expect(result.success).toBe(false);
    });

    it('accepts passesJudge.reps', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        expect: { passesJudge: { rubric: 'Is it good?', reps: 5 } },
      });
      expect(result.success).toBe(true);
    });

    it('rejects passesJudge.reps: 0', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        expect: { passesJudge: { rubric: 'Is it good?', reps: 0 } },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('toolsTriggered and toolCallCount', () => {
    it('should preserve toolsTriggered in expect block after validation', () => {
      const raw = {
        name: 'test',
        cases: [
          {
            id: 'tool-trigger-test',
            mode: 'llm_host',
            scenario: 'Search for documents',
            llmHostConfig: { provider: 'openai' },
            expect: {
              toolsTriggered: {
                calls: [{ name: 'search', required: true }],
                order: 'any',
              },
              toolCallCount: { min: 1, max: 3 },
            },
          },
        ],
      };
      const result = validateEvalDataset(raw);
      expect(result.cases[0]!.expect?.toolsTriggered).toBeDefined();
      expect(result.cases[0]!.expect?.toolsTriggered?.calls[0]!.name).toBe(
        'search'
      );
      expect(result.cases[0]!.expect?.toolCallCount?.min).toBe(1);
    });
  });

  describe('canonicalAnswer', () => {
    it('accepts a canonical answer string', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        canonicalAnswer: 'Paris is the capital of France.',
      });
      expect(result.success).toBe(true);
    });

    it('is optional — case without canonicalAnswer still validates', () => {
      const result = EvalCaseSchema.safeParse({ id: 'test' });
      expect(result.success).toBe(true);
    });
  });

  describe('LLMProvider expansion', () => {
    it('should accept new provider values in llmHostConfig', () => {
      const providers = [
        'openai',
        'anthropic',
        'google',
        'mistral',
        'azure',
        'ollama',
        'deepseek',
        'openrouter',
        'xai',
      ];
      for (const provider of providers) {
        expect(() =>
          validateEvalDataset({
            name: 'test',
            cases: [
              {
                id: 'c',
                mode: 'llm_host',
                scenario: 's',
                llmHostConfig: { provider },
              },
            ],
          })
        ).not.toThrow();
      }
    });
  });

  describe('validateEvalDataset', () => {
    it('should validate minimal dataset', () => {
      const dataset: SerializedEvalDataset = {
        name: 'test-dataset',
        cases: [
          {
            id: 'case-1',
            toolName: 'get_weather',
            args: {},
          },
        ],
      };

      const result = validateEvalDataset(dataset);

      expect(result).toEqual(dataset);
    });

    it('should validate dataset with all fields', () => {
      const dataset: SerializedEvalDataset = {
        name: 'test-dataset',
        description: 'Test dataset for weather tools',
        cases: [
          {
            id: 'case-1',
            toolName: 'get_weather',
            args: { city: 'London' },
          },
          {
            id: 'case-2',
            toolName: 'get_forecast',
            args: { city: 'Paris', days: 7 },
          },
        ],
        metadata: {
          version: '1.0',
          author: 'test',
        },
      };

      const result = validateEvalDataset(dataset);

      expect(result).toEqual(dataset);
    });

    it('should reject dataset without name', () => {
      const dataset = {
        cases: [
          {
            id: 'case-1',
            toolName: 'test',
            args: {},
          },
        ],
      };

      expect(() => validateEvalDataset(dataset)).toThrow(ZodError);
    });

    it('should reject dataset with empty name', () => {
      const dataset = {
        name: '',
        cases: [
          {
            id: 'case-1',
            toolName: 'test',
            args: {},
          },
        ],
      };

      expect(() => validateEvalDataset(dataset)).toThrow(ZodError);
    });

    it('should reject dataset without cases', () => {
      const dataset = {
        name: 'test-dataset',
      };

      expect(() => validateEvalDataset(dataset)).toThrow(ZodError);
    });

    it('should reject dataset with empty cases array', () => {
      const dataset = {
        name: 'test-dataset',
        cases: [],
      };

      expect(() => validateEvalDataset(dataset)).toThrow(ZodError);
    });

    it('should reject dataset with invalid case', () => {
      const dataset = {
        name: 'test-dataset',
        cases: [
          {
            // missing id - this is always required
            toolName: 'get_weather',
            args: {},
          },
        ],
      };

      expect(() => validateEvalDataset(dataset)).toThrow(ZodError);
    });

    it('should validate dataset with multiple cases', () => {
      const dataset: SerializedEvalDataset = {
        name: 'test-dataset',
        cases: Array.from({ length: 10 }, (_, i) => ({
          id: `case-${i}`,
          toolName: 'test',
          args: { index: i },
        })),
      };

      const result = validateEvalDataset(dataset);

      expect(result.cases).toHaveLength(10);
    });
  });
});
