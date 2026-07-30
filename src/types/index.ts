/**
 * Canonical type definitions for @gleanwork/mcp-server-tester
 *
 * This module is the single source of truth for shared types.
 * All other modules should import from here rather than defining their own.
 *
 * @packageDocumentation
 */

/**
 * Authentication type for MCP connections
 *
 * - 'oauth': Interactive OAuth 2.1 with PKCE (browser-based authentication)
 * - 'api-token': Static API token (e.g., from a dashboard or environment variable)
 * - 'none': No authentication
 */
export type AuthType = 'oauth' | 'api-token' | 'none';

/**
 * Source of test results
 *
 * - 'eval': From runEvalDataset() using JSON eval datasets
 * - 'test': From direct API test tracking (MCP fixture calls)
 */
export type ResultSource = 'eval' | 'test';

/**
 * Known expectation types supported by the framework
 */
export type ExpectationType =
  | 'exact'
  | 'schema'
  | 'textContains'
  | 'regex'
  | 'snapshot'
  | 'judge'
  | 'error'
  | 'size'
  | 'toolsTriggered'
  | 'toolCallCount';

/**
 * Result of an expectation check
 */
export interface EvalExpectationResult {
  /**
   * Whether the expectation passed
   */
  pass: boolean;

  /**
   * Optional details about the result
   */
  details?: string;

  /**
   * Judge score (0-1). Populated for passesJudge expectations.
   */
  score?: number;

  /**
   * Judge reasoning. Populated for passesJudge expectations.
   */
  reasoning?: string;

  /**
   * Judge name — rubric name (e.g. 'correctness') or custom judge name.
   * Populated for passesJudge expectations.
   */
  judgeName?: string;

  /**
   * Judge provider used. Populated for passesJudge expectations.
   */
  judgeProvider?: string;

  /**
   * Judge model used. Populated for passesJudge expectations.
   */
  judgeModel?: string;

  /**
   * Per-judge breakdown when multiple judges are used.
   * Each entry contains the individual judge's result.
   * Only populated when passesJudge is an array with 2+ entries.
   */
  judgeResults?: EvalExpectationResult[];

  /**
   * Inter-judge agreement and same-provider bias signal for a multi-judge
   * expectation. Only populated when 2+ judges voted (i.e. `judgeResults` is
   * present), so naive AND aggregation can be audited rather than trusted
   * blindly.
   */
  judgeReliability?: JudgeReliability;
}

/**
 * Same-provider leniency signal within a single multi-judge case.
 *
 * Partitions the voting judges by whether their provider matches the
 * candidate host under test, then compares pass rates. Adapted from
 * "Evaluating medical AI under missing information" (arxiv:2607.18828v1),
 * which shows that same-provider judges are systematically more lenient.
 */
export interface SameProviderBias {
  /** Provider of the candidate host under test. */
  candidateProvider: string;
  /** Judges whose provider matches the candidate host. */
  sameProviderJudges: number;
  /** Judges whose provider differs from the candidate host. */
  crossProviderJudges: number;
  /** Fraction of same-provider judges that passed (0-1). */
  sameProviderPassRate: number;
  /** Fraction of cross-provider judges that passed (0-1). */
  crossProviderPassRate: number;
  /** `sameProviderPassRate - crossProviderPassRate` (positive = same-provider
   *  judges more lenient). */
  gap: number;
  /** True when same-provider judges pass strictly more often. */
  biasFlag: boolean;
}

/**
 * Inter-judge agreement and same-provider leniency for one multi-judge case.
 *
 * Populated by the eval runner when a `passesJudge` expectation uses 2+
 * judges; lets callers see how much the judges agreed and whether the
 * same-provider judges were the lenient ones, instead of trusting the naive
 * AND aggregate.
 */
export interface JudgeReliability {
  /** Number of judges that voted. */
  judgeCount: number;
  /** Judges voting pass. */
  passCount: number;
  /** Judges voting fail. */
  failCount: number;
  /** Fraction of judges agreeing with the majority verdict (0-1). */
  agreement: number;
  /** Coarse agreement bucket. */
  category: 'unanimous' | 'majority' | 'split';
  /** Same-provider vs cross-provider leniency signal. `null` when the
   *  candidate host provider is unknown or no cross-provider judge voted. */
  sameProvider: SameProviderBias | null;
}

