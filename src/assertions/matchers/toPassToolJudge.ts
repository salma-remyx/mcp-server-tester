/**
 * toPassToolJudge Matcher
 *
 * Validates that a response passes LLM-as-judge evaluation.
 * Delegates evaluation logic to validateJudge() for consistency
 * with the validator/matcher duality pattern.
 */

import { validateJudge } from '../validators/judge.js';
import type { JudgeConfig } from '../../judge/judgeTypes.js';
import type { JudgeMatcherOptions } from './types.js';

// Default passing threshold
const DEFAULT_PASSING_THRESHOLD = 0.7;

/**
 * Creates the toPassToolJudge matcher function
 *
 * Note: This is an async matcher that calls an LLM for evaluation.
 */
export async function toPassToolJudge(
  this: { isNot: boolean },
  received: unknown,
  rubric: string,
  options: JudgeMatcherOptions = {}
): Promise<{ pass: boolean; message: () => string }> {
  const {
    reference = null,
    passingThreshold = DEFAULT_PASSING_THRESHOLD,
    judgeConfig = {} as JudgeConfig,
  } = options;

  // Delegate to the pure validateJudge validator, passing the inline
  // config directly as a single-entry registry keyed by '_inline'.
  const validation = await validateJudge(
    received,
    {
      rubric,
      reference: reference ?? undefined,
      threshold: passingThreshold,
      configId: '_inline',
    },
    { _inline: judgeConfig }
  );

  if (this.isNot) {
    return {
      pass: !validation.pass,
      message: () =>
        validation.pass
          ? `Expected judge evaluation to fail, but it passed`
          : `Judge evaluation failed as expected`,
    };
  }

  return {
    pass: validation.pass,
    message: () => validation.message,
  };
}
