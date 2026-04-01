/**
 * CLI Host Adapters
 *
 * Registry and built-in adapters for CLI-based MCP hosts.
 */

export type { CLIHostAdapter, CLIInvocation, CLIHostOptions } from './types.js';
export {
  registerCLIHost,
  getCLIHost,
  isCLIHost,
  clearCLIHostRegistry,
} from './registry.js';
export { runCLIHost } from './runner.js';
export { claudeCodeAdapter } from './claudeCode.js';
export { parseStreamJson, createJsonParser } from './parsers.js';

// Auto-register built-in claude-code adapter
import { registerCLIHost } from './registry.js';
import { claudeCodeAdapter } from './claudeCode.js';

registerCLIHost('claude-code', claudeCodeAdapter);
