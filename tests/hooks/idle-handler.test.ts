import { describe, it, expect } from "vitest";
import { idleHandlerHook } from "../../src/hooks/idle-handler.js";

const signal = new AbortController().signal;

function makeIdleInput(overrides: Record<string, unknown> = {}) {
  return {
    hook_event_name: "TeammateIdle" as const,
    session_id: "test-session",
    transcript_path: "/tmp/test",
    cwd: "/tmp",
    teammate_name: "dev-agent",
    team_name: "backend",
    ...overrides,
  };
}

describe("Idle Handler Hook", () => {
  it("suggests shutdown when idle exceeds threshold and no tasks remain", async () => {
    const result = await idleHandlerHook(
      makeIdleInput({ idle_duration_ms: 600_000 }) as any,
      undefined,
      { signal },
    );
    expect(result.systemMessage).toBeDefined();
    expect(result.systemMessage).toContain("idle for 10m");
    expect(result.systemMessage).toContain("Recommend shutdown");
  });

  it("returns empty when idle is below threshold", async () => {
    const result = await idleHandlerHook(
      makeIdleInput({ idle_duration_ms: 60_000 }) as any,
      undefined,
      { signal },
    );
    expect(result).toEqual({});
  });

  it("suggests reassignment when tasks are available", async () => {
    const result = await idleHandlerHook(
      makeIdleInput({
        idle_duration_ms: 400_000,
        pending_tasks: [{ id: "task-1", title: "Fix login bug" }],
        idle_threshold_ms: 300_000,
      }) as any,
      undefined,
      { signal },
    );
    expect(result.systemMessage).toBeDefined();
    expect(result.systemMessage).toContain("Reassign to pending task");
    expect(result.systemMessage).toContain("Fix login bug");
  });

  it("respects custom idle threshold", async () => {
    const result = await idleHandlerHook(
      makeIdleInput({
        idle_duration_ms: 120_000,
        idle_threshold_ms: 60_000,
      }) as any,
      undefined,
      { signal },
    );
    expect(result.systemMessage).toBeDefined();
    expect(result.systemMessage).toContain("idle for 2m");
    expect(result.systemMessage).toContain("Recommend shutdown");
  });

  it("ignores non-TeammateIdle events", async () => {
    const result = await idleHandlerHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "test",
        transcript_path: "/tmp/t",
        cwd: "/tmp",
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "t1",
      } as any,
      undefined,
      { signal },
    );
    expect(result).toEqual({});
  });
});
