import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerCLIHost,
  getCLIHost,
  isCLIHost,
  clearCLIHostRegistry,
} from './registry.js';
import type { CLIHostAdapter } from './types.js';

const dummyAdapter: CLIHostAdapter = {
  buildCommand: () => ({ command: 'test', args: [] }),
  parseOutput: () => ({ success: true, toolCalls: [] }),
};

describe('CLI host registry', () => {
  beforeEach(() => clearCLIHostRegistry());

  it('registers and retrieves an adapter', () => {
    registerCLIHost('my-cli', dummyAdapter);
    expect(getCLIHost('my-cli')).toBe(dummyAdapter);
    expect(isCLIHost('my-cli')).toBe(true);
  });

  it('returns undefined for unknown host', () => {
    expect(getCLIHost('nope')).toBeUndefined();
    expect(isCLIHost('nope')).toBe(false);
  });

  it('is idempotent for same reference', () => {
    registerCLIHost('my-cli', dummyAdapter);
    registerCLIHost('my-cli', dummyAdapter);
    expect(getCLIHost('my-cli')).toBe(dummyAdapter);
  });

  it('throws on conflicting registration', () => {
    registerCLIHost('my-cli', dummyAdapter);
    const other: CLIHostAdapter = {
      buildCommand: () => ({ command: 'other', args: [] }),
      parseOutput: () => ({ success: true, toolCalls: [] }),
    };
    expect(() => registerCLIHost('my-cli', other)).toThrow(
      'already registered'
    );
  });

  it('clearCLIHostRegistry removes all entries', () => {
    registerCLIHost('a', dummyAdapter);
    clearCLIHostRegistry();
    expect(isCLIHost('a')).toBe(false);
  });
});
