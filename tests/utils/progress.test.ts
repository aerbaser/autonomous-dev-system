import { describe, it, expect, beforeEach } from "vitest";
import { progress } from "../../src/utils/progress.js";
import type { ProgressEvents } from "../../src/utils/progress.js";
import type { Phase } from "../../src/state/project-state.js";

// Typed wrapper to satisfy ProgressEmitter.on's strict listener signature
function mockListener<T>(): { fn: (data: T) => void; calls: T[] } {
  const calls: T[] = [];
  return { fn: (data: T) => calls.push(data), calls };
}

describe("ProgressEmitter", () => {
  beforeEach(() => {
    progress.removeAllListeners();
  });

  it("emits and receives phase:start events", () => {
    const { fn, calls } = mockListener<ProgressEvents["phase:start"]>();
    progress.on("phase:start", fn);

    const data: ProgressEvents["phase:start"] = { phase: "ideation" as Phase, index: 0, total: 10 };
    progress.emit("phase:start", data);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(data);
  });

  it("emits and receives phase:end events", () => {
    const { fn, calls } = mockListener<ProgressEvents["phase:end"]>();
    progress.on("phase:end", fn);

    const data: ProgressEvents["phase:end"] = { phase: "development" as Phase, success: true, elapsed: 1234 };
    progress.emit("phase:end", data);

    expect(calls[0]).toEqual(data);
  });

  it("emits and receives batch:start events", () => {
    const { fn, calls } = mockListener<ProgressEvents["batch:start"]>();
    progress.on("batch:start", fn);

    progress.emit("batch:start", { index: 1, total: 3, taskCount: 4 });
    expect(calls[0]).toEqual({ index: 1, total: 3, taskCount: 4 });
  });

  it("emits and receives batch:end events", () => {
    const { fn, calls } = mockListener<ProgressEvents["batch:end"]>();
    progress.on("batch:end", fn);

    progress.emit("batch:end", { index: 0, success: true });
    expect(calls[0]).toEqual({ index: 0, success: true });
  });

  it("emits and receives shutdown events", () => {
    const { fn, calls } = mockListener<ProgressEvents["shutdown"]>();
    progress.on("shutdown", fn);

    progress.emit("shutdown", { phase: "development" as Phase });
    expect(calls[0]).toEqual({ phase: "development" });
  });

  it("supports multiple listeners for the same event", () => {
    const a = mockListener<ProgressEvents["phase:start"]>();
    const b = mockListener<ProgressEvents["phase:start"]>();
    progress.on("phase:start", a.fn);
    progress.on("phase:start", b.fn);

    progress.emit("phase:start", { phase: "testing" as Phase, index: 2, total: 5 });

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it("removes listeners with off()", () => {
    const { fn, calls } = mockListener<ProgressEvents["phase:start"]>();
    progress.on("phase:start", fn);
    progress.off("phase:start", fn);

    progress.emit("phase:start", { phase: "testing" as Phase, index: 0, total: 1 });

    expect(calls).toHaveLength(0);
  });

  it("removeAllListeners clears all listeners", () => {
    const a = mockListener<ProgressEvents["phase:start"]>();
    const b = mockListener<ProgressEvents["phase:end"]>();
    progress.on("phase:start", a.fn);
    progress.on("phase:end", b.fn);

    progress.removeAllListeners();

    progress.emit("phase:start", { phase: "ideation" as Phase, index: 0, total: 1 });
    progress.emit("phase:end", { phase: "ideation" as Phase, success: true, elapsed: 0 });

    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(0);
  });
});
