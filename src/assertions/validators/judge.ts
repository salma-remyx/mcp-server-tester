/**
 * Judge Validator
 *
 * Validates a response using an LLM-as-a-judge evaluation.
 */

import type { ValidationResult } from './types.js';
import type { JudgeConfig } from '../../judge/judgeTypes.js';
import { createJudge } from '../../judge/judgeClient.js';

/**
 * Configuration for the judge validator
 */
export interface JudgeValidatorConfig {
  /** The evaluation rubric/criteria for the judge */
  rubric: string;
  /** Optional reference response to compare against */
  reference?: unknown;
  /** Minimum score required to pass (0-1, default: 0.7) */
  threshold?: number;
  /** Optional config ID to look up from a judgeConfigs registry */
  configId?: string;
}

/**
 * Validates a response using an LLM-as-a-judge evaluation
 *
 * Calls the configured judge with the response and rubric, then checks whether
 * the resulting score meets the threshold. Returns a ValidationResult compatible
 * with the unified assertion architecture.
 *
 * @param response - The response to evaluate
 * @param config - Judge evaluation configuration (rubric, reference, threshold, configId)
 * @param judgeConfigs - Optional registry mapping configId values to JudgeConfig instances
 * @returns Validation result indicating pass/fail with judge reasoning
 *
 * @example
 * ```typescript
 * const result = await validateJudge(
 *   response,
 *   { rubric: 'Does the response accurately describe the weather?' }
 * );
 * if (!result.pass) {
 *   console.log(result.message);
 * }
 *
 * // With a custom judge config and threshold
 * const result2 = await validateJudge(
 *   response,
 *   { rubric: 'Is this helpful?', threshold: 0.9, configId: 'strict' },
 *   { strict: { model: 'claude-opus-4-20250514', temperature: 0 } }
 * );
 * ```
 */
export async function validateJudge(
  response: unknown,
  config: JudgeValidatorConfig,
  judgeConfigs?: Record<string, JudgeConfig>
): Promise<ValidationResult> {
  const { rubric, reference, threshold = 0.7, configId } = config;

  const judgeConfig: JudgeConfig = configId
    ? (judgeConfigs?.[configId] ?? {})
    : {};

  try {
    const judge = createJudge(judgeConfig);
    const judgeResult = await judge.evaluate(
      response,
      reference ?? null,
      rubric
    );
    const score = judgeResult.score ?? (judgeResult.pass ? 1.0 : 0.0);
    const passed = score >= threshold;

    return {
      pass: passed,
      message: passed
        ? `Judge passed with score ${score.toFixed(2)}`
        : `Judge failed with score ${score.toFixed(2)} (threshold: ${threshold}). ${judgeResult.reasoning ?? ''}`,
    };
  } catch (err) {
    return {
      pass: false,
      message: `Judge evaluation error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
