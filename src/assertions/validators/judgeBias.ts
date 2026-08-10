/**
 * Judge Bias Probes
 *
 * Measures systematic biases in LLM-as-a-judge evaluators by applying
 * controlled perturbations to a candidate response and comparing the
 * judge's scores. Adapted from Verga et al., "Judging the Judges:
 * Evaluating Alignment and Vulnerabilities in LLMs-as-Judges"
 * (arXiv:2406.12624).
 *
 * These probes reuse the repo's existing judge infrastructure
 * (`createJudge` / `resolveRubric`) and return `ValidationResult`s,
 * making them siblings of `validateJudge`. They fill the gap that
 * `judgeReps` does not address: averaging repeated judge calls reduces
 * score *variance* but cannot reveal a judge that is low-variance yet
 * systematically *biased*. Each probe is a crisp, parameter-free
 * measurement of one bias family:
 *
 *  - Verbosity: an exact prompt-length variant — same content, padded.
 *  - Position: a pairwise permutation count — candidate/reference swap.
 *  - Leniency: a closed-form mean shift from the neutral midpoint.
 */

import type { ValidationResult } from './types.js';
import type {
  Judge,
  JudgeConfig,
  ProviderKind,
} from '../../judge/judgeTypes.js';
import type { RubricSpec } from '../../judge/rubrics.js';
import { createJudge } from '../../judge/judgeClient.js';
import { resolveRubric } from '../../judge/rubrics.js';
import { extractText } from './utils.js';

/** Neutral filler appended to build a verbose variant. Adds no information. */
const VERBOSE_FILLER =
  ' To restate for clarity, the response above addresses the question as posed; ' +
  'this sentence introduces no additional substance and exists only to lengthen the text.';

/** Default maximum tolerated bias magnitude before a probe is flagged. */
const DEFAULT_TOLERANCE = 0.1;

/**
 * Pairwise rubric used by the position probe. Scores the candidate answer
 * relative to the reference answer on overall quality (1.0 = candidate
 * clearly better, 0.0 = reference clearly better, 0.5 = tie).
 */
const PAIRWISE_POSITION_RUBRIC =
  'Compare the candidate answer to the reference answer on overall quality. ' +
  'Score 1.0 when the candidate is clearly better than the reference; ' +
  '0.75 when the candidate is somewhat better; ' +
  '0.5 when the two are roughly equal; ' +
  '0.25 when the candidate is somewhat worse; ' +
  '0.0 when the candidate is clearly worse than the reference.';

/** Which bias probes to run. */
export type BiasProbeKind = 'verbosity' | 'position';

/** Options for building or reusing a judge within a probe. */
export interface JudgeProbeJudgeOptions {
  /** Judge provider. @default 'anthropic' */
  provider?: ProviderKind;
  /** Model override. */
  model?: string;
  /** Environment variable name for API key. */
  apiKeyEnvVar?: string;
  /** Max tokens for judge response. */
  maxTokens?: number;
  /** Temperature for judge LLM (0–1). */
  temperature?: number;
  /** Injectable judge instance. When set, no new judge is created. */
  judge?: Judge;
}

/** Result of the verbosity-bias probe (prompt-length variant). */
export interface VerbosityBiasResult {
  /** Judge score on the original (shorter) response. */
  originalScore: number;
  /** Judge score on the padded (longer) response. */
  verboseScore: number;
  /** verboseScore - originalScore. Positive means the judge favors longer answers. */
  delta: number;
  /** True when the delta exceeds the tolerance (verbosity bias detected). */
  biased: boolean;
  /** Character length of the original response text. */
  originalLength: number;
  /** Character length of the padded response text. */
  verboseLength: number;
}

/** Result of the position-bias probe (pairwise permutation). */
export interface PositionBiasResult {
  /** Preference score with `response` as candidate, `reference` as reference. */
  scoreCandidateFirst: number;
  /** Preference score with the two answers swapped. */
  scoreReferenceFirst: number;
  /** scoreCandidateFirst + scoreReferenceFirst - 1.0. Near 0 means symmetric. */
  asymmetry: number;
  /** True when |asymmetry| exceeds the tolerance (position bias detected). */
  biased: boolean;
}

