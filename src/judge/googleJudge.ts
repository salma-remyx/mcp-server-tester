/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
import type { Judge, JudgeConfig, JudgeResult } from './judgeTypes.js';

/**
 * Creates a Google Gemini-backed LLM judge.
 * Requires the `@google/generative-ai` package and a Google API key.
 */
export function createGoogleJudge(config: JudgeConfig = {}): Judge {
  const apiKeyEnvVar = config.apiKeyEnvVar ?? 'GOOGLE_API_KEY';
  const apiKey = process.env[apiKeyEnvVar];
  if (!apiKey) {
    throw new Error(
      `Google judge requires an API key. Set the ${apiKeyEnvVar} environment variable.`,
    );
  }

  const model = config.model ?? 'gemini-2.0-flash';
  const maxTokens = config.maxTokens ?? 1000;

  return {
    async evaluate(candidate, reference, rubric): Promise<JudgeResult> {
      // Dynamic import keeps `@google/generative-ai` an optional runtime dep.
      let googleModule: any;
      try {
        // @ts-ignore - optional: npm install @google/generative-ai
        googleModule = await import('@google/generative-ai');
      } catch (err) {
        throw new Error(
          'Google judge requires the `@google/generative-ai` package. Install it with: npm install @google/generative-ai\n' +
            `Original error: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const genAI = new googleModule.GoogleGenerativeAI(apiKey);
      const gemini = genAI.getGenerativeModel({
        model,
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.0,
        },
        systemInstruction:
          'You are an expert evaluator. Respond with valid JSON only: {"pass": true|false, "score": 0.0-1.0, "reasoning": "explanation"}',
      });

      const parts = [
        `Rubric: ${rubric}`,
        `Response to evaluate:\n${JSON.stringify(candidate, null, 2)}`,
      ];
      if (reference !== null && reference !== undefined) {
        parts.push(`Reference answer:\n${JSON.stringify(reference, null, 2)}`);
      }

      const startTime = Date.now();
      const result = await gemini.generateContent(parts.join('\n\n'));
      const durationMs = Date.now() - startTime;

      const text = result.response.text() as string;
      const cleaned = text
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      let pass = false;
      let score = 0;
      let reasoning = '';

      try {
        const parsed = JSON.parse(cleaned) as Record<string, unknown>;
        pass = typeof parsed.pass === 'boolean' ? parsed.pass : false;
        score =
          typeof parsed.score === 'number' ? parsed.score : pass ? 1.0 : 0.0;
        reasoning =
          typeof parsed.reasoning === 'string' ? parsed.reasoning : '';
      } catch {
        reasoning = `Failed to parse judge response: ${text}`;
      }

      return {
        pass,
        score,
        reasoning,
        usage: {
          inputTokens: (result.response.usageMetadata?.promptTokenCount as number | undefined) ?? 0,
          outputTokens: (result.response.usageMetadata?.candidatesTokenCount as number | undefined) ?? 0,
          totalCostUsd: 0,
          durationMs,
        },
      };
    },
  };
}
