/**
 * MCP Host Simulation Module
 *
 * Provides functionality for testing MCP servers through MCP hosts,
 * validating tool descriptions, parameter clarity, and discoverability.
 */

export * from './mcpHostTypes.js';
export * from './mcpHostSimulation.js';

// Built-in Claude Code CLI adapter
export { claudeCodeAdapter } from './adapters/cli/index.js';
