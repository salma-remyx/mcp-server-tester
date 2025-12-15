import type { Judge, JudgeConfig, ProviderKind } from './judgeTypes.js';
import { createClaudeAgentJudge } from './claudeAgentJudge.js';

/**
 * Creates an LLM judge for evaluating tool responses
 *
 * Uses Claude Agent SDK for evaluation with usage metrics tracking.
 *
 * @param config - Judge configuration
 * @returns Judge instance
 * @throws {Error} If provider is unsupported or configuration is invalid
 *
 * @example
 * // Default Claude judge
 * const judge = createJudge();
 *
 * @example
 * // With configuration
 * const judge = createJudge({
 *   model: 'claude-sonnet-4-20250514',
 *   maxToolOutputSize: 50000, // Fail if response > 50KB
 *   maxBudgetUsd: 0.05,
 * });
 *
 * // Evaluate a response
 * const result = await judge.evaluate(
 *   candidateResponse,
 *   referenceResponse,
 *   'Evaluate for accuracy and completeness'
 * );
 *
 * // Access usage metrics
 * console.log('Cost:', result.usage?.totalCostUsd);
 * console.log('Tokens:', result.usage?.inputTokens, result.usage?.outputTokens);
 */
export function createJudge(config: JudgeConfig = {}): Judge {
  const provider: ProviderKind = config.provider ?? 'claude';

  switch (provider) {
    case 'claude':
    case 'anthropic':
      // Both 'claude' and 'anthropic' use Claude Agent SDK
      return createClaudeAgentJudge(config);

    case 'openai':
      throw new Error(
        'OpenAI provider is no longer supported. ' +
          'Please use createJudge() without specifying provider, or use provider: "claude". ' +
          'See migration guide at https://github.com/mcp-testing/server-tester/blob/main/docs/migration-v0.11.md'
      );

    case 'custom-http':
      throw new Error(
        'custom-http provider is no longer supported. ' +
          'Please use createJudge() without specifying provider.'
      );

    default:
      throw new Error(`Unsupported LLM provider: ${String(provider)}`);
  }
}
