import { describe, it, expect } from "vitest";
import { Interrupter } from "../../src/events/interrupter.js";
import { consumeQuery, QueryAbortedError } from "../../src/utils/sdk-helpers.js";

describe("Interrupter", () => {
  it("starts in non-interrupted state", () => {
    const int = new Interrupter();
    expect(int.isInterrupted()).toBe(false);
    expect(int.getReason()).toBeUndefined();
    expect(int.getRedirectPhase()).toBeUndefined();
  });

  it("interrupt sets interrupted state with reason", () => {
    const int = new Interrupter();
    int.interrupt("budget-exceeded");

    expect(int.isInterrupted()).toBe(true);
    expect(int.getReason()).toBe("budget-exceeded");
    expect(int.getRedirectPhase()).toBeUndefined();
  });

  it("interrupt with redirect phase", () => {
    const int = new Interrupter();
    int.interrupt("quality-fail", "testing");

    expect(int.isInterrupted()).toBe(true);
    expect(int.getReason()).toBe("quality-fail");
    expect(int.getRedirectPhase()).toBe("testing");
  });

  it("reset clears interrupted state", () => {
    const int = new Interrupter();
    int.interrupt("budget-exceeded");

    int.reset();

    expect(int.isInterrupted()).toBe(false);
    expect(int.getReason()).toBeUndefined();
    expect(int.getRedirectPhase()).toBeUndefined();
  });

  it("reset creates a new AbortController (signal is not aborted)", () => {
    const int = new Interrupter();
    int.interrupt("test");

    expect(int.signal.aborted).toBe(true);

    int.reset();
    expect(int.signal.aborted).toBe(false);
  });

  it("signal is aborted after interrupt", () => {
    const int = new Interrupter();
    const signal = int.signal;

    expect(signal.aborted).toBe(false);

    int.interrupt("stop");
    expect(signal.aborted).toBe(true);
  });

  it("abort signal reason matches interrupt reason", () => {
    const int = new Interrupter();
    int.interrupt("budget-exceeded");

    expect(int.signal.reason).toBe("budget-exceeded");
  });

  it("requestShutdown is shorthand for interrupt('user-shutdown')", () => {
    const int = new Interrupter();
    int.requestShutdown();

    expect(int.isInterrupted()).toBe(true);
    expect(int.getReason()).toBe("user-shutdown");
    expect(int.signal.aborted).toBe(true);
  });

  it("signal abort event fires on interrupt", () => {
    const int = new Interrupter();
    let aborted = false;

    int.signal.addEventListener("abort", () => {
      aborted = true;
    });

    int.interrupt("test");
    expect(aborted).toBe(true);
  });

  it("multiple interrupts keep first reason", () => {
    const int = new Interrupter();
    int.interrupt("first-reason");
    // AbortController.abort() is idempotent — second call is no-op
    int.interrupt("second-reason");

    // The reason property gets overwritten but signal keeps first
    expect(int.getReason()).toBe("second-reason");
    expect(int.signal.reason).toBe("first-reason");
  });

  it("signal aborts in-flight consumeQuery within 100ms", async () => {
    const int = new Interrupter();
    let interruptCalled = false;

    // Build an infinite stream that would never produce a result on its own.
    // It yields a harmless system message, then blocks indefinitely on next().
    const infiniteStream: any = {
      [Symbol.asyncIterator]() {
        let primed = false;
        return {
          async next() {
            if (!primed) {
              primed = true;
              return {
                value: {
                  type: "system",
                  subtype: "api_retry_started",
                  attempt: 1,
                  max_retries: 3,
                  retry_delay_ms: 1000,
                },
                done: false,
              };
            }
            // Wait on the abort signal — never completes unless aborted.
            await new Promise<void>((resolve) => {
              int.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            // After abort, end the stream cleanly so consumeQuery can throw
            // QueryAbortedError via its end-of-stream fallback path.
            return { value: undefined, done: true };
          },
        };
      },
      interrupt: async () => {
        interruptCalled = true;
      },
    };

    const consumer = consumeQuery(infiniteStream, { signal: int.signal });
    // Trigger interrupt shortly after the consumer starts iterating.
    setTimeout(() => int.interrupt("test-abort"), 10);

    const start = Date.now();
    await expect(consumer).rejects.toBeInstanceOf(QueryAbortedError);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(interruptCalled).toBe(true);
  });
});
