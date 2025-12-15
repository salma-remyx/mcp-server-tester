/**
 * toPassToolJudge Matcher
 *
 * Validates that a response passes LLM-as-judge evaluation.
 */

import { createJudge } from '../../judge/judgeClient.js';
import type { JudgeConfig } from '../../judge/judgeTypes.js';
import type { JudgeMatcherOptions } from './types.js';

// Default passing threshold
const DEFAULT_PASSING_THRESHOLD = 0.7;

// Default judge configuration
const DEFAULT_JUDGE_CONFIG: JudgeConfig = {};

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
    judgeConfig = DEFAULT_JUDGE_CONFIG,
  } = options;

  // Create judge client
  const judge = createJudge(judgeConfig);

  try {
    // Evaluate the response
    const result = await judge.evaluate(received, reference, rubric);

    // Determine pass/fail based on threshold
    const score = result.score ?? (result.pass ? 1.0 : 0.0);
    const passes = score >= passingThreshold;

    if (this.isNot) {
      // For .not, we expect the evaluation to fail
      return {
        pass: !passes,
        message: () =>
          passes
            ? `Expected judge evaluation to fail, but it passed with score ${score.toFixed(2)}`
            : `Judge evaluation failed as expected with score ${score.toFixed(2)}`,
      };
    }

    if (passes) {
      return {
        pass: true,
        message: () =>
          `Judge evaluation passed with score ${score.toFixed(2)} (threshold: ${passingThreshold})`,
      };
    }

    return {
      pass: false,
      message: () =>
        `Judge evaluation failed with score ${score.toFixed(2)} (threshold: ${passingThreshold}). ` +
        `Reasoning: ${result.reasoning ?? 'No reasoning provided'}`,
    };
  } catch (error) {
    return {
      pass: false,
      message: () =>
        `Judge evaluation failed with error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
