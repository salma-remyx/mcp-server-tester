/**
 * Judge Escalation — compute-balanced routing for LLM-as-a-judge verification.
 *
 * Implements the compute-balanced routing idea: after a cheap verifier runs
 * broadly, route *uncertain* candidates (high score variance across reps) to a
 * single stronger verification pass instead of spending extra compute uniformly
 * on every case. The next unit of compute goes where it is most valuable.
 *
 * This turns the judge validator's existing high-variance signal into an
 * actionable routing decision rather than a console warning.
 *
 * Adapted from "CoBa: Cost-Effective Test-Time Scaling via Compute-Balanced
 * Routing" (arXiv:2608.07424). Mode 2 (adapted port): the paper's learned
 * router is replaced by the repo's existing stddev-based highVariance proxy,
 * and the paper's separate benchmark/eval suite is intentionally out of scope
 * (evaluation belongs downstream).
 */

import type {
  JudgeConfig,
  JudgeResult,
  ProviderKind,
} from '../../judge/judgeTypes.js';
import { createJudge } from '../../judge/judgeClient.js';

/**
 * Configuration for escalating an uncertain (high-variance) judge verdict to a
 * stronger verifier. Inherits the cheap judge's provider/model and budget when
 * a field is omitted.
 */
export interface JudgeEscalationConfig {
  /** Stronger provider to escalate to. Inherits the cheap judge's provider when omitted. */
  provider?: ProviderKind;
  /** Stronger model to escalate to (e.g. 'claude-opus-4-20250514'). */
  model?: string;
  /** Number of reps for the escalation pass. @default 1 */
  reps?: number;
  /** Temperature for the escalation judge. Inherits the cheap config when omitted. */
  temperature?: number;
  /** Environment variable name for the escalation judge's API key. Inherits when omitted. */
  apiKeyEnvVar?: string;
}

/** Why escalation did or did not fire for a given case. */
export type JudgeEscalationDecision =
  /** Escalation was not configured, so the cheap verdict always stands. */
  | 'disabled'
  /** The cheap verifier was decisive (low variance); no extra compute spent. */
  | 'not-uncertain'
  /** The candidate was uncertain and was re-verified by the stronger judge. */
  | 'escalated';

export interface JudgeEscalationResult {
  /** Whether the stronger verifier actually ran. */
  escalated: boolean;
  /** Routing decision explaining why escalation did or did not fire. */
  routingDecision: JudgeEscalationDecision;
  /** Mean score from the stronger pass. Undefined when not escalated. */
  score?: number;
  /** Reasoning from the stronger pass's final rep. */
  reasoning?: string;
  /** Individual scores from the stronger pass. */
  scores?: number[];
}

export interface JudgeEscalationArgs {
  /** The candidate response being evaluated. */
  response: unknown;
  /** Reference response, or null when not applicable. */
  reference: unknown;
  /** Resolved rubric string to evaluate against. */
  rubric: string;
  /** Whether the cheap pass flagged the candidate as uncertain. */
  highVariance: boolean;
  /** Config used for the cheap pass; escalation inherits unset fields from it. */
  baseConfig: JudgeConfig;
  /** Escalation overrides. When omitted, escalation never fires. */
  escalate?: JudgeEscalationConfig;
}

/**
 * CoBa-style compute-balanced escalation hook.
 *
 * Returns a routing decision and, when the cheap verification was uncertain
 * (high variance) AND an `escalate` config was supplied, the stronger
 * verifier's verdict. Performs no LLM call when escalation is disabled or the
 * case was not uncertain — that is precisely the cost saving over running the
 * stronger judge on every case.
 *
 * @returns the routing decision plus the stronger verifier's mean score when escalated.
 */
export async function escalateJudgeVerification(
  args: JudgeEscalationArgs
): Promise<JudgeEscalationResult> {
  const { highVariance, escalate } = args;

  if (escalate === undefined) {
    return { escalated: false, routingDecision: 'disabled' };
  }

  if (!highVariance) {
    return { escalated: false, routingDecision: 'not-uncertain' };
  }

  // Uncertain candidate → route the next unit of compute to a stronger pass.
  const escalationReps = Math.max(1, escalate.reps ?? 1);
  const escalationConfig: JudgeConfig = {
    ...args.baseConfig,
    ...(escalate.provider !== undefined && { provider: escalate.provider }),
    ...(escalate.model !== undefined && { model: escalate.model }),
    ...(escalate.temperature !== undefined && {
      temperature: escalate.temperature,
    }),
    ...(escalate.apiKeyEnvVar !== undefined && {
      apiKeyEnvVar: escalate.apiKeyEnvVar,
    }),
  };

  const judge = createJudge(escalationConfig);
  const scores: number[] = [];
  let reasoning: string | undefined;

  for (let i = 0; i < escalationReps; i++) {
    const result: JudgeResult = await judge.evaluate(
      args.response,
      args.reference,
      args.rubric
    );
    scores.push(result.score ?? (result.pass ? 1.0 : 0.0));
    reasoning = result.reasoning;
  }

  const score = scores.reduce((a, b) => a + b, 0) / scores.length;

  return {
    escalated: true,
    routingDecision: 'escalated',
    score,
    reasoning,
    scores,
  };
}
