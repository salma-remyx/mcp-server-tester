/**
 * Interaction scaling — a proposer/reviewer revision loop for MCP host
 * simulation.
 *
 * Adapted from "Interaction Scaling: Grounding the Third Axis of Test-Time
 * Compute" (arXiv:2607.11598). The paper identifies a third axis of
 * test-time compute beyond reasoning and sampling: the host proposes an
 * artifact, an external instrument observes how it *actually* behaves, and
 * the host revises. Each cycle imports a real observation, so the loop can
 * break through the ceiling that internal-only axes (more tokens, more
 * samples from the same frozen weights) hit.
 *
 * The paper's single governing variable is *grounding*: both the feedback
 * that drives revision AND the metric that scores the result must come from
 * an instrument that actually observes the flaw. This module keeps that
 * mechanism at full fidelity and substitutes the paper's bespoke instrument
 * (a real-world environment + specialized harness) with a caller-supplied
 * `observe` callback over the real `MCPHostSimulationResult` — the
 * target-native equivalent of "a tool that measures the real layout instead
 * of a VLM reading a screenshot." The host is the existing
 * {@link simulateMCPHost}; the flawed tool whose behavior the observer
 * measures can be injected via the repo's `ToolOverrideVariant` mechanism.
 *
 * What is intentionally out of scope (auxiliaries, not the core mechanism):
 *   - The paper's separate coding/visual benchmark suites — evaluation of
 *     this loop on a real corpus belongs in a downstream PR.
 *   - A learned or VLM-based reviewer — the observer here is a plain,
 *     parameter-free predicate the test author supplies.
 */

import type { MCPFixtureApi } from '../../mcp/fixtures/mcpFixture.js';
import type { MCPHostConfig, MCPHostSimulationResult } from './mcpHostTypes.js';
import { simulateMCPHost } from './mcpHostSimulation.js';

/**
 * Grounded observation of a single proposer attempt. Produced by an
 * external instrument that inspects the simulation's actual behavior —
 * never by the host reading its own output.
 */
export interface InteractionObservation {
  /**
   * True when the observed behavior is already correct / flawless and no
   * further revision is needed. This is the grounded metric the paper
   * requires to live on the same side of the loop as the feedback.
   */
  resolved: boolean;

  /**
   * Human-readable description of the observed flaw, injected into the
   * next proposer attempt as revision feedback. Ignored once `resolved`.
   * Carries the real observation the host could not have derived
   * internally.
   */
  feedback?: string;
}

/**
 * A grounded instrument that observes a proposer attempt. This is the
 * third compute axis: it sees how the host's tool calls actually behaved
 * and returns feedback plus a resolve/no-resolve verdict.
 *
 * Implementations should inspect `result` (tool calls, conversation
 * history, response) — the observed behavior — rather than the host's
 * self-reported text. To probe the underlying tool directly (e.g. to
 * measure the behavior of a flawed tool injected via `ToolOverrideVariant`),
 * the `mcp` fixture is provided.
 *
 * @param result   The forward simulation result (tool calls + response).
 * @param mcp      The MCP fixture, for observers that re-query real tool
 *                 behavior as part of grounding.
 * @param attempt  1-based attempt index, for observers that vary by round.
 */
export type InteractionObserver = (
  result: MCPHostSimulationResult,
  mcp: MCPFixtureApi,
  attempt: number
) => Promise<InteractionObservation> | InteractionObservation;

/** Configuration for the proposer/reviewer revision loop. */
export interface InteractionScalingConfig {
  /**
   * Grounded instrument that observes each attempt and decides whether the
   * flaw is resolved, plus revision feedback. Required — without a grounded
   * observer the loop has no third axis.
   */
  observe: InteractionObserver;

  /**
   * Maximum revision attempts, including the initial proposal.
   * @default 3
   */
  maxAttempts?: number;

  /**
   * Heading prepended to the revision feedback each round, to frame it for
   * the host.
   * @default 'Observed behavior feedback:'
   */
  feedbackHeader?: string;
}

