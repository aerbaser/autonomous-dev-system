export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

export const DEFAULT_RETRY = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffFactor: 2,
} as const satisfies RetryOptions;

/**
 * Compute delay for a given retry attempt using exponential backoff + jitter.
 * attempt is 0-indexed (first retry = 0).
 */
export function calculateDelay(attempt: number, options: RetryOptions): number {
  const exponential = options.baseDelayMs * Math.pow(options.backoffFactor, attempt);
  const capped = Math.min(exponential, options.maxDelayMs);
  // Add random jitter: 0..50% of the computed delay
  const jitter = Math.random() * capped * 0.5;
  return Math.floor(capped + jitter);
}

/**
 * Classifies an error as retryable (transient) or fatal (permanent).
 * API failures, timeouts, and network issues are retryable.
 * Missing state, invalid config, and logic errors are fatal.
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return true; // unknown errors — try again

  const msg = error.message.toLowerCase();

  // Fatal: programming / configuration errors
  const fatalPatterns = [
    "missing state",
    "invalid phase",
    "spec and architecture required",
    "architecture and spec required",
    "no handler for phase",
    "invalid phase transition",
    "cannot read properties",
    "is not a function",
    "unexpected token",
    "syntax error",
  ];
  for (const pattern of fatalPatterns) {
    if (msg.includes(pattern)) return false;
  }

  // Retryable: transient / infrastructure errors
  const retryablePatterns = [
    "timeout",
    "econnreset",
    "econnrefused",
    "enotfound",
    "socket hang up",
    "network",
    "rate limit",
    "429",
    "500",
    "502",
    "503",
    "504",
    "api_retry",
    "overloaded",
    "internal server error",
    "service unavailable",
  ];
  for (const pattern of retryablePatterns) {
    if (msg.includes(pattern)) return true;
  }

  // Default: treat as retryable (safer for unknown errors)
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute fn with exponential backoff retries.
 * Non-retryable errors are thrown immediately without retry.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>,
  onRetry?: (attempt: number, error: Error, delayMs: number) => void
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_RETRY, ...options };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;

      // Don't retry fatal errors
      if (!isRetryableError(error)) {
        throw error;
      }

      // Don't retry if we've exhausted attempts
      if (attempt >= opts.maxRetries) {
        break;
      }

      const delayMs = calculateDelay(attempt, opts);
      onRetry?.(attempt + 1, error, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("withRetry exhausted all attempts");
}
