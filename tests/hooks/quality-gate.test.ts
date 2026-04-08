import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);

const { qualityGateHook } = await import("../../src/hooks/quality-gate.js");

const signal = new AbortController().signal;

function makeTaskCompletedInput() {
  return {
    hook_event_name: "TaskCompleted" as const,
    session_id: "test-session",
    transcript_path: "/tmp/test",
    cwd: "/tmp",
  };
}

describe("Quality Gate Hook", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  it("returns empty when lint passes", async () => {
    mockedExecFile.mockImplementation((_exe: string, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as (err: Error | null, stdout: string, stderr: string) => void)(null, "ok", "");
      return undefined as never;
    });

    const result = await qualityGateHook(makeTaskCompletedInput(), undefined, { signal });
    expect(result).toEqual({});
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
  });

  it("returns systemMessage when lint fails", async () => {
    const error = new Error("lint failed") as Error & { stdout: Buffer };
    error.stdout = Buffer.from("src/index.ts: error");
    mockedExecFile.mockImplementation((_exe: string, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as (err: Error | null, stdout: string, stderr: string) => void)(error, "", "");
      return undefined as never;
    });

    const result = await qualityGateHook(makeTaskCompletedInput(), undefined, { signal });
    expect(result.systemMessage).toBeDefined();
    expect(result.systemMessage).toContain("Lint check failed");
  });

  it("ignores non-TaskCompleted events", async () => {
    const result = await qualityGateHook(
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
      { signal }
    );
    expect(result).toEqual({});
    expect(mockedExecFile).not.toHaveBeenCalled();
  });
});
