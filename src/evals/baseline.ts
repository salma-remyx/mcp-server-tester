import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { EvalRunnerResult } from './evalRunner.js';

/**
 * Saves eval results to a JSON file for use as a baseline in future runs.
 *
 * @param result - The eval run result to save
 * @param filePath - Path to write the JSON file (parent dirs created automatically)
 */
export async function saveBaseline(
  result: EvalRunnerResult,
  filePath: string
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(result, null, 2), 'utf8');
}

/**
 * Loads a previously saved baseline from a JSON file.
 *
 * @param filePath - Path to the JSON file written by saveBaseline
 * @returns The saved EvalRunnerResult
 * @throws If the file cannot be read or parsed
 */
export async function loadBaseline(
  filePath: string
): Promise<EvalRunnerResult> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as EvalRunnerResult;
}

/**
 * Builds a map of case ID → pass status from a baseline result.
 * Used internally by runEvalDataset to tag current results with baseline status.
 */
export function buildBaselinePassMap(
  baseline: EvalRunnerResult
): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const result of baseline.caseResults) {
    map.set(result.id, result.pass);
  }
  return map;
}
