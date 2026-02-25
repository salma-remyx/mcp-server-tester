/**
 * Glean MCP Server — End-to-End Eval Suite
 *
 * Runs against the live Glean remote MCP server at scio-prod-be.glean.com.
 * Requires valid OAuth tokens stored by a prior `mcp-server-tester login` run.
 *
 * Run with:
 *   npm run test:playwright -- --config playwright.glean.config.ts
 *
 * To authenticate first (one-time):
 *   npx mcp-server-tester login https://scio-prod-be.glean.com/mcp/default
 */

import { test, expect } from '../src/fixtures/mcp.js';
import { runEvalDataset, loadEvalDataset } from '../src/index.js';
import { runConformanceChecks } from '../src/spec/conformanceChecks.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATASET_PATH = join(__dirname, '../data/glean-mcp-evals.json');

test.describe('Glean MCP Server — Conformance', () => {
  test('server advertises tools and conforms to MCP spec', async ({ mcp }) => {
    const result = await runConformanceChecks(mcp, {
      validateSchemas: true,
      checkServerInfo: true,
    });

    expect(result.pass).toBe(true);

    const tools = result.raw.tools ?? [];
    console.log(
      `\nTools available (${tools.length}): ${tools.map((t) => t.name).join(', ')}`
    );

    // Verify the expected tools are present
    const toolNames = tools.map((t) => t.name);
    for (const expected of [
      'search',
      'employee_search',
      'chat',
      'code_search',
    ]) {
      expect(toolNames).toContain(expected);
    }
  });
});

test.describe('Glean MCP Server — Direct Mode Evals', () => {
  test('all direct-mode cases pass', async ({ mcp }, testInfo) => {
    const dataset = await loadEvalDataset(DATASET_PATH);

    // Run only direct mode cases
    const directDataset = {
      ...dataset,
      cases: dataset.cases.filter((c) => c.mode !== 'llm_host'),
    };

    const result = await runEvalDataset(
      { dataset: directDataset, concurrency: 2 },
      { mcp, testInfo }
    );

    console.log(
      `\nDirect evals: ${result.passed}/${result.total} passed (${((result.passed / result.total) * 100) | 0}%)`
    );

    result.caseResults.forEach((r) => {
      const status = r.pass ? '✅' : '❌';
      console.log(`  ${status} ${r.id}${r.error ? ` — ${r.error}` : ''}`);
    });

    expect(result.passed).toBe(result.total);
  });
});

test.describe('Glean MCP Server — LLM Host Tool Triggering Evals', () => {
  test('LLM correctly triggers tools for knowledge scenarios', async ({
    mcp,
  }, testInfo) => {
    const dataset = await loadEvalDataset(DATASET_PATH);

    // Run only llm_host mode cases
    const llmDataset = {
      ...dataset,
      cases: dataset.cases.filter((c) => c.mode === 'llm_host'),
    };

    const result = await runEvalDataset(
      {
        dataset: llmDataset,
        concurrency: 1, // sequential — avoid rate limits
      },
      { mcp, testInfo }
    );

    console.log(`\nLLM host evals: ${result.passed}/${result.total} passed`);

    result.caseResults.forEach((r) => {
      const status = r.pass ? '✅' : '❌';
      const accuracy =
        r.accuracy !== undefined
          ? ` (accuracy: ${(r.accuracy * 100).toFixed(0)}%)`
          : '';
      const toolsUsed = r.iterationResults
        ? ` — ${r.iterationResults.filter((i) => i.pass).length}/${r.iterationResults.length} iterations passed`
        : '';
      console.log(`  ${status} ${r.id}${accuracy}${toolsUsed}`);
      // Surface per-iteration errors for debugging
      if (r.iterationResults) {
        r.iterationResults.forEach((iter, i) => {
          if (iter.error)
            console.log(`     iter ${i + 1} error: ${iter.error}`);
        });
      }
      if (r.error) console.log(`     case error: ${r.error}`);
    });

    // Soft assertion: report results but don't fail CI if LLM accuracy is below threshold
    // Comment out the line below to make this a hard failure
    const passRate = result.passed / result.total;
    console.log(
      `\nOverall LLM eval pass rate: ${(passRate * 100).toFixed(0)}%`
    );

    // Hard assertion: at least 50% of LLM host cases must pass
    // (accommodates non-determinism; individual cases use their own thresholds)
    expect(result.passed).toBeGreaterThanOrEqual(
      Math.floor(result.total * 0.5)
    );
  });
});

test.describe('Glean MCP Server — Full Dataset Run', () => {
  test('full dataset summary', async ({ mcp }, testInfo) => {
    const dataset = await loadEvalDataset(DATASET_PATH);

    const result = await runEvalDataset(
      {
        dataset,
        concurrency: 1, // sequential for stability
      },
      { mcp, testInfo }
    );

    // Print the full accuracy report
    console.log('\n═══════════════════════════════════════');
    console.log(`GLEAN MCP EVAL RESULTS — ${new Date().toISOString()}`);
    console.log('═══════════════════════════════════════');
    console.log(
      `Total: ${result.passed}/${result.total} passed (${((result.passed / result.total) * 100) | 0}%)`
    );
    console.log(`Duration: ${result.durationMs}ms\n`);

    const directResults = result.caseResults.filter(
      (r) => r.iterationResults === undefined
    );
    const llmResults = result.caseResults.filter(
      (r) => r.iterationResults !== undefined
    );

    if (directResults.length > 0) {
      console.log('Direct mode:');
      directResults.forEach((r) => {
        console.log(`  ${r.pass ? '✅' : '❌'} ${r.id}`);
      });
    }

    if (llmResults.length > 0) {
      console.log('\nLLM host mode (accuracy per case):');
      llmResults.forEach((r) => {
        const pct =
          r.accuracy !== undefined
            ? `${(r.accuracy * 100).toFixed(0)}%`
            : 'n/a';
        const passed = r.iterationResults?.filter((i) => i.pass).length ?? 0;
        const total = r.iterationResults?.length ?? 0;
        console.log(
          `  ${r.pass ? '✅' : '❌'} ${r.id}: ${pct} (${passed}/${total})`
        );
      });
    }
    console.log('═══════════════════════════════════════\n');
  });
});
