/**
 * toBeFreeOfTrajectoryAnomalies Matcher
 *
 * Asserts that an mcp_host simulation trajectory is free of the deterministic
 * failure signatures detected by validateTrajectoryAnomalies — tool-call loops
 * and consecutive tool-error cascades. A cheap, judge-free failure check that
 * runs on the recorded telemetry.
 */
import {
  validateTrajectoryAnomalies,
  type TrajectoryAnomalyOptions,
} from '../validators/trajectoryAnomalies.js';

/**
 * Creates the toBeFreeOfTrajectoryAnomalies matcher function.
 */
export function toBeFreeOfTrajectoryAnomalies(
  this: { isNot: boolean },
  received: unknown,
  options?: TrajectoryAnomalyOptions
) {
  const result = validateTrajectoryAnomalies(received, options);

  return {
    pass: result.pass,
    message: () => result.message,
  };
}