/** A single proposer attempt and its grounded observation. */
export interface InteractionScalingAttempt {
  /** 1-based attempt index. */
  attempt: number;
  /**
   * The scenario actually sent to the host this round. From the second
   * attempt onward it carries the prior round's grounded feedback.
   */
  scenario: string;
  /** Forward simulation result produced by the host. */
  result: MCPHostSimulationResult;
  /** The grounded observation of that result. */
  observation: InteractionObservation;
}

/** Outcome of the proposer/reviewer revision loop. */
export interface InteractionScalingResult {
  /**
   * The final host simulation result — the last attempt that ran. This is
   * the same shape `simulateMCPHost` returns, so the loop can be a
   * drop-in wrapper around the forward path.
   */
  result: MCPHostSimulationResult;

  /** Every attempt, in order. The last entry backs `result`. */
  attempts: InteractionScalingAttempt[];

  /** True when the grounded observer marked an attempt resolved. */
  resolved: boolean;

  /** 1-based index of the first resolved attempt, or undefined if never. */
  resolvedAtAttempt?: number;

  /**
   * True when revision improved the outcome over the initial proposal —
   * i.e. the loop resolved on a later attempt than the first. This is the
   * grounded win condition the paper measures: interaction scaling is only
   * visible when both feedback and metric are grounded.
   */
  revisedToResolve: boolean;
}

/**
 * Runs an interaction-scaling revision loop around {@link simulateMCPHost}.
 *
 * Each round: the host proposes (a forward simulation), the external
 * `observe`r grounds the result, and — unless resolved — the feedback is
 * appended to the scenario for the next proposal. The loop stops as soon
 * as the observer reports `resolved`, or when `maxAttempts` is hit.
 *
 * The metric that decides success (`resolved`) comes from the same grounded
 * observer that produced the feedback — the paper's requirement that
 * grounding hold on both sides of the loop.
 *
 * @example
 * ```typescript
 * const outcome = await runInteractionScaling(
 *   mcp,
 *   'Book the cheapest flight to London',
 *   { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
 *   {
 *     observe: (result) => {
 *       const searched = result.toolCalls.some(c => c.name === 'search_flights');
 *       return searched
 *         ? { resolved: true }
 *         : { resolved: false, feedback: 'No flight search was performed.' };
 *     },
 *     maxAttempts: 3,
 *   }
 * );
 * if (outcome.revisedToResolve) {
 *   console.log('Interaction scaling resolved on attempt', outcome.resolvedAtAttempt);
 * }
 * ```
 */
export async function runInteractionScaling(
  mcp: MCPFixtureApi,
  scenario: string,
  config: MCPHostConfig,
  revision: InteractionScalingConfig
): Promise<InteractionScalingResult> {
  const maxAttempts = revision.maxAttempts ?? 3;
  if (maxAttempts < 1) {
    throw new Error('InteractionScalingConfig.maxAttempts must be at least 1');
  }

  const header = revision.feedbackHeader ?? 'Observed behavior feedback:';
  const attempts: InteractionScalingAttempt[] = [];
  let resolved = false;
  let resolvedAtAttempt: number | undefined;
  let currentScenario = scenario;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await simulateMCPHost(mcp, currentScenario, config);
    const observation = await revision.observe(result, mcp, attempt);
    attempts.push({ attempt, scenario: currentScenario, result, observation });

    if (observation.resolved) {
      resolved = true;
      resolvedAtAttempt = attempt;
      break;
    }

    // Import the flaw into the next proposal — the real observation the
    // internal-only axes (more reasoning, more samples) cannot supply.
    const feedback = observation.feedback?.trim();
    if (feedback) {
      currentScenario = `${scenario}\n\n${header} ${feedback}`;
    }
  }

  const finalAttempt = attempts[attempts.length - 1]!;
  return {
    result: finalAttempt.result,
    attempts,
    resolved,
    resolvedAtAttempt,
    revisedToResolve: resolved && resolvedAtAttempt !== 1,
  };
}
