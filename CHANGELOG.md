





## [0.13.0] - 2026-02-26

### New Features
- OAuth 2.1 client credentials grant for CI/CD machine-to-machine auth (Issue 15)
- Wilson score confidence intervals on accuracy reporting (Issue 19)
- Retry with exponential backoff for transient connection failures (Issue 27)
- HTTP proxy support via config or environment variables (Issue 16)
- TLS configuration options (custom CA, client certs) (Issue 29)
- 5-point judge rubric scale with concrete scoring examples (Issue 20)
- Experiment tracking metadata in eval results (Issue 23)
- HTTP-level trace logging via `DEBUG=mcp-server-tester:http`
- Runtime warnings when eval config violates evals guide recommendations
- Vercel AI SDK orchestrator for LLM host mode (all 10 providers unified)
- EvalV2 parity: judge reps, rubric types, inline config, A/B comparison
- Streamable HTTP transport with SSE fallback
- `toHaveToolCalls` and `toHaveToolCallCount` Playwright matchers
- `validateToolCalls` and `validateToolCallCount` validators
- `defaultLlmIterations` and `defaultJudgeReps` options for eval datasets
- `vertex-anthropic` provider for LLM host mode

### Bug Fixes
- SSE transport fallback now correctly passes authProvider (Issue 1)
- Timeout config is now wired to transport/client (Issue 2)
- Infrastructure errors excluded from accuracy computation (Issue 3)
- Multi-iteration results now use first passing iteration as representative (Issue 4)
- Size expectation counter now incremented in reporter (Issue 5)
- `isCallToolResult` type guard requires content array per MCP spec (Issue 11)
- Client version no longer hardcoded as 0.1.0 (Issue 13)
- `MCPConfig` exported as discriminated union type (Issue 35)
- Fixed broken `extractTextFromResponse` import in examples and docs (Issue 8)
- Fixed incorrect function names in api-reference.md (Issue 38)
- Updated quickstart.md to remove deprecated v0.10 API references (Issue 37)
- Corrected false claim about automatic reconnection in transports.md (Issue 7)
- Replaced dangerous `console.log` token example in JSDoc with safe pattern

### Security
- OAuth state files written with `0o600` permissions (Issue 10)
- PKCE code verifier cleared after token exchange (Issue 17)
- OAuth debug logs no longer expose state/code_challenge parameters (Issue 32)
- XML structural boundaries in judge prompts prevent prompt injection (Issue 18)

### Documentation
- Added `docs/architecture.md` and `.github/CODEOWNERS` (Issue 47)
- Documented Node.js >= 22.0.0 requirement in README (Issue 39)
- Added comprehensive evals guide (`docs/evals-guide.md`)

## v0.12.0 (2025-12-16)

#### :boom: Breaking Change
* [#15](https://github.com/gleanwork/mcp-server-tester/pull/15) chore: rename package from @mcp-testing/server-tester to @gleanwork/mcp-server-tester ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :house: Internal
* [#16](https://github.com/gleanwork/mcp-server-tester/pull/16) fix: examples and exports after org migration ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v0.11.0 (2025-12-15)

#### :boom: Breaking Change
* [#14](https://github.com/mcp-testing/server-tester/pull/14) feat: unified assertion architecture with Playwright matchers ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

See [Migration Guide (v0.11)](docs/migration-0.11.md) for upgrade instructions.

#### Committers: 1
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v0.10.4 (2025-12-13)


## v0.10.3 (2025-12-13)

#### :rocket: Enhancement
* [#13](https://github.com/mcp-testing/server-tester/pull/13) feat: improve reporter UI with collapsible panels and better layout ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v0.10.2 (2025-12-11)

#### :bug: Bug Fix
* [#12](https://github.com/mcp-testing/server-tester/pull/12) feat: Use Playwright context as single source of truth for reporter metadata ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v0.10.1 (2025-12-10)

#### :bug: Bug Fix
* [#11](https://github.com/mcp-testing/server-tester/pull/11) feat: Improve OAuth token refresh and simplify test fixture auth ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v0.10.0 (2025-12-10)

#### :rocket: Enhancement
* [#10](https://github.com/mcp-testing/server-tester/pull/10) feat: Migrate CLI commands to Ink ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#9](https://github.com/mcp-testing/server-tester/pull/9) feat: Add authType metadata for test result filtering ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#8](https://github.com/mcp-testing/server-tester/pull/8) feat: Add error expectation support for testing error cases ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v0.9.0 (2025-12-06)

#### :boom: Breaking Change

- [#6](https://github.com/mcp-testing/server-tester/pull/6) refactor!: Simplify token storage API to single clear path ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :house: Internal

- [#7](https://github.com/mcp-testing/server-tester/pull/7) chore: Apply Prettier formatting across codebase ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1

- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

## v0.8.0 (2025-12-05)

#### :rocket: Enhancement

- [#5](https://github.com/mcp-testing/server-tester/pull/5) feat: Add snapshot testing, token export command, and OAuth improvements ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1

- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

## v0.7.0 (2025-12-04)

#### :rocket: Enhancement

- [#4](https://github.com/mcp-testing/server-tester/pull/4) fix: Hardens file permissions for token storage ([@scalvert](https://github.com/scalvert))
- [#3](https://github.com/mcp-testing/server-tester/pull/3) feat: Adds login CLI command for OAuth flows ([@scalvert](https://github.com/scalvert))

#### Committers: 1

- Steve Calvert ([@scalvert](https://github.com/scalvert))

## v0.6.1 (2025-12-01)

## v0.6.0 (2025-11-29)

## v0.5.1 (2025-11-27)

## v0.5.0 (2025-11-27)

# Changelog
