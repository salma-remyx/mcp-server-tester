/**
 * Decision Protocols for multi-judge aggregation.
 *
 * Adapted from: "Voting or Consensus? Decision-Making in Multi-Agent Debate"
 * (arXiv:2502.19130). That work systematically compares decision-making
 * protocols for multi-agent debate and reports an actionable split: voting-style
 * protocols tend to suit *reasoning* rubrics, while consensus-style protocols
 * tend to suit *knowledge* rubrics.
 *
 * This module ports that core contribution — a comparable family of decision
 * protocols — onto the repo's existing multi-judge path, which previously froze
 * its rule to unanimous-AND. `unanimous` remains the default, so existing
 * behavior is preserved; the rule is now configurable.
 *
 * Intentionally out of scope (auxiliary debate infrastructure the paper also
 * studies, but that the repo's contract does not host): multi-round discussion,
 * inter-agent communication, and ranking/Borda aggregation across a continuous
 * candidate set. The multi-judge path runs N independent judges and aggregates
 * binary pass/fail votes; the protocols below operate on that contract.
 */

/**
 * The comparable family of decision protocols.
 *
 * - Consensus family (broad agreement; suits knowledge rubrics):
 *   `unanimous`, `supermajority`.
 * - Voting family (a plurality of votes decides; suits reasoning rubrics):
 *   `majority`, `plurality`.
 *
 * Note: with binary pass/fail votes, `plurality` reduces to "more pass than
 * fail" and so coincides with `majority`; it diverges only once neutral /
 * abstain votes are introduced.
 */
export type DecisionProtocol =
  | 'unanimous'
  | 'supermajority'
  | 'majority'
  | 'plurality';

/**
 * Default protocol. Preserves the historical multi-judge behavior
 * (all judges must pass).
 */
export const DEFAULT_DECISION_PROTOCOL: DecisionProtocol = 'unanimous';

/** Default pass-fraction required by each named protocol. */
const PROTOCOL_THRESHOLD: Record<DecisionProtocol, number> = {
  // Consensus — broad agreement required.
  unanimous: 1.0,
  supermajority: 2 / 3,
  // Voting — a simple/plurality majority decides. Plurality is resolved by a
  // direct bloc comparison in resolveDecision rather than this threshold.
  majority: 0.5,
  plurality: 0.0,
};

/** A single judge's vote to be aggregated. */
export interface JudgeVote {
  /** Whether this judge passed. */
  pass: boolean;
  /** Optional score for richer summaries / future score-weighted protocols. */
  score?: number;
  /** Optional per-judge reasoning, surfaced in aggregated details. */
  message?: string;
  /** Optional label (e.g. rubric name) for the aggregated summary. */
  label?: string;
}

/**
 * Selects and tunes the decision protocol for a multi-judge aggregation.
 */
export interface DecisionProtocolConfig {
  /** Named protocol. @default 'unanimous' */
  protocol?: DecisionProtocol;
  /**
   * Fraction of judges (0–1) that must pass. Overrides the protocol's default
   * bar when set (does not apply to `plurality`, which is bloc-based).
   */
  agreementThreshold?: number;
  /**
   * Minimum number of passing judges (absolute count). Overrides any
   * fraction-based bar when set.
   */
  minAgree?: number;
}

/** The resolved result of aggregating judge votes under a protocol. */
export interface DecisionOutcome {
  /** Whether the aggregation passed. */
  pass: boolean;
  /** Protocol used to reach the verdict. */
  protocol: DecisionProtocol;
  /** Number of judges that passed. */
  passCount: number;
  /** Number of judges that failed. */
  failCount: number;
  /** Total number of judges that voted. */
  total: number;
  /** Fraction of judges that passed (0–1). */
  agreement: number;
  /** Minimum number of passing judges required by the resolved protocol. */
  required: number;
  /** One-line human-readable summary. */
  summary: string;
}

function clampFraction(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function describeBar(
  protocol: DecisionProtocol,
  required: number,
  total: number
): string {
  switch (protocol) {
    case 'unanimous':
      return `all ${total} required`;
    case 'majority':
      return `>${Math.floor(total / 2)} of ${total} required`;
    case 'plurality':
      return `more pass than fail`;
    case 'supermajority':
      return `≥${required}/${total} required`;
    default:
      return `≥${required}/${total} required`;
  }
}

/**
 * Aggregates per-judge votes into a single verdict under a decision protocol.
 *
 * @param votes - Per-judge pass/score results.
 * @param config - Optional protocol selection / tuning.
 * @returns The aggregated decision (pass + summary).
 *
 * @example
 * ```typescript
 * // Strict majority — voting, suits reasoning rubrics
 * resolveDecision(
 *   [{ pass: true }, { pass: true }, { pass: false }],
 *   { protocol: 'majority' }
 * ).pass; // true (2/3 > half)
 *
 * // Unanimous — consensus, suits knowledge rubrics (default)
 * resolveDecision(
 *   [{ pass: true }, { pass: true }, { pass: false }]
 * ).pass; // false (not all passed)
 * ```
 */
export function resolveDecision(
  votes: ReadonlyArray<JudgeVote>,
  config?: DecisionProtocolConfig
): DecisionOutcome {
  const total = votes.length;
  const passCount = votes.filter((v) => v.pass).length;
  const failCount = total - passCount;
  const agreement = total > 0 ? passCount / total : 0;
  const protocol = config?.protocol ?? DEFAULT_DECISION_PROTOCOL;

  if (total === 0) {
    return {
      pass: false,
      protocol,
      passCount: 0,
      failCount: 0,
      total: 0,
      agreement: 0,
      required: 0,
      summary: `${protocol}: no judges voted`,
    };
  }

  let required: number;
  let pass: boolean;

  if (config?.minAgree !== undefined) {
    // Absolute count override wins over any fraction.
    required = Math.max(0, Math.floor(config.minAgree));
    pass = passCount >= required;
  } else if (config?.agreementThreshold !== undefined) {
    // Custom fraction override (ceil so a partial bar still rounds up to a
    // whole judge — e.g. 0.5 of 3 judges => 2 required).
    required = Math.ceil(total * clampFraction(config.agreementThreshold));
    pass = passCount >= required;
  } else if (protocol === 'plurality') {
    // Largest bloc wins; ties fail. For binary votes this coincides with
    // majority — kept distinct to mirror the paper's protocol family.
    required = Math.floor(total / 2) + 1;
    pass = passCount > failCount;
  } else if (protocol === 'majority') {
    required = Math.floor(total / 2) + 1; // strict majority
    pass = passCount >= required;
  } else if (protocol === 'unanimous') {
    required = total;
    pass = passCount >= required;
  } else {
    // supermajority (and any future threshold-based protocol).
    required = Math.ceil(total * PROTOCOL_THRESHOLD[protocol]);
    pass = passCount >= required;
  }

  const pct = `${Math.round(agreement * 100)}%`;
  const summary = `${protocol}: ${passCount}/${total} judges passed (${pct}, ${describeBar(protocol, required, total)})`;

  return {
    pass,
    protocol,
    passCount,
    failCount,
    total,
    agreement,
    required,
    summary,
  };
}