/** Configuration for `validateJudgeBias` and the individual probes. */
export interface JudgeBiasProbeConfig extends JudgeProbeJudgeOptions {
  /** Rubric used to judge quality for the verbosity probe. */
  rubric: RubricSpec;
  /** Second answer for the position probe. Required when `probes` includes 'position'. */
  reference?: unknown;
  /** Maximum tolerated bias magnitude (0–1) before a probe is flagged. */
  tolerance?: number;
  /** Which probes to run. Position requires `reference`. @default ['verbosity'] */
  probes?: BiasProbeKind[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toScore(result: { score?: number; pass?: boolean }): number {
  if (typeof result.score === 'number') return result.score;
  return result.pass ? 1.0 : 0.0;
}

async function resolveProbeJudge(
  options: JudgeProbeJudgeOptions
): Promise<Judge> {
  if (options.judge) return options.judge;
  const config: JudgeConfig = {};
  if (options.provider !== undefined) config.provider = options.provider;
  if (options.model !== undefined) config.model = options.model;
  if (options.apiKeyEnvVar !== undefined)
    config.apiKeyEnvVar = options.apiKeyEnvVar;
  if (options.maxTokens !== undefined) config.maxTokens = options.maxTokens;
  if (options.temperature !== undefined)
    config.temperature = options.temperature;
  return createJudge(config);
}

/**
 * Builds a verbose variant of `text` by appending neutral, information-free
 * filler until it is at least `factor`× as long. The substance is unchanged —
 * only the length varies — so any score difference is attributable to length.
 *
 * @param text - The original response text.
 * @param factor - Target length multiplier. @default 2
 */
export function makeVerboseVariant(text: string, factor = 2): string {
  if (!text) return text;
  const target = text.length * factor;
  let out = text;
  while (out.length < target) out += VERBOSE_FILLER;
  return out;
}

/**
 * Closed-form leniency index: the mean judge score shifted from the neutral
 * 0.5 midpoint, clamped to [-0.5, 0.5]. Positive means lenient (over-scoring);
 * negative means harsh (under-scoring). Apply across a run's worth of scores
 * rather than a single case — leniency is a population-level property.
 *
 * @param scores - Judge scores (0–1), e.g. aggregated across many cases or reps.
 */
export function computeLeniencyIndex(scores: number[]): number {
  if (scores.length === 0) return 0;
  const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  return clamp(mean - 0.5, -0.5, 0.5);
}

/**
 * Verbosity-bias probe. Judges the original response text and a padded variant
 * under the same rubric and reports the score delta. A delta above the
 * tolerance signals that the judge inflates scores for longer answers.
 */
export async function probeVerbosityBias(
  response: unknown,
  config: JudgeBiasProbeConfig
): Promise<VerbosityBiasResult> {
  const tolerance = config.tolerance ?? DEFAULT_TOLERANCE;
  const rubricText = resolveRubric(config.rubric);
  const judge = await resolveProbeJudge(config);

  const originalText = extractText(response);
  const verboseText = makeVerboseVariant(originalText);

  const [original, verbose] = await Promise.all([
    judge.evaluate(originalText, null, rubricText),
    judge.evaluate(verboseText, null, rubricText),
  ]);

  const originalScore = toScore(original);
  const verboseScore = toScore(verbose);
  const delta = verboseScore - originalScore;

  return {
    originalScore,
    verboseScore,
    delta,
    biased: delta > tolerance,
    originalLength: originalText.length,
    verboseLength: verboseText.length,
  };
}

/**
 * Position-bias probe. Asks the judge to compare `response` against
 * `reference` in both role orders; a symmetric judge returns scores that sum
 * to 1.0. The asymmetry quantifies how much the judge's preference depends on
 * presentation order rather than content.
 */
export async function probePositionBias(
  response: unknown,
  config: JudgeBiasProbeConfig
): Promise<PositionBiasResult> {
  if (config.reference === undefined) {
    throw new Error(
      'probePositionBias requires a `reference` (second answer) to compare against.'
    );
  }
  const tolerance = config.tolerance ?? DEFAULT_TOLERANCE;
  const judge = await resolveProbeJudge(config);

  const [candidateFirst, referenceFirst] = await Promise.all([
    judge.evaluate(response, config.reference, PAIRWISE_POSITION_RUBRIC),
    judge.evaluate(config.reference, response, PAIRWISE_POSITION_RUBRIC),
  ]);

  const scoreCandidateFirst = toScore(candidateFirst);
  const scoreReferenceFirst = toScore(referenceFirst);
  const asymmetry = scoreCandidateFirst + scoreReferenceFirst - 1.0;

  return {
    scoreCandidateFirst,
    scoreReferenceFirst,
    asymmetry,
    biased: Math.abs(asymmetry) > tolerance,
  };
}

/**
 * Validates that an LLM judge is free of detectable bias on the given
 * response. Runs the requested probes and fails when any probe's bias
 * magnitude exceeds the tolerance.
 *
 * @param response - The candidate response to probe.
 * @param config - Probe configuration (rubric, optional reference, tolerance, probes).
 * @returns Validation result with per-probe measurements in `details`.
 *
 * @example
 * ```typescript
 * const result = await validateJudgeBias(response, {
 *   rubric: 'correctness',
 *   reference: expectedAnswer,
 *   probes: ['verbosity', 'position'],
 *   tolerance: 0.1,
 * });
 * if (!result.pass) console.log(result.message);
 * ```
 */
export async function validateJudgeBias(
  response: unknown,
  config: JudgeBiasProbeConfig
): Promise<ValidationResult> {
  const tolerance = config.tolerance ?? DEFAULT_TOLERANCE;
  const probes = config.probes ?? ['verbosity'];

  const measurements: Record<string, unknown> = {};
  const failures: string[] = [];

  if (probes.includes('verbosity')) {
    const verbosity = await probeVerbosityBias(response, config);
    measurements.verbosity = verbosity;
    if (verbosity.biased) {
      failures.push(
        `verbosity (delta=${verbosity.delta.toFixed(2)} > ${tolerance.toFixed(2)})`
      );
    }
  }

  if (probes.includes('position')) {
    if (config.reference === undefined) {
      return {
        pass: false,
        message:
          'Judge bias validation failed: the position probe requires a `reference` answer.',
      };
    }
    const position = await probePositionBias(response, config);
    measurements.position = position;
    if (position.biased) {
      failures.push(
        `position (|asymmetry|=${Math.abs(position.asymmetry).toFixed(2)} > ${tolerance.toFixed(2)})`
      );
    }
  }

  const pass = failures.length === 0;
  return {
    pass,
    message: pass
      ? `Judge passed bias probes (${probes.join(', ')}) within tolerance ${tolerance.toFixed(2)}`
      : `Judge failed bias probes: ${failures.join('; ')}`,
    details: { tolerance, probes, ...measurements },
  };
}
