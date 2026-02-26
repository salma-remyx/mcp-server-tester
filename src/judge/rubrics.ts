/**
 * Built-in judge rubrics matching Glean EvalV2's named judge types.
 * Use these for consistent, standardized evaluations across teams.
 */
export type BuiltInRubric =
  | 'correctness'
  | 'completeness'
  | 'groundedness'
  | 'instruction-following'
  | 'conciseness';

export const BUILT_IN_RUBRICS: Record<BuiltInRubric, string> = {
  correctness:
    'Evaluate whether the response is factually correct and accurately answers the question. ' +
    'Compare against the reference answer if provided. ' +
    'Score 1.0 for fully correct, 0.5 for partially correct, 0.0 for incorrect or irrelevant.',

  completeness:
    'Evaluate whether the response fully addresses all aspects of the question. ' +
    'Score 1.0 if the response covers all key points, 0.5 if it partially answers, ' +
    '0.0 if major aspects are missing.',

  groundedness:
    'Evaluate whether all claims in the response are supported by the retrieved context or reference. ' +
    'Penalize unsupported assertions or hallucinated facts. ' +
    'Score 1.0 for fully grounded, 0.5 for mostly grounded, 0.0 for hallucinated.',

  'instruction-following':
    'Evaluate whether the response follows the instructions given in the question. ' +
    'Check format, tone, constraints, and task completion. ' +
    'Score 1.0 for full compliance, 0.5 for partial, 0.0 for non-compliance.',

  conciseness:
    'Evaluate whether the response is appropriately concise without losing important information. ' +
    'Penalize unnecessary verbosity. Score 1.0 for well-sized, 0.5 for somewhat verbose, 0.0 for excessively long.',
};

/** A rubric specification: either a built-in named rubric or custom text. */
export type RubricSpec = BuiltInRubric | { text: string };

/**
 * Returns true if `s` is a built-in rubric name.
 */
export function isBuiltInRubric(s: unknown): s is BuiltInRubric {
  return typeof s === 'string' && s in BUILT_IN_RUBRICS;
}

/**
 * Resolves a RubricSpec to its full rubric text.
 * - Built-in name → returns the expanded rubric text from BUILT_IN_RUBRICS
 * - Custom object → returns rubric.text as-is
 */
export function resolveRubric(rubric: RubricSpec): string {
  if (typeof rubric === 'string') {
    return BUILT_IN_RUBRICS[rubric];
  }
  return rubric.text;
}
