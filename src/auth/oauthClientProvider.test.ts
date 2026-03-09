import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs/promises before importing the module under test
const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  mkdir: mocks.mkdir,
}));

import { PlaywrightOAuthClientProvider } from './oauthClientProvider.js';

describe('PlaywrightOAuthClientProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('tokens', () => {
    it('returns undefined when no state file exists', async () => {
      mocks.readFile.mockRejectedValueOnce(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      const provider = new PlaywrightOAuthClientProvider({
        storagePath: '/tmp/test-auth/oauth-state.json',
        redirectUri: 'http://localhost:3000/callback',
      });

      const result = await provider.tokens();
      expect(result).toBeUndefined();
    });

    it('returns stored tokens without expiry', async () => {
      mocks.readFile.mockResolvedValueOnce(
        JSON.stringify({
          tokens: {
            accessToken: 'my-access-token',
            tokenType: 'Bearer',
            refreshToken: 'my-refresh-token',
          },
        })
      );

      const provider = new PlaywrightOAuthClientProvider({
        storagePath: '/tmp/test-auth/oauth-state.json',
        redirectUri: 'http://localhost:3000/callback',
      });

      const result = await provider.tokens();
      expect(result).toMatchObject({
        access_token: 'my-access-token',
        token_type: 'Bearer',
        refresh_token: 'my-refresh-token',
      });
      expect(result?.expires_in).toBeUndefined();
    });

    it('computes expires_in from stored expiresAt', async () => {
      const expiresAt = Date.now() + 3600_000; // 1 hour from now
      mocks.readFile.mockResolvedValueOnce(
        JSON.stringify({
          tokens: {
            accessToken: 'my-access-token',
            tokenType: 'Bearer',
            expiresAt,
          },
        })
      );

      const provider = new PlaywrightOAuthClientProvider({
        storagePath: '/tmp/test-auth/oauth-state.json',
        redirectUri: 'http://localhost:3000/callback',
      });

      const result = await provider.tokens();
      expect(result?.expires_in).toBeGreaterThan(3590);
      expect(result?.expires_in).toBeLessThanOrEqual(3600);
    });
  });

  describe('codeVerifier round-trip', () => {
    it('saves and retrieves a code verifier', async () => {
      const verifier = 'pkce-code-verifier-abc123';

      // saveCodeVerifier reads state first, then writes
      mocks.readFile.mockRejectedValueOnce(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      const provider = new PlaywrightOAuthClientProvider({
        storagePath: '/tmp/test-auth/oauth-state.json',
        redirectUri: 'http://localhost:3000/callback',
      });

      await provider.saveCodeVerifier(verifier);

      expect(mocks.writeFile).toHaveBeenCalledOnce();
      const written = JSON.parse(
        mocks.writeFile.mock.calls[0]![1] as string
      ) as Record<string, unknown>;
      expect(written).toHaveProperty('codeVerifier', verifier);
    });

    it('throws when no code verifier is stored', async () => {
      mocks.readFile.mockRejectedValueOnce(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      const provider = new PlaywrightOAuthClientProvider({
        storagePath: '/tmp/test-auth/oauth-state.json',
        redirectUri: 'http://localhost:3000/callback',
      });

      await expect(provider.codeVerifier()).rejects.toThrow(
        'No code verifier found'
      );
    });
  });

  describe('saveTokens', () => {
    it('clears codeVerifier after successful token exchange', async () => {
      const storedState = {
        codeVerifier: 'pkce-code-verifier-value',
        savedAt: Date.now(),
      };
      // Return a state with codeVerifier pre-populated (simulates state after saveCodeVerifier)
      mocks.readFile.mockResolvedValueOnce(JSON.stringify(storedState));

      const provider = new PlaywrightOAuthClientProvider({
        storagePath: '/tmp/test-auth/oauth-state.json',
        redirectUri: 'http://localhost:3000/callback',
      });

      await provider.saveTokens({
        access_token: 'test-access-token',
        token_type: 'Bearer',
      });

      // The written state must NOT contain codeVerifier
      expect(mocks.writeFile).toHaveBeenCalledOnce();
      const writtenContent = JSON.parse(
        mocks.writeFile.mock.calls[0]![1] as string
      ) as Record<string, unknown>;
      expect(writtenContent).not.toHaveProperty('codeVerifier');
      expect(writtenContent).toHaveProperty('tokens');
    });
  });
});
