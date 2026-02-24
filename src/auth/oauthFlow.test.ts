import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock references so they are accessible inside vi.mock factory
const oauthMocks = vi.hoisted(() => ({
  generateRandomCodeVerifier: vi.fn().mockReturnValue('test-verifier-abc123'),
  calculatePKCECodeChallenge: vi
    .fn()
    .mockResolvedValue('test-challenge-xyz789'),
  generateRandomState: vi.fn().mockReturnValue('test-state-123'),
  discoveryRequest: vi.fn(),
  processDiscoveryResponse: vi.fn(),
  validateAuthResponse: vi.fn(),
  authorizationCodeGrantRequest: vi.fn(),
  processAuthorizationCodeResponse: vi.fn(),
  refreshTokenGrantRequest: vi.fn(),
  processRefreshTokenResponse: vi.fn(),
  ClientSecretBasic: vi.fn().mockReturnValue('client-secret-auth'),
  None: vi.fn().mockReturnValue('none-auth'),
}));

vi.mock('oauth4webapi', () => ({
  generateRandomCodeVerifier: oauthMocks.generateRandomCodeVerifier,
  calculatePKCECodeChallenge: oauthMocks.calculatePKCECodeChallenge,
  generateRandomState: oauthMocks.generateRandomState,
  discoveryRequest: oauthMocks.discoveryRequest,
  processDiscoveryResponse: oauthMocks.processDiscoveryResponse,
  validateAuthResponse: oauthMocks.validateAuthResponse,
  authorizationCodeGrantRequest: oauthMocks.authorizationCodeGrantRequest,
  processAuthorizationCodeResponse: oauthMocks.processAuthorizationCodeResponse,
  refreshTokenGrantRequest: oauthMocks.refreshTokenGrantRequest,
  processRefreshTokenResponse: oauthMocks.processRefreshTokenResponse,
  ClientSecretBasic: oauthMocks.ClientSecretBasic,
  None: oauthMocks.None,
}));

import type * as oauth from 'oauth4webapi';
import {
  generatePKCE,
  generateState,
  buildAuthorizationUrl,
  validateCallback,
  exchangeCodeForTokens,
} from './oauthFlow.js';
import type { AuthServerMetadata } from './oauthFlow.js';

function mockAuthServer(
  overrides: Partial<oauth.AuthorizationServer> = {}
): AuthServerMetadata {
  return {
    issuer: 'https://auth.example.com',
    server: {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      ...overrides,
    } as oauth.AuthorizationServer,
  };
}

