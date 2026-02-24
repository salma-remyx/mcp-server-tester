import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createTokenAuthHeaders,
  validateAccessToken,
  isTokenExpired,
  isTokenExpiringSoon,
} from './tokenAuth.js';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString(
    'base64url'
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

describe('tokenAuth', () => {
  describe('createTokenAuthHeaders', () => {
    it('returns Bearer authorization header by default', () => {
      const headers = createTokenAuthHeaders('my-token');
      expect(headers).toEqual({ Authorization: 'Bearer my-token' });
    });

    it('returns Basic authorization header when tokenType is Basic', () => {
      const headers = createTokenAuthHeaders('my-token', 'Basic');
      expect(headers).toEqual({ Authorization: 'Basic my-token' });
    });

    it('includes the full token string in the header value', () => {
      const longToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.sig';
      const headers = createTokenAuthHeaders(longToken);
      expect(headers.Authorization).toBe(`Bearer ${longToken}`);
    });
  });

  describe('validateAccessToken', () => {
    it('does not throw for a valid token string', () => {
      expect(() => validateAccessToken('valid-token')).not.toThrow();
    });

    it('throws when undefined is passed', () => {
      expect(() => validateAccessToken(undefined)).toThrow(
        'Access token is required but was not provided'
      );
    });

    it('throws when empty string is passed', () => {
      expect(() => validateAccessToken('')).toThrow(
        'Access token is required but was not provided'
      );
    });

    it('throws when whitespace-only string is passed', () => {
      expect(() => validateAccessToken('   ')).toThrow(
        'Access token cannot be empty'
      );
    });
  });

  describe('isTokenExpired', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns false for a non-JWT string with no dots', () => {
      expect(isTokenExpired('opaque-token-no-dots')).toBe(false);
    });

    it('returns false for a malformed JWT with wrong number of parts', () => {
      expect(isTokenExpired('header.payload')).toBe(false);
      expect(isTokenExpired('one.two.three.four')).toBe(false);
    });

    it('returns false for a JWT with no exp claim', () => {
      const token = makeJwt({ sub: 'user123', iat: 1700000000 });
      expect(isTokenExpired(token)).toBe(false);
    });

    it('returns true for a JWT where exp is in the past', () => {
      const now = 1700000000000; // milliseconds
      vi.setSystemTime(now);

      // exp is in seconds, set it 1 second in the past
      const expiredToken = makeJwt({ sub: 'user123', exp: now / 1000 - 1 });
      expect(isTokenExpired(expiredToken)).toBe(true);
    });

    it('returns false for a JWT where exp is in the future', () => {
      const now = 1700000000000; // milliseconds
      vi.setSystemTime(now);

      // exp is in seconds, set it 1 hour in the future
      const validToken = makeJwt({
        sub: 'user123',
        exp: now / 1000 + 3600,
      });
      expect(isTokenExpired(validToken)).toBe(false);
    });

    it('returns false when JSON parsing fails due to corrupt base64', () => {
      // Build a token with a non-JSON payload segment
      const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString(
        'base64url'
      );
      // Use raw bytes that won't decode to valid JSON
      const corruptPayload = '!!!not-valid-base64!!!';
      const token = `${header}.${corruptPayload}.fakesig`;
      expect(isTokenExpired(token)).toBe(false);
    });
  });

  describe('isTokenExpiringSoon', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns false when expiresAt is undefined', () => {
      expect(isTokenExpiringSoon(undefined)).toBe(false);
    });

    it('returns true when token expires within the default buffer of 60s', () => {
      const now = 1700000000000;
      vi.setSystemTime(now);

      // Token expires in 30 seconds — within the 60s default buffer
      const expiresAt = now + 30000;
      expect(isTokenExpiringSoon(expiresAt)).toBe(true);
    });

    it('returns false when token has more than 60s remaining', () => {
      const now = 1700000000000;
      vi.setSystemTime(now);

      // Token expires in 2 minutes — outside the 60s default buffer
      const expiresAt = now + 120000;
      expect(isTokenExpiringSoon(expiresAt)).toBe(false);
    });

    it('respects a custom bufferMs parameter', () => {
      const now = 1700000000000;
      vi.setSystemTime(now);

      // Token expires in 45 seconds
      const expiresAt = now + 45000;

      // With a 30s buffer: 45s remaining > 30s buffer → not expiring soon
      expect(isTokenExpiringSoon(expiresAt, 30000)).toBe(false);

      // With a 60s buffer: 45s remaining < 60s buffer → expiring soon
      expect(isTokenExpiringSoon(expiresAt, 60000)).toBe(true);
    });
  });
});
