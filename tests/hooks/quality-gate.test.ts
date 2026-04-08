import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";

// Mock child_process before importing the hook
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

// Dynamic import after mock setup
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
    mockedExecFileSync.mockReset();
  });

  it("returns empty when all checks pass", async () => {
    mockedExecFileSync.mockReturnValue(Buffer.from("ok"));

    const result = await qualityGateHook(makeTaskCompletedInput(), undefined, { signal });
    expect(result).toEqual({});
    expect(mockedExecFileSync).toHaveBeenCalledTimes(3); // tsc + tests + lint
  });

  it("returns failure message when TypeScript check fails", async () => {
    const error = new Error("tsc failed") as Error & { stdout: Buffer };
    error.stdout = Buffer.from("error TS2345: Argument of type 'string' is not assignable");
    mockedExecFileSync.mockImplementation((executable: string, args?: readonly string[]) => {
      if (executable === "npx" && args?.includes("tsc")) throw error;
      return Buffer.from("ok");
    });

    const result = await qualityGateHook(makeTaskCompletedInput(), undefined, { signal });
    expect(result.systemMessage).toBeDefined();
    expect(result.systemMessage).toContain("Quality gate FAILED");
    expect(result.systemMessage).toContain("TypeScript type-check failed");
  });

  it("returns failure message when tests fail", async () => {
    const error = new Error("tests failed") as Error & { stdout: Buffer };
    error.stdout = Buffer.from("FAIL tests/my.test.ts");
    mockedExecFileSync.mockImplementation((executable: string, args?: readonly string[]) => {
      if (executable === "npm" && args?.includes("test")) throw error;
      return Buffer.from("ok");
    });

    const result = await qualityGateHook(makeTaskCompletedInput(), undefined, { signal });
    expect(result.systemMessage).toBeDefined();
    expect(result.systemMessage).toContain("Tests failed");
  });

  it("treats lint failure as non-blocking warning", async () => {
    // All checks pass
    mockedExecFileSync.mockReturnValue(Buffer.from("ok"));

    const result = await qualityGateHook(makeTaskCompletedInput(), undefined, { signal });
    expect(result).toEqual({});
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
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it("includes both fatal failures and non-fatal warnings", async () => {
    const tscError = new Error("tsc failed") as Error & { stdout: Buffer };
    tscError.stdout = Buffer.from("type error");
    const lintError = new Error("lint failed") as Error & { stdout: Buffer };
    lintError.stdout = Buffer.from("lint warning");

    mockedExecFileSync.mockImplementation((executable: string, args?: readonly string[]) => {
      if (executable === "npx" && args?.includes("tsc")) throw tscError;
      if (executable === "npm" && args?.includes("lint")) throw lintError;
      return Buffer.from("ok");
    });

    const result = await qualityGateHook(makeTaskCompletedInput(), undefined, { signal });
    expect(result.systemMessage).toContain("Quality gate FAILED");
    expect(result.systemMessage).toContain("TypeScript type-check failed");
    expect(result.systemMessage).toContain("Lint warning");
  });
});