/**
 * Map of expectation type to result
 */
export type ExpectationResultMap = Partial<
  Record<ExpectationType, EvalExpectationResult>
>;

/**
 * Breakdown of expectation types used in a run
 */
export type ExpectationBreakdown = Partial<Record<ExpectationType, number>>;

export {
  SnapshotSanitizers,
  type BuiltInSanitizer,
  type FieldRemovalSanitizer,
  type JudgeMatcherOptions,
  type JudgeValidatorConfig,
  type PatternValidatorOptions,
  type PredicateResult,
  type RegexSanitizer,
  type SchemaRegistry,
  type SchemaValidatorOptions,
  type SizeValidatorOptions,
  type SnapshotSanitizer,
  type TextValidatorOptions,
  type ToolCallCountOptions,
  type ToolCallExpectation,
  type ToolPredicate,
  type ValidationResult,
} from './assertions.js';

export type {
  MCPConfig,
  StdioMCPConfig,
  HttpMCPConfig,
  MCPHostCapabilities,
  MCPAuthConfig,
  MCPOAuthConfig,
  MCPClientCredentialsConfig,
} from './config.js';

export type {
  StoredTokens,
  StoredClientInfo,
  StoredOAuthState,
  OAuthSetupConfig,
  TokenResult,
  PlaywrightOAuthClientProviderConfig,
  ClientCredentialsConfig,
  ProtectedResourceMetadata,
  ProtectedResourceDiscoveryResult,
  StoredServerMetadata,
  CLIOAuthClientConfig,
  CLIOAuthResult,
} from './auth.js';

export type {
  CreateMCPClientOptions,
  ContentBlock,
  NormalizedToolResponse,
  MCPFixtureApi,
  MCPFixtureOptions,
  MCPAuthFixtures,
} from './mcp.js';

export type {
  EvalCase,
  EvalDataset,
  EvalExpectBlock,
  JudgeExpectConfig,
  SerializedEvalDataset,
  EvalMode,
  LoadDatasetOptions,
  EvalContext,
  EvalRunnerResult,
  EvalRunnerOptions,
  ToolMetadataOverride,
  ToolOverrideVariant,
  StoredEvalResultLoadOptions,
  StoredEvalResultRef,
  StoredEvalResultSaveOptions,
  SaveBaselineOptions,
  ComparisonOutcome,
  CaseComparisonResult,
  ServerComparisonResult,
  ServerComparisonOptions,
  SaveServerComparisonOptions,
  CompareEvalRunsOptions,
  EvalCaseComparison,
  EvalCaseComparisonOutcome,
  EvalRunComparisonLabels,
  EvalRunComparisonResult,
  SaveEvalRunComparisonOptions,
  StoredEvalRunRef,
  ExperimentMetric,
  VariantExperimentReason,
  VariantRecommendation,
  VariantCandidateResult,
  VariantExperimentRound,
  ProposeVariantsContext,
  VariantImprovementProposal,
  VariantExperimentOptions,
  VariantExperimentResult,
  HostType,
  CLIOutputFormat,
  CLIConfig,
  LLMProvider,
  MCPHostConfig,
  LLMToolCall,
  MCPHostSimulationResult,
  MCPHostSimulator,
} from './evals.js';

export type {
  JudgeConfig,
  Judge,
  JudgeResult,
  UsageMetrics,
  ProviderKind,
  BuiltInRubric,
  RubricSpec,
  CustomJudgeExecutor,
  CustomJudgeResult,
} from './judge.js';

export type {
  MCPConformanceOptions,
  MCPConformanceResult,
  MCPConformanceCheck,
  MCPConformanceRaw,
} from './conformance.js';

export type {
  MCPEvalReporterConfig,
  EvalCaseRequest,
  EvalCaseResult,
  EvalRunMetadata,
  IterationResult,
  MCPEvalRunData,
  MCPEvalHistoricalSummary,
  MCPConformanceResultData,
  MCPServerCapabilitiesData,
  MCPEvalData,
} from './reporter.js';
