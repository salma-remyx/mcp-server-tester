# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@mcp-testing/server-tester` is a Playwright-based testing and evaluation framework for Model Context Protocol (MCP) servers. It provides Playwright fixtures for automated testing and data-driven eval datasets with optional LLM-as-a-judge scoring.

## Common Commands

```bash
# Build (includes UI reporter build)
npm run build

# Unit tests (Vitest)
npm test                    # Run all unit tests
npm run test:watch          # Watch mode
npm test -- src/mcp/clientFactory.test.ts  # Run single test file
npm test -- -t "creates client"            # Run tests matching pattern

# Integration tests (Playwright)
npm run test:playwright

# Code quality
npm run typecheck           # TypeScript validation
npm run lint                # ESLint
npm run lint:fix            # Auto-fix lint issues
npm run format              # Prettier formatting
npm run format:check        # Check formatting
```

## Architecture

### Core Modules (`src/`)

- **`config/`** - `MCPConfig` types and Zod validation for stdio/HTTP transports
- **`mcp/`** - Client factory (`createMCPClientForConfig`), fixtures (`MCPFixtureApi`), and response normalization
- **`auth/`** - OAuth 2.1 with PKCE (`PlaywrightOAuthClientProvider`) and static token utilities
- **`assertions/`** - Unified assertion architecture (see below)
- **`evals/`** - Dataset types, loader, and runner (uses validators internally)
- **`judge/`** - LLM-as-a-judge via Claude Agent SDK
- **`spec/`** - MCP protocol conformance checks
- **`reporters/`** - Custom Playwright reporter with React-based UI
- **`cli/`** - `mcp-test init` and `mcp-test generate` commands

### Assertions Module (`src/assertions/`)

The assertion architecture provides a single API for both inline tests and data-driven evals:

- **`validators/`** - Pure validation functions: `validateText`, `validateSchema`, `validatePattern`, `validateError`, `validateSize`, `validateResponse`
- **`matchers/`** - Playwright custom matchers: `toContainToolText`, `toMatchToolSchema`, `toMatchToolPattern`, `toBeToolError`, `toHaveToolResponseSize`, `toMatchToolResponse`, `toMatchToolSnapshot`, `toPassToolJudge`, `toSatisfyToolPredicate`

```typescript
// Inline test usage
import { expect } from '@mcp-testing/server-tester';

test('weather tool', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', { city: 'London' });
  expect(result).toContainToolText('temperature');
  expect(result).toMatchToolSchema(WeatherSchema);
  expect(result).not.toBeToolError();
});

// Programmatic validation
import { validateText } from '@mcp-testing/server-tester';

const result = validateText(response, ['temperature']);
if (!result.pass) console.log(result.message);
```

### Playwright Fixtures (`src/fixtures/mcp.ts`)

The main test fixture provides:

- `mcpClient: Client` - Raw MCP SDK client
- `mcp: MCPFixtureApi` - High-level test API with `listTools()`, `callTool()`, etc.

Configuration is read from `project.use.mcpConfig` in playwright.config.ts.

### Exports

Public API is defined in `src/index.ts`. The package has multiple export paths:

- `.` - Main library exports
- `./fixtures/mcp` - Playwright test fixtures
- `./fixtures/mcpAuth` - Auth-specific fixtures for OAuth/token auth
- `./reporters/mcpReporter` - Custom reporter

## Type Architecture

### Single Source of Truth

Types are organized in a canonical hierarchy to prevent duplication and drift:

- **`src/types/index.ts`** - Core shared types: `AuthType`, `ResultSource`, `ExpectationType`, `EvalExpectationResult`
- **`src/types/reporter.ts`** - Reporter-specific types: `MCPEvalRunData`, `EvalCaseResult`, `MCPConformanceResultData`, `MCPServerCapabilitiesData`

### Import Guidelines

1. **For new code**: Always import from `src/types/` first
2. **For existing modules**: Import from their own domain, which re-exports from canonical source
3. **Never define** `AuthType`, `ExpectationType`, or other core types inline - import them

```typescript
// Correct: Import from canonical source
import type { AuthType, ExpectationType } from '../types/index.js';

// Correct: Import from domain module (which re-exports)
import type { EvalCaseResult } from '../types/reporter.js';

// Wrong: Inline type literal
authType?: 'oauth' | 'api-token' | 'none';  // Don't do this!
```

### UI Type Synchronization

The UI types in `src/reporters/ui-src/types.ts` must manually stay in sync with backend types. When updating backend types, also update:

1. `src/types/reporter.ts` (canonical backend)
2. `src/reporters/ui-src/types.ts` (UI copy)

## Code Style

- Use function declarations, not arrow function expressions for exports
- Use explicit `null` in ternaries instead of short-circuit (`condition ? 'value' : null`)
- Descriptive type names (e.g., `EvalDataset`, `MCPFixtureApi`, `Judge`, `ValidationResult`)
- No `any` types - TypeScript strict mode is enabled
- Keep `async` keyword even if no `await` currently used

## Commit Messages

Use conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`

## Adding New Features

### New Validator

1. Create `src/assertions/validators/myValidator.ts` returning `ValidationResult`
2. Export from `src/assertions/validators/index.ts`
3. Add unit tests in `src/assertions/validators/validators.test.ts`

### New Matcher

1. Create `src/assertions/matchers/toMyMatcher.ts` using a validator
2. Register in `src/assertions/matchers/index.ts`
3. Add TypeScript declaration in `src/assertions/matchers/types.ts`
4. Export from `src/index.ts`

### New LLM Judge Provider

1. Add to `ProviderKind` in `src/judge/judgeTypes.ts`
2. Implement `Judge` interface in `src/judge/myProviderJudge.ts`
3. Add to switch in `src/judge/judgeClient.ts`

### New Transport Type

1. Add to `MCPConfig` union in `src/config/mcpConfig.ts`
2. Update `createMCPClientForConfig()` in `src/mcp/clientFactory.ts`

### New Auth Provider

1. Implement `OAuthClientProvider` interface from `@modelcontextprotocol/sdk/client/auth.js`
2. Add utilities to `src/auth/` module
3. Export from `src/index.ts`
