/**
 * MCP Host Simulation Module
 *
 * Provides functionality for testing MCP servers through MCP hosts,
 * validating tool descriptions, parameter clarity, and discoverability.
 */

export * from './mcpHostTypes.js';
export * from './mcpHostSimulation.js';

// CLI host adapters
export type {
  CLIHostAdapter,
  CLIInvocation,
  CLIHostOptions,
} from './adapters/cli/index.js';
export {
  registerCLIHost,
  getCLIHost,
  isCLIHost,
  clearCLIHostRegistry,
  runCLIHost,
  claudeCodeAdapter,
  parseStreamJson,
  createJsonParser,
} from './adapters/cli/index.js';
