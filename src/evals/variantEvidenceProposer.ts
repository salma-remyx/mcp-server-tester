import { runVariantExperiment } from './variantExperiment.js';
import type {
  ProposeVariantsContext,
  VariantExperimentOptions,
  VariantExperimentResult,
} from './variantExperiment.js';
import type {
  EvalContext,
  EvalRunnerResult,
  ToolMetadataOverride,
  ToolOverrideVariant,
} from './evalRunner.js';
import type { EvalCaseResult } from '../types/reporter.js';

/**
 * Evidence-distillation variant proposer — a built-in `proposeVariants` policy
 * for {@link runVariantExperiment}.
 *
 * The library ships the experiment *mechanism* (baseline, scoring, ranking,
 * regression guarding) but deliberately leaves the *policy* — which variant to
 * try next — to the caller via the `proposeVariants` hook. This module is one
 * such policy: it turns failed-case evidence into improved tool-description
 * variants, so the experiment can optimize the "prompt" an MCP host sees (the
 * per-tool `description`) without a human in the loop.
 *
 * Adapted from the non-gradient autoprompting pipeline of *DistillPrompt*
 * ("Automatic Prompt Optimization with Prompt Distillation", arXiv:2508.18992),
 * which integrates task-specific information into prompts through a multi-stage
 * loop. This implementation keeps that loop's four stages at full fidelity:
 *
 *   1. **Collect**   — gather task-specific data from failing cases (required
 *                      tools the host never called, tools it called wrongly,
 *                      and tool errors) plus the scenario text of each failure.
 *   2. **Distill**   — collapse raw failures into a concise per-tool "lesson"
 *                      (the discriminating terms that recurred across the
 *                      scenarios where the tool mis-triggered).
 *   3. **Compress**  — drop lessons whose terms are already present in the
 *                      tool's current description, so each round only carries
 *                      net-new signal (DistillPrompt's compression stage).
 *   4. **Integrate** — rewrite each affected tool's `description` with a
 *                      focused directive derived from the lesson, emitted as a
 *                      `ToolOverrideVariant` for the engine to score.
 *
 * The paper performs the distill/compress stages with an LLM; here they are
 * replaced by a parameter-free vocab-frequency + dedup proxy (Mode 2 adapted
 * port). That keeps the loop deterministic, free, and runnable offline while
 * preserving the core mechanism — distilling task-specific failure evidence
 * into the prompt being optimized. Returning `[]` (no net-new lesson) lets the
 * experiment converge, exactly as the loop terminates when no task-specific
 * signal remains.
 */

/** Direction in which a tool's description is off, distilled from a failure. */
export type EvidenceKind = 'under-trigger' | 'over-trigger' | 'error';

/** One piece of task-specific evidence extracted from a failing eval case. */
export interface ToolEvidence {
  /** Canonical MCP tool name the evidence concerns. */
  tool: string;
  /** How the description mis-served the host for this case. */
  kind: EvidenceKind;
  /** ID of the failing case that produced this evidence. */
  caseId: string;
  /** Natural-language scenario (or description) the host was given. */
  scenario: string;
  /** Tool error string, when the failure was a tool error. */
  error?: string;
}

/** A compressed, per-tool directive distilled from one or more pieces of evidence. */
export interface ToolLesson {
  tool: string;
  kind: EvidenceKind;
  /** Distilled, de-duplicated trigger terms (net-new vs. the current description). */
  terms: string[];
  /** Sample error text, for `error` lessons. */
  errorSample?: string;
}

/** Options for {@link createVariantEvidenceProposer} / {@link proposeEvidenceVariants}. */
export interface EvidenceProposerOptions {
  /**
   * Original tool descriptions, keyed by canonical tool name. When supplied,
   * lessons are appended to the real description rather than standing alone.
   * Fetch from `mcp.listTools()` at the call site.
   */
  baseDescriptions?: Record<string, string>;
  /** Max distilled terms kept per lesson. @default 5 */
  maxTerms?: number;
}

/**
 * Options for {@link runEvidenceDrivenExperiment}: a `VariantExperimentOptions`
 * minus its `proposeVariants` hook (this module supplies it) plus proposer knobs.
 */
export type EvidenceDrivenExperimentOptions = Omit<
  VariantExperimentOptions,
  'proposeVariants'
> &
  EvidenceProposerOptions;

const DEFAULT_MAX_TERMS = 5;

