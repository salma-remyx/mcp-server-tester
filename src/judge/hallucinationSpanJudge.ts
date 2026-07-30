/**
 * Hallucination Span Judge
 *
 * Span-level hallucination localization for tool responses, adapted from the
 * UCSC SemEval-2025 Task 3 (Mu-SHROOM) submission (arXiv:2505.03030). The
 * built-in `groundedness` rubric emits a single 0–1 score; this judge instead
 * localizes *which* spans of a response are unsupported by grounding context,
 * then derives a fine-grained score from the localization.
 *
 * Adapted port (Mode 2) — what is and is not from the paper:
 *   - Core mechanism kept at full fidelity: segment the response into spans,
 *     assess each span's support against the reference context, and localize
 *     the unsupported (hallucinated) spans with character offsets.
 *   - The paper's learned / prompt-optimized NLI entailment estimator is
 *     substituted with a parameter-free token-overlap entailment proxy
 *     (`tokenOverlapSupport`). Inject a `SpanSupportPredicate` (e.g. an LLM
 *     entailment call) to restore the paper's learned-estimator fidelity.
 *   - The Mu-SHROOM multilingual benchmark suite and the multi-model
 *     "Context, Models" search are intentionally out of scope; evaluation of
 *     the localization is a downstream concern.
 *
 * Plugs into the existing custom-judge registry (`registerJudge` /
 * `getRegisteredJudge`), so it is reachable through the standard judge path
 * — `toPassToolJudge({ judge: 'hallucination-span' })` or a `passesJudge`
 * eval expectation — without modifying any existing module.
 */

import type {
  CustomJudgeExecutor,
  CustomJudgeResult,
} from './judgeRegistry.js';
import { registerJudge } from './judgeRegistry.js';
import { extractText } from '../assertions/validators/utils.js';

/** Default name used when registering the hallucination span judge. */
export const HALLUCINATION_SPAN_JUDGE = 'hallucination-span';

/** A localized span of the extracted candidate text. */
export interface HallucinationSpan {
  /** The span text (trimmed). */
  text: string;
  /** Inclusive start character offset within the extracted candidate text. */
  start: number;
  /** Exclusive end character offset within the extracted candidate text. */
  end: number;
}

/** Result of span-level hallucination localization. */
export interface HallucinationLocalization {
  /** Spans assessed as unsupported by the grounding context. */
  hallucinatedSpans: HallucinationSpan[];
  /** Total number of spans assessed. */
  totalSpans: number;
  /** Fraction of spans that are grounded (0–1); 1.0 means no hallucination. */
  groundedFraction: number;
}

/**
 * Assesses whether a single span is supported by the grounding context.
 * Returns `true` when the span is grounded, `false` when unsupported. The
 * default is a parameter-free token-overlap proxy; supply your own (e.g. an
 * LLM entailment call) to restore the paper's learned estimator.
 */
export type SpanSupportPredicate = (
  span: string,
  context: string
) => boolean | Promise<boolean>;

/** Options for the hallucination span judge. */
export interface HallucinationSpanJudgeOptions {
  /**
   * Custom span-support assessor. Defaults to a parameter-free token-overlap
   * entailment proxy.
   */
  supportPredicate?: SpanSupportPredicate;
  /**
   * Minimum fraction of a span's content tokens that must appear in the
   * grounding context for the default proxy to consider the span grounded.
   * @default 0.5
   */
  supportThreshold?: number;
  /**
   * Score returned when no grounding context (reference) is available.
   * Localization is impossible without context; defaults to 1.0 (no evidence
   * of hallucination) so the judge does not spuriously fail.
   * @default 1.0
   */
  noContextScore?: number;
  /**
   * Maximum number of localized spans to enumerate in the reasoning text.
   * @default 8
   */
  maxSpansInReasoning?: number;
}

// Modest English stopword set so the overlap proxy keys on content tokens.
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'as',
  'by',
  'with',
  'from',
  'into',
  'than',
  'then',
  'so',
  'such',
  'not',
  'no',
  'do',
  'does',
  'did',
  'has',
  'have',
  'had',
]);

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9]+/g);
  return (matches ?? []).filter(
    (token) => token.length > 1 && !STOPWORDS.has(token)
  );
}

/**
 * Splits extracted text into sentence-ish spans, preserving character offsets
 * relative to the input text.
 */
export function splitIntoSpans(text: string): HallucinationSpan[] {
  const spans: HallucinationSpan[] = [];
  const regex = /[^.!?\n]+[.!?]*/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const leadingWhitespace = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const start = match.index + leadingWhitespace;
    spans.push({ text: trimmed, start, end: start + trimmed.length });
  }
  return spans;
}

/**
 * Default parameter-free span-support proxy: a span is grounded when at least
 * `threshold` of its content tokens appear in the grounding context. This is a
 * vocab-overlap approximation of entailment — the paper's learned estimator is
 * substitutable via the `supportPredicate` option.
 */
