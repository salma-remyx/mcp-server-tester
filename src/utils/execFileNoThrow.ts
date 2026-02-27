import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ExecFileResult {
  status: 0 | 1;
  stdout: string;
  stderr: string;
}

/**
 * Runs execFile without throwing on non-zero exit codes.
 * Always returns a result object rather than throwing.
 */
export async function execFileNoThrow(
  file: string,
  args: string[]
): Promise<ExecFileResult> {
  try {
    const result = await execFileAsync(file, args);
    return {
      status: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string };
    return {
      status: 1,
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
    };
  }
}
