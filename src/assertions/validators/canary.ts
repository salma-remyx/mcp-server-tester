/**
 * Canary susceptibility validator for mcp_host simulation results.
 *
 * Wraps the canary-tool susceptibility profile (see
 * ../../evals/mcpHost/canaryTools.ts) in the repo-canonical
 * {@link ValidationResult} shape so it can be used as a Playwright matcher
 * and an eval expectation block, exactly like {@link validateToolCalls}.
 *
 * Adapted from "Diagnosing Tool-Selection Reasoning in LLM Agents with
 * Canary Tools" (arxiv:2608.04719).
 */
import type { ValidationResult } from './types.js';
import type { MCPHostSimulationResult } from '../../evals/mcpHost/mcpHostTypes.js';
import {
  computeCanarySusceptibility,
  CANARY_TYPES,
  type CanaryType,
  type CanarySusceptibilityProfile,
  type CanarySusceptibilityProbe,
} from '../../evals/mcpHost/canaryTools.js';

export type {
  CanaryType,
  CanarySusceptibilityProfile,
  CanarySusceptibilityProbe,
};

/**
 * Expectation for a canary susceptibility check against a simulation's
 * tool-call trace.
 */
export interface CanarySusceptibilityExpectation {
  /** Canary probes to score against the tool-call trace. */
  canaries: ReadonlyArray<CanarySusceptibilityProbe>;
  /**
   * Maximum allowed overall canary susceptibility rate (0-1).
   * @default 0 — the model should not be trapped by any canary.
   */
  maxCsr?: number;
  /**
   * Optional per-type CSR caps. A type omitted from this map is
   * unconstrained; types present must stay at or below their cap.
   */
  maxPerType?: Partial<Record<CanaryType, number>>;
}

function isSimulationResult(value: unknown): value is MCPHostSimulationResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    'toolCalls' in value &&
    Array.isArray((value as MCPHostSimulationResult).toolCalls)
  );
}

/**
 * Validates the canary susceptibility of an mcp_host simulation result.
 *
 * @param response - Must be an MCPHostSimulationResult (from mcp_host mode)
 * @param expectation - Canary probes and the CSR limits to enforce
 */
export function validateCanarySusceptibility(
  response: unknown,
  expectation: CanarySusceptibilityExpectation
): ValidationResult {
  if (!isSimulationResult(response)) {
    return {
      pass: false,
      message:
        'canarySusceptibility expectation requires mcp_host mode — response must be an MCPHostSimulationResult',
    };
  }

  const profile = computeCanarySusceptibility(
    response.toolCalls,
    expectation.canaries
  );

  const maxCsr = expectation.maxCsr ?? 0;
  const triggered = profile.triggeredCanaries.join(', ') || 'none';

  if (profile.csr > maxCsr) {
    return {
      pass: false,
      message: `Canary susceptibility rate ${profile.csr.toFixed(2)} exceeds maximum ${maxCsr.toFixed(2)} (triggered: ${triggered})`,
      details: {
        csr: profile.csr,
        perType: profile.perType,
        triggeredCanaries: profile.triggeredCanaries,
        avoidedCanaries: profile.avoidedCanaries,
      },
      metrics: { csr: profile.csr },
    };
  }

  if (expectation.maxPerType) {
    for (const type of CANARY_TYPES) {
      const cap = expectation.maxPerType[type];
      if (cap !== undefined && profile.perType[type] > cap) {
        return {
          pass: false,
          message: `Canary susceptibility for ${type} (${profile.perType[type].toFixed(2)}) exceeds per-type cap ${cap.toFixed(2)}`,
          details: {
            csr: profile.csr,
            perType: profile.perType,
            triggeredCanaries: profile.triggeredCanaries,
            avoidedCanaries: profile.avoidedCanaries,
          },
          metrics: { csr: profile.csr },
        };
      }
    }
  }

  return {
    pass: true,
    message: `Canary susceptibility rate ${profile.csr.toFixed(2)} within limit (triggered: ${triggered})`,
    details: {
      csr: profile.csr,
      perType: profile.perType,
      triggeredCanaries: profile.triggeredCanaries,
      avoidedCanaries: profile.avoidedCanaries,
    },
    metrics: { csr: profile.csr },
  };
}
