import type { MCPConfig } from '../../../../config/mcpConfig.js';
import type { MCPHostSimulationResult } from '../../mcpHostTypes.js';

export interface CLIInvocation {
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeout?: number;
}

export interface CLIHostAdapter {
  buildCommand(
    scenario: string,
    mcpConfig: MCPConfig,
    options?: CLIHostOptions
  ): CLIInvocation;

  parseOutput(stdout: string): MCPHostSimulationResult;
}

export interface CLIHostOptions {
  model?: string;
  maxToolCalls?: number;
  temperature?: number;
  binary?: string;
}
