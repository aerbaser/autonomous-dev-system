import { describe, it, expect, vi } from "vitest";
import {
  calculateDelay,
  isRetryableError,
  withRetry,
  DEFAULT_RETRY,
} from "../../src/utils/retry.js";

const INSTANT = { maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1 };

// ── calculateDelay ────────────────────────────────────────────────────────────

describe("calculateDelay", () => {
  it("returns at least baseDelayMs for attempt 0", () => {
    const delay = calculateDelay(0, DEFAULT_RETRY);
    expect(delay).toBeGreaterThanOrEqual(DEFAULT_RETRY.baseDelayMs);
  });

  it("grows with each attempt (exponential)", () => {
    const opts = { ...DEFAULT_RETRY, backoffFactor: 2, baseDelayMs: 100, maxDelayMs: 10_000 };
    const d0 = calculateDelay(0, opts);
    const d1 = calculateDelay(1, opts);
    expect(d1).toBeGreaterThanOrEqual(d0);
  });

  it("caps at maxDelayMs (before jitter)", () => {
    const opts = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 1000, backoffFactor: 10 };
    const delay = calculateDelay(5, opts);
    expect(delay).toBeLessThanOrEqual(1500); // max + 50% jitter
  });

  it("includes random jitter", () => {
    const opts = { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 10_000, backoffFactor: 2 };
    const samples = Array.from({ length: 20 }, () => calculateDelay(0, opts));
    const allSame = samples.every((v) => v === samples[0]);
    expect(allSame).toBe(false);
  });
});

// ── isRetryableError ──────────────────────────────────────────────────────────

describe("isRetryableError", () => {
  it("returns true for non-Error values", () => {
    expect(isRetryableError("some string")).toBe(true);
    expect(isRetryableError(42)).toBe(true);
    expect(isRetryableError(null)).toBe(true);
  });

  it("marks fatal programming errors as non-retryable", () => {
    expect(isRetryableError(new Error("Spec and architecture required"))).toBe(false);
    expect(isRetryableError(new Error("Missing state: no spec"))).toBe(false);
    expect(isRetryableError(new Error("Invalid phase transition"))).toBe(false);
    expect(isRetryableError(new Error("SyntaxError: unexpected token"))).toBe(false);
    expect(isRetryableError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isRetryableError(new Error("foo is not a function"))).toBe(false);
  });

  it("marks transient errors as retryable", () => {
    expect(isRetryableError(new Error("Request timeout"))).toBe(true);
    expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true);
    expect(isRetryableError(new Error("Socket hang up"))).toBe(true);
    expect(isRetryableError(new Error("Rate limit exceeded"))).toBe(true);
    expect(isRetryableError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isRetryableError(new Error("Service unavailable 503"))).toBe(true);
    expect(isRetryableError(new Error("Internal server error 500"))).toBe(true);
    expect(isRetryableError(new Error("api_retry required"))).toBe(true);
    expect(isRetryableError(new Error("Model overloaded"))).toBe(true);
  });

  it("defaults to retryable for unknown error messages", () => {
    expect(isRetryableError(new Error("something totally unexpected"))).toBe(true);
  });
});

// ── withRetry ─────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  it("returns value on first success", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRetry(fn, INSTANT);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries and succeeds on second attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, INSTANT);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on non-retryable error (no retries)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Spec and architecture required"));
    await expect(withRetry(fn, INSTANT)).rejects.toThrow("Spec and architecture required");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("exhausts retries and throws last error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("timeout"));
    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1 })
    ).rejects.toThrow("timeout");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("calls onRetry callback with attempt info", async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue("done");

    await withRetry(fn, INSTANT, onRetry);

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), expect.any(Number));
  });

  it("uses DEFAULT_RETRY options when none provided", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const result = await withRetry(fn);
    expect(result).toBe("success");
  });
});
