import { spawn } from 'node:child_process';
import type { MCPConfig } from '../../../../config/mcpConfig.js';
import type {
  MCPHostSimulationResult,
  LLMToolCall,
} from '../../mcpHostTypes.js';
import type { CLIHostAdapter, CLIHostOptions } from './types.js';

const DEFAULT_TIMEOUT = 60_000;

/** Runs a CLI host adapter: builds the command, spawns the process, parses output. */
export async function runCLIHost(
  adapter: CLIHostAdapter,
  scenario: string,
  mcpConfig: MCPConfig,
  options?: CLIHostOptions
): Promise<MCPHostSimulationResult> {
  const invocation = adapter.buildCommand(scenario, mcpConfig, options);
  const timeout = invocation.timeout ?? DEFAULT_TIMEOUT;

  const startTime = Date.now();

  let stdout: string;
  let stderr = '';
  try {
    const result = await spawnProcess(invocation.command, invocation.args, {
      env: { ...process.env, ...invocation.env },
      timeout,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes('TIMEOUT') || message.includes('timed out')) {
      return {
        success: false,
        toolCalls: [],
        error:
          `CLI host timed out after ${elapsed}ms (limit: ${timeout}ms). ` +
          `Increase timeout via mcpHostConfig.timeout or CLIInvocation.timeout.`,
      };
    }

    return {
      success: false,
      toolCalls: [],
      error: `CLI host process failed: ${message}${stderr ? `\nstderr: ${stderr}` : ''}`,
    };
  }

  let result: MCPHostSimulationResult;
  try {
    result = adapter.parseOutput(stdout);
  } catch (err) {
    return {
      success: false,
      toolCalls: [],
      error:
        `Failed to parse CLI host output: ${err instanceof Error ? err.message : String(err)}` +
        `\nstdout (first 500 chars): ${stdout.slice(0, 500)}`,
    };
  }

  const validationError = validateSimulationResult(result);
  if (validationError) {
    return {
      success: false,
      toolCalls: [],
      error: `CLI host adapter returned invalid result: ${validationError}`,
    };
  }

  return result;
}

function validateSimulationResult(result: unknown): string | null {
  if (result === null || typeof result !== 'object') {
    return `Expected object, got ${typeof result}`;
  }

  const obj = result as Record<string, unknown>;

  if (typeof obj.success !== 'boolean') {
    return `"success" must be a boolean, got ${typeof obj.success}`;
  }

  if (!Array.isArray(obj.toolCalls)) {
    return `"toolCalls" must be an array, got ${typeof obj.toolCalls}`;
  }

  for (let i = 0; i < obj.toolCalls.length; i++) {
    const tc = obj.toolCalls[i] as LLMToolCall;
    if (typeof tc.name !== 'string') {
      return `toolCalls[${i}].name must be a string, got ${typeof tc.name}`;
    }
    if (typeof tc.arguments !== 'object' || tc.arguments === null) {
      return `toolCalls[${i}].arguments must be an object, got ${typeof tc.arguments}`;
    }
  }

  return null;
}

/**
 * Uses `spawn` (not `execFile`) so we can close stdin immediately —
 * Claude Code waits for stdin input if it's left open.
 */
function spawnProcess(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.end();

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    const MAX_BUFFER = 10 * 1024 * 1024; // 10MB

    child.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes <= MAX_BUFFER) {
        stdoutChunks.push(chunk);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes <= MAX_BUFFER) {
        stderrChunks.push(chunk);
      }
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Process timed out after ${options.timeout}ms`));
    }, options.timeout);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');

      if (code !== 0) {
        const err = new Error(
          `Command failed with exit code ${code ?? 'null'}${stderr ? `\nstderr: ${stderr}` : ''}`
        );
        reject(err);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}
