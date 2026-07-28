import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EvalContext, EvalRunnerResult } from './evalRunner.js';
import type { EvalCaseResult } from '../types/reporter.js';
import type { EvalDataset } from './datasetTypes.js';
import type { ProposeVariantsContext } from './variantExperiment.js';

const mocks = vi.hoisted(() => ({ runEvalDataset: vi.fn() }));
vi.mock('./evalRunner.js', () => ({ runEvalDataset: mocks.runEvalDataset }));

// Imported after the mock so runVariantExperiment sees the stubbed runner.
import {
  runEvidenceDrivenExperiment,
  collectEvidence,
  distillLessons,
  compressLessons,
} from './variantEvidenceProposer.js';

interface HostCaseSpec {
  id: string;
  pass?: boolean;
  toolName?: string;
  scenario?: string;
  missed?: string[];
  unexpected?: string[];
  error?: string;
}

function hostCase(spec: HostCaseSpec): EvalCaseResult {
  return {
    id: spec.id,
    datasetName: 'ds',
    toolName: spec.toolName ?? 'search',
    source: 'eval',
    pass: spec.pass ?? false,
    request: { scenario: spec.scenario ?? '' },
    expectations: {},
    durationMs: 1,
    mcpHostTrace: {
      calls: (spec.unexpected ?? []).map((name) => ({
        name,
        arguments: {},
        status: 'unexpected' as const,
      })),
      missed: (spec.missed ?? []).map((name) => ({ name })),
    },
    error: spec.error,
  } as EvalCaseResult;
}

function makeResult(cases: EvalCaseResult[]): EvalRunnerResult {
  return {
    total: cases.length,
    passed: cases.filter((c) => c.pass).length,
    failed: cases.filter((c) => !c.pass).length,
    caseResults: cases,
    durationMs: 1,
  };
}

/** Wire the mocked runner to return a canned result keyed by variant id. */
function setRuns(map: Record<string, EvalRunnerResult>): void {
  mocks.runEvalDataset.mockImplementation(
    async (opts: { toolOverrides?: { id?: string } }) => {
      const key = opts.toolOverrides?.id ?? '__baseline__';
      const result = map[key];
      if (!result) {
        throw new Error(`no mock run registered for "${key}"`);
      }
      return result;
    }
  );
}

const dataset: EvalDataset = { name: 'evidence-proposer-test', cases: [] };
const context = { mcp: {}, testInfo: undefined } as unknown as EvalContext;

beforeEach(() => {
  mocks.runEvalDataset.mockReset();
});

describe('runEvidenceDrivenExperiment — wired into runVariantExperiment', () => {
  it('distills a missed-tool failure into a description variant and wins', async () => {
    const failing = hostCase({
      id: 'c1',
      toolName: 'search',
      scenario: 'find recent quarterly planning documents',
      missed: ['search'],
    });
    const passing = { ...failing, pass: true };

    setRuns({
      __baseline__: makeResult([failing]),
      'evidence-r0-search-under-trigger': makeResult([passing]),
    });

    const result = await runEvidenceDrivenExperiment(
      {
        dataset,
        maxRounds: 2,
        baseDescriptions: { search: 'Search the document corpus.' },
      },
      context
    );

    // The proposer ran in round 0, produced exactly the predicted variant,
    // and the engine scored/ranked it into the winner.
    expect(result.winner?.variant.id).toBe('evidence-r0-search-under-trigger');
    expect(result.proposal?.recommendation).toBe('apply');

    const description = result.winner?.variant.tools.search?.description;
    expect(description).toBeDefined();
    expect(description).toContain('Search the document corpus.');
    expect(description).toContain('Call this tool when the request mentions');
    expect(description).toContain('planning');

    // Round 1: the winning description already carries the distilled terms, so
    // compression leaves nothing net-new and the proposer returns [] — the loop
    // converges (DistillPrompt's termination when no task-specific signal left).
    expect(result.rounds).toHaveLength(1);
    expect(result.reason).toBe('no-improvement');
  });

  it('returns no-variants when there are no failing cases to distill', async () => {
    const passing = hostCase({ id: 'c1', pass: true });
    setRuns({ __baseline__: makeResult([passing]) });

    const result = await runEvidenceDrivenExperiment(
      { dataset, maxRounds: 2 },
      context
    );

    expect(result.reason).toBe('no-variants');
    expect(result.winner).toBeUndefined();
  });
});

describe('collectEvidence / distillLessons — the distillation stages', () => {
  it('extracts under-trigger and over-trigger evidence from traces', () => {
    const evidence = collectEvidence([
      makeResult([
        hostCase({
          id: 'c1',
          scenario: 'find planning documents',
          missed: ['search'],
          unexpected: ['delete'],
        }),
      ]),
    ]);

    const kinds = new Set(evidence.map((e) => `${e.tool}:${e.kind}`));
    expect(kinds).toContain('search:under-trigger');
    expect(kinds).toContain('delete:over-trigger');
    // Scenario text is carried through for the distillation stage.
    expect(evidence.every((e) => e.scenario.includes('planning'))).toBe(true);
  });

  it('distills the discriminating scenario term into a lesson', () => {
    const evidence = collectEvidence([
      makeResult([
        hostCase({
          id: 'c1',
          scenario: 'find recent quarterly planning documents',
          missed: ['search'],
        }),
      ]),
    ]);
    const lessons = distillLessons(evidence, 5);
    const searchLesson = lessons.find(
      (l) => l.tool === 'search' && l.kind === 'under-trigger'
    );
    expect(searchLesson).toBeDefined();
    expect(searchLesson?.terms).toContain('planning');
  });
});

describe('compressLessons — the compression stage', () => {
  it('drops distilled terms already present in the winning description', () => {
    const lessons = distillLessons(
      collectEvidence([
        makeResult([
          hostCase({
            id: 'c1',
            scenario: 'find quarterly planning documents',
            missed: ['search'],
          }),
        ]),
      ]),
      5
    );

    // bestSoFar already integrated "planning" and "documents" into search.
    const ctx = {
      bestSoFar: {
        variant: {
          tools: {
            search: {
              description:
                'Search. Call when planning or documents are wanted.',
            },
          },
        },
      },
    } as unknown as ProposeVariantsContext;

    const compressed = compressLessons(lessons, ctx);
    const search = compressed.find((l) => l.tool === 'search');
    expect(search).toBeDefined();
    expect(search?.terms).not.toContain('planning');
    expect(search?.terms).not.toContain('documents');
  });
});
