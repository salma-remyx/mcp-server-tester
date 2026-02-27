/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
import type { Judge, JudgeConfig, JudgeResult } from './judgeTypes.js';

/**
 * Creates an OpenAI-backed LLM judge.
 * Requires the `openai` package and an OpenAI API key.
 */
export function createOpenAIJudge(config: JudgeConfig = {}): Judge {
  const apiKeyEnvVar = config.apiKeyEnvVar ?? 'OPENAI_API_KEY';
  const apiKey = process.env[apiKeyEnvVar];
  if (!apiKey) {
    throw new Error(
      `OpenAI judge requires an API key. Set the ${apiKeyEnvVar} environment variable.`
    );
  }

  const model = config.model ?? 'gpt-4o';
  const maxTokens = config.maxTokens ?? 1000;
  const temperature = config.temperature ?? 0.0;

  return {
    async evaluate(candidate, reference, rubric): Promise<JudgeResult> {
      // Dynamic import keeps `openai` an optional runtime dep.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let openaiModule: any;
      try {
        // @ts-expect-error - optional: npm install openai
        openaiModule = await import('openai');
      } catch (err) {
        throw new Error(
          'OpenAI judge requires the `openai` package. Install it with: npm install openai\n' +
            `Original error: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const client = new openaiModule.default({ apiKey });
      const prompt = buildJudgePrompt(candidate, reference, rubric);

      const startTime = Date.now();
      const completion = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [
          {
            role: 'system',
            content:
              'You are an expert evaluator. Respond with valid JSON only: {"pass": true|false, "score": 0.0-1.0, "reasoning": "explanation"}',
          },
          { role: 'user', content: prompt },
        ],
      });
      const durationMs = Date.now() - startTime;

      const text =
        (completion.choices[0]?.message.content as string | null | undefined) ??
        '';
      const parsed = parseJudgeResponse(text);

      return {
        pass: parsed.pass,
        score: parsed.score,
        reasoning: parsed.reasoning,
        usage: {
          inputTokens:
            (completion.usage?.prompt_tokens as number | undefined) ?? 0,
          outputTokens:
            (completion.usage?.completion_tokens as number | undefined) ?? 0,
          totalCostUsd: 0,
          durationMs,
        },
      };
    },
  };
}

function buildJudgePrompt(
  candidate: unknown,
  reference: unknown,
  rubric: string
): string {
  const candidateStr =
    typeof candidate === 'string'
      ? candidate
      : JSON.stringify(candidate, null, 2);

  const referenceStr =
    reference !== null && reference !== undefined
      ? typeof reference === 'string'
        ? reference
        : JSON.stringify(reference, null, 2)
      : null;

  return (
    `Rubric:\n${rubric}\n\n` +
    `<candidate_response>\n${candidateStr}\n</candidate_response>\n\n` +
    `<reference_answer>\n${referenceStr ?? 'No reference provided.'}\n</reference_answer>\n\n` +
    `Evaluate and return JSON: {"pass": boolean, "score": number (0-1), "reasoning": string}`
  );
}

function parseJudgeResponse(text: string): {
  pass: boolean;
  score: number;
  reasoning: string;
} {
  const cleaned = text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const pass = typeof parsed.pass === 'boolean' ? parsed.pass : false;
    const score =
      typeof parsed.score === 'number' ? parsed.score : pass ? 1.0 : 0.0;
    const reasoning =
      typeof parsed.reasoning === 'string' ? parsed.reasoning : '';
    return { pass, score, reasoning };
  } catch {
    return {
      pass: false,
      score: 0,
      reasoning: `Failed to parse judge response: ${text}`,
    };
  }
}