/** Common English function words filtered out during distillation. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'that',
  'this',
  'these',
  'those',
  'with',
  'from',
  'your',
  'have',
  'will',
  'about',
  'into',
  'some',
  'what',
  'when',
  'which',
  'their',
  'there',
  'then',
  'than',
  'them',
  'were',
  'they',
  'been',
  'more',
  'such',
  'want',
  'wants',
  'need',
  'needs',
  'using',
  'please',
  'should',
  'would',
  'could',
  'does',
  'done',
]);

/**
 * Builds a `proposeVariants` callback that distills failure evidence into
 * tool-description variants. Drop the result straight into
 * `VariantExperimentOptions.proposeVariants`.
 *
 * @example
 * ```typescript
 * const result = await runVariantExperiment(
 *   {
 *     dataset,
 *     maxRounds: 3,
 *     proposeVariants: createVariantEvidenceProposer({ baseDescriptions }),
 *   },
 *   { mcp, testInfo }
 * );
 * ```
 */
export function createVariantEvidenceProposer(
  options?: EvidenceProposerOptions
): (context: ProposeVariantsContext) => Promise<ToolOverrideVariant[]> {
  return (context: ProposeVariantsContext) =>
    proposeEvidenceVariants(context, options);
}

/**
 * Convenience wrapper that runs {@link runVariantExperiment} with the
 * evidence-distillation proposer wired in as its `proposeVariants` policy.
 * This is the simplest entry point for an AI/agent to drive tool-description
 * optimization from eval failures.
 */
export async function runEvidenceDrivenExperiment(
  options: EvidenceDrivenExperimentOptions,
  context: EvalContext
): Promise<VariantExperimentResult> {
  const { baseDescriptions, maxTerms, ...experimentOptions } = options;
  return runVariantExperiment(
    {
      ...experimentOptions,
      proposeVariants: createVariantEvidenceProposer({
        baseDescriptions,
        maxTerms,
      }),
    },
    context
  );
}

/**
 * Core policy: reads failure evidence from the baseline and prior rounds,
 * distills it into net-new description amendments, and returns one variant per
 * affected tool for the experiment to score. Returns `[]` when there is no
 * net-new signal, letting the experiment converge.
 */
export async function proposeEvidenceVariants(
  context: ProposeVariantsContext,
  options?: EvidenceProposerOptions
): Promise<ToolOverrideVariant[]> {
  const maxTerms = options?.maxTerms ?? DEFAULT_MAX_TERMS;

  // 1. COLLECT — task-specific data from every failing case seen so far.
  const results: EvalRunnerResult[] = [
    context.baseline,
    ...collectHistoryResults(context),
  ];
  const evidence = collectEvidence(results);
  if (evidence.length === 0) {
    return [];
  }

  // 2. DISTILL — collapse evidence into per-tool lessons.
  const lessons = distillLessons(evidence, maxTerms);

  // 3. COMPRESS — drop terms already present in each tool's current description.
  const compressed = compressLessons(
    lessons,
    context,
    options?.baseDescriptions
  );
  if (compressed.length === 0) {
    return [];
  }

  // 4. INTEGRATE — rewrite descriptions and emit variants.
  const base = options?.baseDescriptions ?? {};
  return compressed.map((lesson) => buildVariant(context.round, lesson, base));
}

/** Flatten every scored candidate's result from prior rounds. */
function collectHistoryResults(
  context: ProposeVariantsContext
): EvalRunnerResult[] {
  const out: EvalRunnerResult[] = [];
  for (const round of context.history) {
    for (const candidate of round.candidates) {
      out.push(candidate.result);
    }
  }
  return out;
}

/**
 * COLLECT stage. For each failing case, records how each tool's description
 * mis-served the host: a required tool never called (`under-trigger`), a tool
 * called when it was not expected (`over-trigger`), or a tool error.
 */
export function collectEvidence(results: EvalRunnerResult[]): ToolEvidence[] {
  const out: ToolEvidence[] = [];
  for (const result of results) {
    for (const caseResult of result.caseResults) {
      if (caseResult.pass) {
        continue;
      }
      collectFromCase(caseResult, out);
    }
  }
  return out;
}

