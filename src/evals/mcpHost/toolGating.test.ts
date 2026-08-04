import { describe, it, expect } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  tokenize,
  scoreToolRelevance,
  gateTools,
  trimToolSchema,
  buildGatedTools,
} from './toolGating.js';

function tool(name: string, description: string): Tool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
  };
}

describe('tokenize', () => {
  it('splits camelCase, snake_case, and punctuation, dropping stopwords', () => {
    expect(tokenize('Search the getWeatherForecast!')).toEqual([
      'search',
      'weather',
      'forecast',
    ]);
  });

  it('drops single characters and stopwords', () => {
    expect(tokenize('a the of in')).toEqual([]);
  });
});

describe('scoreToolRelevance', () => {
  const scenarioTokens = tokenize('search the documentation');

  it('scores 1.0 when the tool covers every scenario token', () => {
    expect(
      scoreToolRelevance(
        scenarioTokens,
        tool('search_docs', 'Search documentation')
      )
    ).toBe(1);
  });

  it('scores 0 when there is no overlap', () => {
    expect(
      scoreToolRelevance(scenarioTokens, tool('send_email', 'Send an email'))
    ).toBe(0);
  });

  it('scores 0 when there are no scenario tokens', () => {
    expect(scoreToolRelevance([], tool('search', 'Search'))).toBe(0);
  });
});

describe('gateTools', () => {
  const catalog: Tool[] = [
    tool('search_docs', 'Search documentation'),
    tool('send_email', 'Send an email message'),
    tool('create_event', 'Create a calendar event'),
  ];

  it('keeps everything by default (no filters set)', () => {
    const { tools, scores } = gateTools('search docs', catalog, {});
    expect(tools).toHaveLength(3);
    expect(scores).toHaveLength(3);
  });

  it('caps to the top-k by relevance', () => {
    const { tools } = gateTools('search the documentation', catalog, {
      maxTools: 1,
    });
    expect(tools.map((t) => t.name)).toEqual(['search_docs']);
  });

  it('drops tools below minRelevance', () => {
    const { tools } = gateTools('search the documentation', catalog, {
      minRelevance: 0.5,
    });
    expect(tools.map((t) => t.name)).toEqual(['search_docs']);
  });

  it('forces alwaysInclude tools to be kept', () => {
    const { tools } = gateTools('search the documentation', catalog, {
      minRelevance: 0.9,
      alwaysInclude: ['send_email'],
    });
    expect(tools.map((t) => t.name).sort()).toEqual([
      'search_docs',
      'send_email',
    ]);
  });

  it('sorts scores by relevance descending', () => {
    const { scores } = gateTools('search the documentation', catalog, {});
    const relevances = scores.map((s) => s.relevance);
    expect(relevances).toEqual([...relevances].sort((a, b) => b - a));
  });
});

describe('trimToolSchema', () => {
  it('keeps type, property names + top-level types, and required', () => {
    const trimmed = trimToolSchema({
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'verbose',
          enum: ['a', 'b', 'c'],
          format: 'email',
        },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['query'],
      additionalProperties: false,
    });

    expect(trimmed).toEqual({
      type: 'object',
      properties: { query: { type: 'string' }, tags: { type: 'array' } },
      required: ['query'],
    });
  });

  it('always emits type object even when omitted', () => {
    const trimmed = trimToolSchema({ properties: { a: { type: 'string' } } });
    expect(trimmed.type).toBe('object');
  });
});

describe('buildGatedTools', () => {
  const catalog: Tool[] = [
    tool('search_docs', 'Search documentation'),
    tool('send_email', 'Send an email'),
  ];

  it('is a no-op without config', () => {
    const { tools, report } = buildGatedTools('search docs', catalog);
    expect(tools).toHaveLength(2);
    expect(report.enabled).toBe(false);
    expect(report.exposedCount).toBe(2);
    expect(report.droppedNames).toEqual([]);
  });

  it('gates and trims schemas when configured', () => {
    const full: Tool[] = [
      {
        name: 'search_docs',
        description: 'Search documentation',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', enum: ['a', 'b'] } },
        },
      },
      {
        name: 'send_email',
        description: 'Send an email',
        inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
      },
    ];

    const { tools, report } = buildGatedTools(
      'search the documentation',
      full,
      {
        maxTools: 1,
        lazySchema: true,
      }
    );

    expect(report.enabled).toBe(true);
    expect(report.lazySchema).toBe(true);
    expect(report.exposedCount).toBe(1);
    expect(report.droppedNames).toEqual(['send_email']);
    expect(tools[0]?.name).toBe('search_docs');
    // Schema was trimmed to a skeleton
    expect(tools[0]?.inputSchema).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
    });
  });
});
