import { describe, it, expect } from "vitest";
import { Interrupter } from "../../src/events/interrupter.js";

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
});