function collectFromCase(
  caseResult: EvalCaseResult,
  out: ToolEvidence[]
): void {
  const scenario =
    caseResult.request?.scenario ?? caseResult.request?.description ?? '';
  const trace = caseResult.mcpHostTrace;
  if (trace) {
    for (const missed of trace.missed) {
      out.push({
        tool: missed.name,
        kind: 'under-trigger',
        caseId: caseResult.id,
        scenario,
      });
    }
    for (const call of trace.calls) {
      if (call.status === 'unexpected') {
        out.push({
          tool: call.name,
          kind: 'over-trigger',
          caseId: caseResult.id,
          scenario,
        });
      }
    }
  }
  if (caseResult.error && caseResult.toolName) {
    out.push({
      tool: caseResult.toolName,
      kind: 'error',
      caseId: caseResult.id,
      scenario,
      error: caseResult.error,
    });
  }
}

/**
 * DISTILL stage. Groups evidence by tool + kind and extracts the most frequent
 * discriminating terms from the failing scenarios. This vocab-frequency proxy
 * stands in for the paper's LLM-based distillation.
 */
export function distillLessons(
  evidence: ToolEvidence[],
  maxTerms: number
): ToolLesson[] {
  const groups = new Map<string, ToolEvidence[]>();
  for (const item of evidence) {
    const key = `${item.tool}|${item.kind}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  const lessons: ToolLesson[] = [];
  for (const [, bucket] of groups) {
    const first = bucket[0];
    if (!first) {
      continue;
    }
    const terms = topTerms(
      bucket.map((e) => e.scenario),
      maxTerms
    );
    const lesson: ToolLesson = {
      tool: first.tool,
      kind: first.kind,
      terms,
    };
    const errorSample = bucket
      .map((e) => e.error)
      .find((value): value is string => Boolean(value));
    if (errorSample) {
      lesson.errorSample = errorSample;
    }
    lessons.push(lesson);
  }
  return lessons;
}

/** Tokenize scenarios, count frequencies, and return the top distinctive terms. */
function topTerms(scenarios: string[], maxTerms: number): string[] {
  const counts = new Map<string, number>();
  for (const scenario of scenarios) {
    for (const token of tokenize(scenario)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTerms)
    .map(([term]) => term);
}

function tokenize(scenario: string): string[] {
  return scenario
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));
}

/**
 * COMPRESS stage. Drops any distilled term already present in the tool's current
 * description (the winning variant's override, falling back to the supplied base
 * description), and removes lessons left with nothing net-new to say.
 */
export function compressLessons(
  lessons: ToolLesson[],
  context: ProposeVariantsContext,
  baseDescriptions?: Record<string, string>
): ToolLesson[] {
  const out: ToolLesson[] = [];
  for (const lesson of lessons) {
    if (lesson.kind === 'error') {
      if (lesson.errorSample) {
        out.push(lesson);
      }
      continue;
    }
    const current = currentDescription(lesson.tool, context, baseDescriptions);
    const fresh = lesson.terms.filter(
      (term) => !current.toLowerCase().includes(term)
    );
    if (fresh.length > 0) {
      out.push({ ...lesson, terms: fresh });
    }
  }
  return out;
}

function currentDescription(
  tool: string,
  context: ProposeVariantsContext,
  baseDescriptions?: Record<string, string>
): string {
  const winning = context.bestSoFar?.variant.tools[tool]?.description;
  if (winning) {
    return winning;
  }
  return baseDescriptions?.[tool] ?? '';
}

/** INTEGRATE stage: amend a tool description with a focused directive. */
function buildVariant(
  round: number,
  lesson: ToolLesson,
  baseDescriptions: Record<string, string>
): ToolOverrideVariant {
  const base = baseDescriptions[lesson.tool] ?? '';
  const directive = buildDirective(lesson);
  const description = (base ? `${base} ` : '') + directive;
  const tools: Record<string, ToolMetadataOverride> = {
    [lesson.tool]: { description },
  };
  return {
    id: `evidence-r${round}-${lesson.tool}-${lesson.kind}`,
    description: `Evidence-distilled description for ${lesson.tool} (${lesson.kind})`,
    tools,
  };
}

function buildDirective(lesson: ToolLesson): string {
  switch (lesson.kind) {
    case 'under-trigger':
      return `Call this tool when the request mentions: ${lesson.terms.join(', ')}.`;
    case 'over-trigger':
      return `Avoid this tool when the request is only about: ${lesson.terms.join(', ')}.`;
    case 'error':
      return `Note: known failure mode — ${truncate(lesson.errorSample ?? '', 120)}`;
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
