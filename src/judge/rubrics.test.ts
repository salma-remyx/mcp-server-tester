import { describe, it, expect } from 'vitest';
import { resolveRubric, isBuiltInRubric, BUILT_IN_RUBRICS } from './rubrics.js';

describe('resolveRubric', () => {
  it('expands "correctness" to a non-empty rubric string', () => {
    const resolved = resolveRubric('correctness');
    expect(resolved).not.toBe('correctness');
    expect(resolved.length).toBeGreaterThan(10);
  });

  it('expands "completeness" to a non-empty rubric string', () => {
    const resolved = resolveRubric('completeness');
    expect(resolved).not.toBe('completeness');
    expect(resolved.length).toBeGreaterThan(10);
  });

  it('expands "groundedness" to a non-empty rubric string', () => {
    const resolved = resolveRubric('groundedness');
    expect(resolved).not.toBe('groundedness');
    expect(resolved.length).toBeGreaterThan(10);
  });

  it('expands "instruction-following" to a non-empty rubric string', () => {
    const resolved = resolveRubric('instruction-following');
    expect(resolved).not.toBe('instruction-following');
    expect(resolved.length).toBeGreaterThan(10);
  });

  it('expands "conciseness" to a non-empty rubric string', () => {
    const resolved = resolveRubric('conciseness');
    expect(resolved).not.toBe('conciseness');
    expect(resolved.length).toBeGreaterThan(10);
  });

  it('returns custom rubric string unchanged', () => {
    const custom = 'My custom rubric for evaluating X';
    expect(resolveRubric(custom)).toBe(custom);
  });

  it('returns unknown single-word strings unchanged', () => {
    expect(resolveRubric('unknown-rubric')).toBe('unknown-rubric');
  });
});

describe('isBuiltInRubric', () => {
  it('returns true for all built-in rubric names', () => {
    for (const name of Object.keys(BUILT_IN_RUBRICS)) {
      expect(isBuiltInRubric(name)).toBe(true);
    }
  });

  it('returns false for custom strings', () => {
    expect(isBuiltInRubric('my-custom-rubric')).toBe(false);
    expect(isBuiltInRubric('')).toBe(false);
    expect(isBuiltInRubric('CORRECTNESS')).toBe(false); // case sensitive
  });
});
