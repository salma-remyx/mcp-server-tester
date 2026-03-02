# Eval Checklist — @gleanwork/mcp-server-tester

Generated: 2026-03-02 | Current version: 1.0.0-beta.2 | Next target: 1.0.0

## How to read this

- **P0** = release blocker | **P1** = should fix before release | **P2** = nice to have
- Each item has a unique ID, acceptance criteria specific enough to verify with a file read, and the agents/PRs that surfaced or closed it
- Items are OPEN until acceptance criteria are verifiably met

---

## P0 — Release Blockers

*None currently open.*

---

## P1 — Should Fix Before Release

*None currently open.*

---

## P2 — Nice to Have (Post-1.0 Candidates)

- [ ] **CHK-010** Ink CLI commands (`init`, `generate`) crash with cryptic error in non-TTY environments
  - **File:** `src/cli/commands/init/index.ts`, `src/cli/commands/generate/index.ts`
  - **Acceptance:** Either (a) detect non-TTY and exit with helpful message pointing to docs, or (b) add `--non-interactive` JSON mode
  - **Opened:** 1.0.0-beta.2 panel | **Agent:** devils-advocate
  - **Note:** Documented limitation; commands are designed for TTY use. Error message improvement alone would close this.

- [ ] **CHK-011** `toMatchToolSnapshot` matcher has zero integration tests in a real Playwright context
  - **File:** `src/assertions/matchers/toMatchToolSnapshot.ts`
  - **Acceptance:** At least one test in `tests/` exercises the matcher end-to-end with actual snapshot file creation/comparison
  - **Opened:** 1.0.0-beta.2 panel | **Agent:** test-confidence

- [ ] **CHK-012** Reporter string path configuration is a footgun — users may try to import the reporter as a JS module
  - **File:** `docs/ui-reporter.md`
  - **Acceptance:** Prominent "Common mistake" callout noting the reporter must be configured as a string path, not imported
  - **Opened:** 1.0.0-beta.2 panel | **Agent:** devils-advocate

- [ ] **CHK-013** Optional peer dependency install instructions not in quickstart
  - **File:** `docs/quickstart.md`
  - **Acceptance:** Quickstart mentions that `llm_host` mode requires `npm install ai @ai-sdk/<provider>` with a link to llm-host.md for provider table
  - **Opened:** 1.0.0-beta.2 panel | **Agent:** devils-advocate

---

## Closed

- [x] **CHK-001** `@ai-sdk/ollama` does not exist on npm — runtime crash when selected
  - **File:** `src/evals/llmHost/llmHostTypes.ts:32`, `src/evals/llmHost/adapters/vercel.ts:137`
  - **Closed by:** PR #85 | **Verified:** 1.0.0-beta.2 panel (all agents confirmed)

- [x] **CHK-002** `isInfrastructureError()` case-sensitive — misses ECONNRESET as `err.code` on Windows
  - **File:** `src/evals/evalRunner.ts:568`
  - **Closed by:** PR #87 | **Verified:** 1.0.0-beta.2 panel

- [x] **CHK-003** Precision metric hardcoded to 1.0 for non-exclusive `toolsTriggered`
  - **File:** `src/assertions/validators/toolCalls.ts:110`
  - **Closed by:** PR #86 | **Verified:** 1.0.0-beta.2 panel

- [x] **CHK-004** `setupOAuth.ts` (295 lines) had zero test coverage
  - **File:** `src/auth/setupOAuth.ts`
  - **Closed by:** PR #88 (28 tests added) | **Verified:** 1.0.0-beta.2 panel

- [x] **CHK-005** `toMatchToolSnapshot` sanitizer logic had zero dedicated tests
  - **File:** `src/assertions/matchers/toMatchToolSnapshot.ts`
  - **Closed by:** PR #89 (22 tests added) | **Verified:** 1.0.0-beta.2 panel

- [x] **CHK-006** `toMatchToolSnapshot` invalid regex string caused uncaught SyntaxError
  - **File:** `src/assertions/matchers/toMatchToolSnapshot.ts:96`
  - **Closed by:** PR #95 | **Verified:** 1.0.0-beta.2 panel

- [x] **CHK-007** `accuracy` deprecated alias on `EvalCaseResult` should be removed before 1.0
  - **File:** `src/types/reporter.ts:220`
  - **Closed by:** PR #99 | **Verified:** typecheck clean, 778 tests pass

- [x] **CHK-008** `toMatchToolSnapshot` Playwright context requirement undocumented
  - **File:** `src/assertions/matchers/toMatchToolSnapshot.ts:159`, `docs/expectations.md`
  - **Closed by:** PR #99 | **Acceptance met:** JSDoc @remarks added, warning callout in docs/expectations.md

- [x] **CHK-009** README matcher table missing `toMatchToolResponse` (10 of 11 listed)
  - **File:** `README.md`
  - **Closed by:** PR #99 | **Acceptance met:** toMatchToolResponse added as first row

- [x] **CHK-014** `mcpAuthTest` export undiscoverable — no documentation on when to use it
  - **File:** `src/index.ts:150`
  - **Closed by:** PR #100 | **Acceptance met:** "Extending OAuth Test Fixtures" section added to docs/authentication.md