describe('oauthFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default return values after clearAllMocks resets them
    oauthMocks.generateRandomCodeVerifier.mockReturnValue(
      'test-verifier-abc123'
    );
    oauthMocks.calculatePKCECodeChallenge.mockResolvedValue(
      'test-challenge-xyz789'
    );
    oauthMocks.generateRandomState.mockReturnValue('test-state-123');
    oauthMocks.ClientSecretBasic.mockReturnValue('client-secret-auth');
    oauthMocks.None.mockReturnValue('none-auth');
  });

  describe('generatePKCE', () => {
    it('returns codeVerifier and codeChallenge with values from mocked oauth functions', async () => {
      const result = await generatePKCE();
      expect(result).toEqual({
        codeVerifier: 'test-verifier-abc123',
        codeChallenge: 'test-challenge-xyz789',
      });
    });

    it('calls generateRandomCodeVerifier exactly once', async () => {
      await generatePKCE();
      expect(oauthMocks.generateRandomCodeVerifier).toHaveBeenCalledTimes(1);
    });

    it('calls calculatePKCECodeChallenge with the code verifier', async () => {
      await generatePKCE();
      expect(oauthMocks.calculatePKCECodeChallenge).toHaveBeenCalledWith(
        'test-verifier-abc123'
      );
    });
  });

  describe('generateState', () => {
    it('returns the value from generateRandomState', () => {
      const state = generateState();
      expect(state).toBe('test-state-123');
    });
  });

  describe('buildAuthorizationUrl', () => {
    const baseConfig = {
      authServer: mockAuthServer(),
      clientId: 'my-client-id',
      redirectUri: 'https://app.example.com/callback',
      scopes: ['openid', 'profile', 'email'],
      codeChallenge: 'test-challenge-xyz789',
      state: 'test-state-123',
    };

    it('returns a URL with client_id param set correctly', () => {
      const url = buildAuthorizationUrl(baseConfig);
      expect(url.searchParams.get('client_id')).toBe('my-client-id');
    });

    it('returns a URL with redirect_uri param set correctly', () => {
      const url = buildAuthorizationUrl(baseConfig);
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://app.example.com/callback'
      );
    });

    it('returns a URL with response_type=code', () => {
      const url = buildAuthorizationUrl(baseConfig);
      expect(url.searchParams.get('response_type')).toBe('code');
    });

    it('returns a URL with scope as space-joined scopes array', () => {
      const url = buildAuthorizationUrl(baseConfig);
      expect(url.searchParams.get('scope')).toBe('openid profile email');
    });

    it('returns a URL with code_challenge set', () => {
      const url = buildAuthorizationUrl(baseConfig);
      expect(url.searchParams.get('code_challenge')).toBe(
        'test-challenge-xyz789'
      );
    });

    it('returns a URL with code_challenge_method=S256', () => {
      const url = buildAuthorizationUrl(baseConfig);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    });

    it('returns a URL with state param', () => {
      const url = buildAuthorizationUrl(baseConfig);
      expect(url.searchParams.get('state')).toBe('test-state-123');
    });

    it('includes resource param when provided in config', () => {
      const url = buildAuthorizationUrl({
        ...baseConfig,
        resource: 'https://api.example.com/mcp',
      });
      expect(url.searchParams.get('resource')).toBe(
        'https://api.example.com/mcp'
      );
    });

    it('omits resource param when not provided', () => {
      const url = buildAuthorizationUrl(baseConfig);
      expect(url.searchParams.has('resource')).toBe(false);
    });

    it('throws when authorization server has no authorization_endpoint', () => {
      const authServer = mockAuthServer({
        authorization_endpoint: undefined,
      });
      expect(() =>
        buildAuthorizationUrl({ ...baseConfig, authServer })
      ).toThrow('Authorization server does not have an authorization_endpoint');
    });
  });

  describe('validateCallback', () => {
    it('returns the authorization code when state matches and code is present', () => {
      const callbackUrl = new URL('https://app.example.com/callback');
      callbackUrl.searchParams.set('code', 'auth-code-abc');
      callbackUrl.searchParams.set('state', 'expected-state');

      const code = validateCallback(callbackUrl, 'expected-state');
      expect(code).toBe('auth-code-abc');
    });

    it('throws with OAuth error message when error param is present', () => {
      const callbackUrl = new URL('https://app.example.com/callback');
      callbackUrl.searchParams.set('error', 'access_denied');

      expect(() => validateCallback(callbackUrl, 'any-state')).toThrow(
        'OAuth error: access_denied'
      );
    });

    it('includes error_description in the message when present', () => {
      const callbackUrl = new URL('https://app.example.com/callback');
      callbackUrl.searchParams.set('error', 'access_denied');
      callbackUrl.searchParams.set(
        'error_description',
        'The user denied access'
      );

      expect(() => validateCallback(callbackUrl, 'any-state')).toThrow(
        'OAuth error: access_denied - The user denied access'
      );
    });

    it('throws state mismatch error when state does not match expectedState', () => {
      const callbackUrl = new URL('https://app.example.com/callback');
      callbackUrl.searchParams.set('code', 'auth-code-abc');
      callbackUrl.searchParams.set('state', 'wrong-state');

      expect(() => validateCallback(callbackUrl, 'expected-state')).toThrow(
        'state mismatch'
      );
    });

    it('throws when code is absent', () => {
      const callbackUrl = new URL('https://app.example.com/callback');
      callbackUrl.searchParams.set('state', 'expected-state');

      expect(() => validateCallback(callbackUrl, 'expected-state')).toThrow(
        'No authorization code'
      );
    });
  });

  describe('exchangeCodeForTokens', () => {
    const baseExchangeConfig = {
      authServer: mockAuthServer(),
      clientId: 'my-client-id',
      code: 'auth-code-abc',
      state: 'test-state-123',
      codeVerifier: 'test-verifier-abc123',
      redirectUri: 'https://app.example.com/callback',
    };

    const mockTokenResponse = {
      access_token: 'new-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'new-refresh-token',
      scope: 'openid profile',
    };

    beforeEach(() => {
      // validateAuthResponse returns URLSearchParams synchronously
      oauthMocks.validateAuthResponse.mockReturnValue(
        new URLSearchParams({ code: 'auth-code-abc', state: 'test-state-123' })
      );
      // authorizationCodeGrantRequest returns a Response-like object
      oauthMocks.authorizationCodeGrantRequest.mockResolvedValue(
        new Response()
      );
      // processAuthorizationCodeResponse returns the token payload
      oauthMocks.processAuthorizationCodeResponse.mockResolvedValue(
        mockTokenResponse
      );
    });

    it('returns token object with accessToken, tokenType, expiresIn, refreshToken, scope', async () => {
      const result = await exchangeCodeForTokens(baseExchangeConfig);

      expect(result).toEqual({
        accessToken: 'new-access-token',
        tokenType: 'Bearer',
        expiresIn: 3600,
        refreshToken: 'new-refresh-token',
        scope: 'openid profile',
      });
    });

    it('uses ClientSecretBasic auth when clientSecret is provided', async () => {
      await exchangeCodeForTokens({
        ...baseExchangeConfig,
        clientSecret: 'super-secret',
      });

      expect(oauthMocks.ClientSecretBasic).toHaveBeenCalledWith('super-secret');
      expect(oauthMocks.authorizationCodeGrantRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'client-secret-auth',
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
    });

    it('uses None auth when clientSecret is not provided', async () => {
      await exchangeCodeForTokens(baseExchangeConfig);

      expect(oauthMocks.None).toHaveBeenCalled();
      expect(oauthMocks.authorizationCodeGrantRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'none-auth',
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
    });
  });
});
