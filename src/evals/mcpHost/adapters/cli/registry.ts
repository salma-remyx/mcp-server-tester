import type { CLIHostAdapter } from './types.js';

const registry = new Map<string, CLIHostAdapter>();

/**
 * Registers a CLI host adapter by provider name.
 *
 * Idempotent for the same adapter reference (safe for shared setup modules).
 * Throws if a different adapter is already registered under the same name.
 */
export function registerCLIHost(name: string, adapter: CLIHostAdapter): void {
  const existing = registry.get(name);
  if (existing && existing !== adapter) {
    throw new Error(
      `CLI host "${name}" is already registered with a different adapter. ` +
        `Each provider name must map to exactly one adapter.`
    );
  }
  registry.set(name, adapter);
}

export function getCLIHost(name: string): CLIHostAdapter | undefined {
  return registry.get(name);
}

export function isCLIHost(name: string): boolean {
  return registry.has(name);
}

/** Clears all registered CLI hosts. Mainly useful for testing. */
export function clearCLIHostRegistry(): void {
  registry.clear();
}
