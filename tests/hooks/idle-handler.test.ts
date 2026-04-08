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
  it("suggests action when agent is idle", async () => {
    const result = await idleHandlerHook(
      makeIdleInput() as any,
      undefined,
      { signal },
    );
    expect(result.systemMessage).toBeDefined();
    expect(result.systemMessage).toContain("dev-agent");
    expect(result.systemMessage).toContain("idle");
  });

  it("includes agent name in message", async () => {
    const result = await idleHandlerHook(
      makeIdleInput({ teammate_name: "reviewer-agent" }) as any,
      undefined,
      { signal },
    );
    expect(result.systemMessage).toContain("reviewer-agent");
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
