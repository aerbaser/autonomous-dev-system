import { describe, it, expect, vi } from "vitest";
import { EventBus, type EventRecord } from "../../src/events/event-bus.js";

describe("EventBus", () => {
  it("emits events with monotonic sequence numbers", () => {
    const bus = new EventBus();
    const r1 = bus.emit("orchestrator.phase.start", { phase: "ideation" });
    const r2 = bus.emit("orchestrator.phase.start", { phase: "testing" });

    expect(r1.seq).toBe(0);
    expect(r2.seq).toBe(1);
    expect(r1.type).toBe("orchestrator.phase.start");
    expect(r1.data.phase).toBe("ideation");
    expect(r1.timestamp).toBeTruthy();
  });

  it("notifies type-specific subscribers", () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on("agent.query.start", handler);
    bus.emit("agent.query.start", {
      phase: "development",
      agentName: "dev-agent",
      model: "claude-sonnet-4-6",
      promptLength: 100,
    });
    bus.emit("orchestrator.phase.start", { phase: "testing" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent.query.start",
        data: expect.objectContaining({ agentName: "dev-agent" }),
      }),
    );
  });

  it("notifies onAll subscribers for every event", () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.onAll(handler);
    bus.emit("agent.query.start", {
      phase: "development",
      agentName: "a",
      model: "m",
      promptLength: 0,
    });
    bus.emit("orchestrator.phase.start", { phase: "testing" });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe stops notifications", () => {
    const bus = new EventBus();
    const handler = vi.fn();

    const unsub = bus.on("session.state", handler);
    bus.emit("session.state", { phase: "ideation", state: "running" });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    bus.emit("session.state", { phase: "ideation", state: "idle" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe onAll stops notifications", () => {
    const bus = new EventBus();
    const handler = vi.fn();

    const unsub = bus.onAll(handler);
    bus.emit("orchestrator.phase.start", { phase: "ideation" });
    unsub();
    bus.emit("orchestrator.phase.start", { phase: "testing" });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("getEvents returns all buffered events", () => {
    const bus = new EventBus();
    bus.emit("orchestrator.phase.start", { phase: "ideation" });
    bus.emit("orchestrator.phase.end", { phase: "ideation", success: true, durationMs: 100 });

    const events = bus.getEvents();
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("orchestrator.phase.start");
    expect(events[1]!.type).toBe("orchestrator.phase.end");
  });

  it("getEvents filters by type", () => {
    const bus = new EventBus();
    bus.emit("orchestrator.phase.start", { phase: "ideation" });
    bus.emit("agent.query.start", {
      phase: "development",
      agentName: "a",
      model: "m",
      promptLength: 0,
    });
    bus.emit("orchestrator.phase.start", { phase: "testing" });

    const events = bus.getEvents({ type: "orchestrator.phase.start" });
    expect(events).toHaveLength(2);
  });

  it("getEvents filters by since timestamp", () => {
    const bus = new EventBus();
    bus.emit("orchestrator.phase.start", { phase: "ideation" });

    const cutoff = new Date().toISOString();

    // Small delay to ensure different timestamp
    bus.emit("orchestrator.phase.start", { phase: "testing" });

    const events = bus.getEvents({ since: cutoff });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("ring buffer evicts oldest events when full", () => {
    const bus = new EventBus(3);
    bus.emit("orchestrator.phase.start", { phase: "ideation" });
    bus.emit("orchestrator.phase.start", { phase: "specification" });
    bus.emit("orchestrator.phase.start", { phase: "architecture" });
    bus.emit("orchestrator.phase.start", { phase: "development" });

    const events = bus.getEvents();
    expect(events).toHaveLength(3);
    expect(events[0]!.data).toEqual({ phase: "specification" });
    expect(events[2]!.data).toEqual({ phase: "development" });
  });

  it("getEvents returns a copy of the buffer", () => {
    const bus = new EventBus();
    bus.emit("orchestrator.phase.start", { phase: "ideation" });

    const events1 = bus.getEvents();
    const events2 = bus.getEvents();
    expect(events1).not.toBe(events2);
    expect(events1).toEqual(events2);
  });

  it("clear resets all state", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on("orchestrator.phase.start", handler);
    bus.emit("orchestrator.phase.start", { phase: "ideation" });

    bus.clear();

    expect(bus.getEvents()).toHaveLength(0);
    expect(bus.getSequence()).toBe(0);

    // Handlers are cleared
    bus.emit("orchestrator.phase.start", { phase: "testing" });
    expect(handler).toHaveBeenCalledTimes(1); // Only the first call
  });

  it("multiple handlers for same event type", () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.on("orchestrator.phase.start", h1);
    bus.on("orchestrator.phase.start", h2);
    bus.emit("orchestrator.phase.start", { phase: "ideation" });

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("event records have ISO 8601 timestamps", () => {
    const bus = new EventBus();
    const record = bus.emit("orchestrator.phase.start", { phase: "ideation" });

    // ISO 8601 format check
    expect(new Date(record.timestamp).toISOString()).toBe(record.timestamp);
  });
});