export function tokenOverlapSupport(
  span: string,
  context: string,
  threshold = 0.5
): boolean {
  const spanTokens = tokenize(span);
  if (spanTokens.length === 0) {
    return true; // nothing content-bearing to ground
  }
  const contextTokens = new Set(tokenize(context));
  if (contextTokens.size === 0) {
    return false; // no context to ground against
  }
  const overlap = spanTokens.filter((token) => contextTokens.has(token)).length;
  return overlap / spanTokens.length >= threshold;
}

/**
 * Localizes hallucinated spans within `text` against the grounding `context`.
 *
 * Segments `text` into spans, assesses each span's support against `context`
 * (using `supportPredicate` or the default token-overlap proxy), and returns
 * the unsupported spans plus the grounded fraction.
 */
export async function localizeHallucinations(
  text: string,
  context: string,
  options: Pick<
    HallucinationSpanJudgeOptions,
    'supportPredicate' | 'supportThreshold'
  > = {}
): Promise<HallucinationLocalization> {
  const { supportPredicate, supportThreshold = 0.5 } = options;
  const spans = splitIntoSpans(text);

  if (spans.length === 0) {
    return { hallucinatedSpans: [], totalSpans: 0, groundedFraction: 1 };
  }

  // No grounding context: localization is impossible — report nothing.
  if (context.trim().length === 0) {
    return {
      hallucinatedSpans: [],
      totalSpans: spans.length,
      groundedFraction: 1,
    };
  }

  const assess: (span: string, ctx: string) => Promise<boolean> =
    supportPredicate
      ? (span, ctx) => Promise.resolve(supportPredicate(span, ctx))
      : (span, ctx) =>
          Promise.resolve(tokenOverlapSupport(span, ctx, supportThreshold));

  const hallucinatedSpans: HallucinationSpan[] = [];
  for (const span of spans) {
    const supported = await assess(span.text, context);
    if (!supported) {
      hallucinatedSpans.push(span);
    }
  }

  const groundedFraction =
    (spans.length - hallucinatedSpans.length) / spans.length;
  return { hallucinatedSpans, totalSpans: spans.length, groundedFraction };
}

/**
 * Builds a human-readable summary of the localization, enumerating up to
 * `maxSpans` unsupported spans with their character offsets.
 */
export function buildHallucinationReasoning(
  localization: HallucinationLocalization,
  maxSpans = 8
): string {
  const { hallucinatedSpans, totalSpans } = localization;
  if (totalSpans === 0) {
    return 'No spans to assess.';
  }
  if (hallucinatedSpans.length === 0) {
    return `All ${totalSpans} span(s) grounded against the reference context.`;
  }
  const shown = hallucinatedSpans.slice(0, maxSpans);
  const listing = shown
    .map(
      (span, index) =>
        `(${index + 1}) "${span.text}" [${span.start}:${span.end}]`
    )
    .join('; ');
  const more =
    hallucinatedSpans.length > maxSpans
      ? `; +${hallucinatedSpans.length - maxSpans} more`
      : '';
  return (
    `${hallucinatedSpans.length}/${totalSpans} span(s) unsupported by reference ` +
    `context: ${listing}${more}.`
  );
}

/**
 * Builds a `CustomJudgeExecutor` that localizes hallucinated spans and scores
 * the response by the grounded span fraction (1.0 = fully grounded).
 *
 * The candidate and reference are text-extracted the same way the other
 * validators extract text, so structured tool responses are handled.
 */
export function createHallucinationSpanJudge(
  options: HallucinationSpanJudgeOptions = {}
): CustomJudgeExecutor {
  const {
    supportPredicate,
    supportThreshold = 0.5,
    noContextScore = 1,
    maxSpansInReasoning = 8,
  } = options;

  return async (candidate, reference): Promise<CustomJudgeResult> => {
    const text = extractText(candidate);
    const context =
      reference === undefined || reference === null
        ? ''
        : extractText(reference);

    if (text.trim().length === 0) {
      return { score: 1, reasoning: 'Empty candidate; no spans to assess.' };
    }

    if (context.trim().length === 0) {
      return {
        score: noContextScore,
        reasoning:
          'Hallucination span localization requires grounding context; ' +
          'none was provided.',
      };
    }

    const localization = await localizeHallucinations(text, context, {
      supportPredicate,
      supportThreshold,
    });
    return {
      score: localization.groundedFraction,
      reasoning: buildHallucinationReasoning(localization, maxSpansInReasoning),
    };
  };
}

/**
 * Registers the hallucination span judge under `name` (default
 * `'hallucination-span'`) in the existing custom-judge registry. Once
 * registered it is usable via `toPassToolJudge({ judge: name })` or a
 * `passesJudge` eval expectation.
 */
export function registerHallucinationSpanJudge(
  name: string = HALLUCINATION_SPAN_JUDGE,
  options: HallucinationSpanJudgeOptions = {}
): void {
  registerJudge(name, createHallucinationSpanJudge(options));
}
