import { describe, it, expect } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  extractToolRules,
  suggestRuleExpectations,
  generateRuleCases,
} from './toolRuleExtractor.js';
// Non-new modules — prove the wiring and that emitted cases slot into the
// existing dataset loader/schema.
import { suggestExpectations } from './expectationSuggester.js';
import { validateEvalCase } from '../../evals/datasetTypes.js';

const weatherTool: Tool = {
  name: 'get_weather',
  description:
    'Returns current weather as JSON. The response includes a `temperature` field and a `condition` field. `unit` must be one of: celsius, fahrenheit. Throws an error if the city is not found.',
  inputSchema: {
    type: 'object',
    properties: {
      city: { type: 'string' },
      unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
    },
    required: ['city'],
  },
};

const plainTool: Tool = {
  name: 'ping',
  description: 'A test tool',
  inputSchema: { type: 'object', properties: {} },
};

describe('extractToolRules', () => {
  it('extracts enum, field, format, and error rules from the description', () => {
    const rules = extractToolRules(weatherTool);
    expect(rules.some((r) => r.kind === 'contains' && r.detail === 'temperature'))
      .toBe(true);
    expect(rules.some((r) => r.kind === 'contains' && r.detail === 'condition'))
      .toBe(true);
    expect(
      rules.some((r) => r.kind === 'enum' && r.detail === 'celsius|fahrenheit')
    ).toBe(true);
    expect(rules.some((r) => r.kind === 'pattern' && r.detail === 'json')).toBe(
      true
    );
    expect(
      rules.some((r) => r.kind === 'error' && r.summary === 'Rejects invalid input')
    ).toBe(true);
  });

  it('lifts required fields and enum properties out of the input schema', () => {
    const rules = extractToolRules(weatherTool);
    expect(
      rules.some((r) => r.kind === 'error' && /Requires: city/.test(r.summary))
    ).toBe(true);
    expect(
      rules.some((r) => r.kind === 'enum' && /unit must be one of/.test(r.summary))
    ).toBe(true);
  });

  it('returns no rules for an uninformative description', () => {
    expect(extractToolRules(plainTool)).toHaveLength(0);
  });
});

describe('suggestRuleExpectations', () => {
  it('projects fields to textContains and enums/formats to regex', () => {
    const { textContains, regex } = suggestRuleExpectations(weatherTool);
    expect(textContains).toContain('temperature');
    expect(textContains).toContain('condition');
    expect(regex).toContain('celsius|fahrenheit');
  });

  it('omits a regex for structural formats like JSON', () => {
    const { regex } = suggestRuleExpectations(weatherTool);
    expect(regex.some((r) => /json/i.test(r))).toBe(false);
  });

  it('returns empty suggestions for an uninformative tool', () => {
    expect(suggestRuleExpectations(plainTool)).toEqual({
      textContains: [],
      regex: [],
    });
  });
});

describe('generateRuleCases', () => {
  it('emits a positive case asserting the output contract', () => {
    const cases = generateRuleCases(weatherTool);
    const positive = cases.find((c) => c.id.endsWith('-rules-output'));
    expect(positive).toBeDefined();
    expect(positive?.expect?.containsText).toContain('temperature');
    expect(positive?.expect?.matchesPattern).toContain('celsius|fahrenheit');
    expect(positive?.toolName).toBe('get_weather');
  });

  it('emits a negative case that violates required input', () => {
    const cases = generateRuleCases(weatherTool);
    const negative = cases.find((c) => c.id.endsWith('-rules-invalid-input'));
    expect(negative).toBeDefined();
    expect(negative?.expect?.isError).toBe(true);
    expect(negative?.args).toEqual({});
  });

  it('emits no cases for an uninformative tool', () => {
    expect(generateRuleCases(plainTool)).toHaveLength(0);
  });
});

describe('integration with the generate flow', () => {
  it('surfaces description-grounded rules through suggestExpectations', () => {
    // suggestExpectations is the call site used by the generate command;
    // it now also returns PromptPex-style contract rules.
    const { rules } = suggestExpectations(
      { content: [{ type: 'text', text: '' }] },
      weatherTool
    );
    expect(rules).toBeDefined();
    const errorRules = rules?.filter((r) => r.kind === 'error') ?? [];
    expect(errorRules.some((r) => /Requires: city/.test(r.summary))).toBe(true);
  });

  it('emits cases that round-trip through the dataset schema', () => {
    // The generated { toolName, args, expect } shape must validate against
    // EvalCaseSchema so it loads via loadEvalDataset unchanged.
    const cases = generateRuleCases(weatherTool, { args: { city: 'London' } });
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(() => validateEvalCase(c)).not.toThrow();
    }
  });
});
