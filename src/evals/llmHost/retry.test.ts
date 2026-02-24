import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, isRetryableError } from './retry.js';

// extractStatusCode is private (not exported), so we test it indirectly
// through isRetryableError's behavior.

// ---------------------------------------------------------------------------
// isRetryableError
// ---------------------------------------------------------------------------

describe('isRetryableError', () => {
  describe('HTTP status codes via error.status', () => {
    it('returns true for 429 (rate limit)', () => {
      expect(isRetryableError({ status: 429 })).toBe(true);
    });

    it('returns true for 500 (internal server error)', () => {
      expect(isRetryableError({ status: 500 })).toBe(true);
    });

    it('returns true for 502 (bad gateway)', () => {
      expect(isRetryableError({ status: 502 })).toBe(true);
    });

    it('returns true for 503 (service unavailable)', () => {
      expect(isRetryableError({ status: 503 })).toBe(true);
    });

    it('returns true for 504 (gateway timeout)', () => {
      expect(isRetryableError({ status: 504 })).toBe(true);
    });

    it('returns false for 400 (bad request)', () => {
      expect(isRetryableError({ status: 400 })).toBe(false);
    });

    it('returns false for 401 (unauthorized)', () => {
      expect(isRetryableError({ status: 401 })).toBe(false);
    });

    it('returns false for 403 (forbidden)', () => {
      expect(isRetryableError({ status: 403 })).toBe(false);
    });

    it('returns false for 404 (not found)', () => {
      expect(isRetryableError({ status: 404 })).toBe(false);
    });
  });

  describe('HTTP status codes via error.statusCode', () => {
    it('returns true for 429 via statusCode', () => {
      expect(isRetryableError({ statusCode: 429 })).toBe(true);
    });

    it('returns true for 503 via statusCode', () => {
      expect(isRetryableError({ statusCode: 503 })).toBe(true);
    });

    it('returns false for 404 via statusCode', () => {
      expect(isRetryableError({ statusCode: 404 })).toBe(false);
    });
  });

  describe('HTTP status codes via error.response.status (Axios-style)', () => {
    it('returns true for 429 via response.status', () => {
      expect(isRetryableError({ response: { status: 429 } })).toBe(true);
    });

    it('returns true for 500 via response.status', () => {
      expect(isRetryableError({ response: { status: 500 } })).toBe(true);
    });

    it('returns false for 403 via response.status', () => {
      expect(isRetryableError({ response: { status: 403 } })).toBe(false);
    });
  });

  describe('network / message-based errors', () => {
    it('returns true for error message containing "rate limit"', () => {
      expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
    });

    it('returns true for error message containing "429"', () => {
      expect(isRetryableError(new Error('HTTP 429 error'))).toBe(true);
    });

    it('returns true for error message containing "too many requests"', () => {
      expect(isRetryableError(new Error('Too Many Requests'))).toBe(true);
    });

    it('returns true for error message containing "timeout"', () => {
      expect(isRetryableError(new Error('Connection timeout'))).toBe(true);
    });

    it('returns true for error message containing "temporarily unavailable"', () => {
      expect(
        isRetryableError(new Error('Service is temporarily unavailable'))
      ).toBe(true);
    });

    it('returns true for error message containing "service unavailable"', () => {
      expect(isRetryableError(new Error('Service unavailable'))).toBe(true);
    });

    it('returns true for error message containing "internal server error"', () => {
      expect(
        isRetryableError(new Error('Internal Server Error occurred'))
      ).toBe(true);
    });

    it('returns false for a plain error with no retryable message', () => {
      expect(isRetryableError(new Error('Invalid argument'))).toBe(false);
    });

    it('returns false for a string error with no retryable content', () => {
      expect(isRetryableError('bad request')).toBe(false);
    });

    it('returns false for null', () => {
      expect(isRetryableError(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isRetryableError(undefined)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper: runs the promise while simultaneously advancing fake timers.
  // This prevents unhandled rejection warnings by keeping a rejection handler
  // attached to the promise at all times.
  async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
    const [result] = await Promise.all([promise, vi.runAllTimersAsync()]);
    return result;
  }

  describe('success cases', () => {
    it('returns result immediately on first success', async () => {
      const fn = vi.fn().mockResolvedValue('ok');

      const result = await runWithTimers(withRetry(fn, { maxAttempts: 3 }));

      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('succeeds after one failure then success', async () => {
      const retryableError = { status: 500 };
      const fn = vi
        .fn()
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValue('recovered');

      const result = await runWithTimers(
        withRetry(fn, { maxAttempts: 3, baseDelayMs: 100 })
      );

      expect(result).toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('succeeds after multiple failures', async () => {
      const retryableError = { status: 503 };
      const fn = vi
        .fn()
        .mockRejectedValueOnce(retryableError)
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValue('finally');

      const result = await runWithTimers(
        withRetry(fn, { maxAttempts: 5, baseDelayMs: 100 })
      );

      expect(result).toBe('finally');
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('exhausted retries', () => {
    it('throws after maxAttempts when all fail', async () => {
      const retryableError = { status: 429, message: 'rate limited' };
      const fn = vi.fn().mockRejectedValue(retryableError);

      await expect(
        runWithTimers(withRetry(fn, { maxAttempts: 3, baseDelayMs: 100 }))
      ).rejects.toEqual(retryableError);

      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('calls fn exactly maxAttempts times before giving up', async () => {
      const fn = vi.fn().mockRejectedValue({ status: 500 });

      await expect(
        runWithTimers(withRetry(fn, { maxAttempts: 2, baseDelayMs: 50 }))
      ).rejects.toBeDefined();

      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('non-retryable errors', () => {
    it('throws immediately without retrying on non-retryable error', async () => {
      const clientError = { status: 400 };
      const fn = vi.fn().mockRejectedValue(clientError);

      await expect(
        runWithTimers(withRetry(fn, { maxAttempts: 5, baseDelayMs: 100 }))
      ).rejects.toEqual(clientError);

      // Should only have been called once — no retries for non-retryable errors
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws immediately for 401 without retrying', async () => {
      const fn = vi.fn().mockRejectedValue({ status: 401 });

      await expect(
        runWithTimers(withRetry(fn, { maxAttempts: 3, baseDelayMs: 100 }))
      ).rejects.toBeDefined();

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('uses custom isRetryable predicate to allow retrying normally non-retryable errors', async () => {
      const error = { status: 403 };
      const fn = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('forced retry succeeded');

      const result = await runWithTimers(
        withRetry(fn, {
          maxAttempts: 3,
          baseDelayMs: 50,
          isRetryable: () => true, // retry everything
        })
      );

      expect(result).toBe('forced retry succeeded');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('uses custom isRetryable predicate to block retrying normally retryable errors', async () => {
      const fn = vi.fn().mockRejectedValue({ status: 500 });

      await expect(
        runWithTimers(
          withRetry(fn, {
            maxAttempts: 3,
            baseDelayMs: 50,
            isRetryable: () => false, // never retry
          })
        )
      ).rejects.toBeDefined();

      // Never retried because custom predicate said no
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('onRetry callback', () => {
    it('calls onRetry with correct attempt number and error', async () => {
      const retryableError = { status: 503 };
      const fn = vi
        .fn()
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValue('ok');
      const onRetry = vi.fn();

      await runWithTimers(
        withRetry(fn, { maxAttempts: 3, baseDelayMs: 100, onRetry })
      );

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(
        retryableError,
        1, // attempt number of the failed call
        expect.any(Number) // delay
      );
    });

    it('calls onRetry for each retry with incrementing attempt numbers', async () => {
      const retryableError = { status: 500 };
      const fn = vi
        .fn()
        .mockRejectedValueOnce(retryableError)
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValue('done');
      const onRetry = vi.fn();

      await runWithTimers(
        withRetry(fn, { maxAttempts: 5, baseDelayMs: 50, onRetry })
      );

      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenNthCalledWith(
        1,
        retryableError,
        1,
        expect.any(Number)
      );
      expect(onRetry).toHaveBeenNthCalledWith(
        2,
        retryableError,
        2,
        expect.any(Number)
      );
    });

    it('does not call onRetry on the final failing attempt', async () => {
      const retryableError = { status: 429 };
      const fn = vi.fn().mockRejectedValue(retryableError);
      const onRetry = vi.fn();

      await expect(
        runWithTimers(
          withRetry(fn, { maxAttempts: 2, baseDelayMs: 50, onRetry })
        )
      ).rejects.toBeDefined();

      // maxAttempts=2: attempt 1 fails → onRetry called (delay) → attempt 2 fails → throw (no more retries)
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('does not call onRetry when fn succeeds on first attempt', async () => {
      const fn = vi.fn().mockResolvedValue('instant success');
      const onRetry = vi.fn();

      await runWithTimers(withRetry(fn, { maxAttempts: 3, onRetry }));

      expect(onRetry).not.toHaveBeenCalled();
    });
  });

  describe('delay / backoff behavior', () => {
    it('waits before retrying (timer is set)', async () => {
      const retryableError = { status: 503 };
      const fn = vi
        .fn()
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValue('ok');

      const result = await runWithTimers(
        withRetry(fn, { maxAttempts: 3, baseDelayMs: 1000 })
      );

      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('applies exponential backoff: delay grows with each retry', async () => {
      const retryableError = { status: 500 };
      const onRetry = vi.fn();
      const fn = vi
        .fn()
        .mockRejectedValueOnce(retryableError)
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValue('ok');

      await runWithTimers(
        withRetry(fn, {
          maxAttempts: 5,
          baseDelayMs: 1000,
          maxDelayMs: 60000,
          onRetry,
        })
      );

      expect(onRetry).toHaveBeenCalledTimes(2);

      const [, , firstDelay] = onRetry.mock.calls[0] as [
        unknown,
        number,
        number,
      ];
      const [, , secondDelay] = onRetry.mock.calls[1] as [
        unknown,
        number,
        number,
      ];

      // Second delay should be larger than first (exponential growth)
      expect(secondDelay).toBeGreaterThan(firstDelay);
    });

    it('respects maxDelayMs cap', async () => {
      const retryableError = { status: 503 };
      const onRetry = vi.fn();
      const fn = vi
        .fn()
        .mockRejectedValueOnce(retryableError)
        .mockRejectedValueOnce(retryableError)
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValue('ok');

      await runWithTimers(
        withRetry(fn, {
          maxAttempts: 5,
          baseDelayMs: 10000,
          maxDelayMs: 15000, // low cap so exponential growth hits it quickly
          onRetry,
        })
      );

      for (const call of onRetry.mock.calls) {
        const delay = call[2] as number;
        expect(delay).toBeLessThanOrEqual(15000);
      }
    });
  });

  describe('edge cases', () => {
    it('works with maxAttempts=1 (no retries at all)', async () => {
      const fn = vi.fn().mockRejectedValue({ status: 429 });

      await expect(
        runWithTimers(withRetry(fn, { maxAttempts: 1 }))
      ).rejects.toBeDefined();

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('returns the resolved value from the async function', async () => {
      const fn = vi.fn().mockResolvedValue({ data: [1, 2, 3] });

      const result = await runWithTimers(withRetry(fn));

      expect(result).toEqual({ data: [1, 2, 3] });
    });

    it('uses default options when none are provided', async () => {
      const fn = vi.fn().mockResolvedValue('default');

      const result = await runWithTimers(withRetry(fn));

      expect(result).toBe('default');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
