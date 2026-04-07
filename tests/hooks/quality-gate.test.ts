import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";

// Mock child_process before importing the hook
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);

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
    mockedExecSync.mockReset();
  });

  it("returns empty when all checks pass", async () => {
    mockedExecSync.mockReturnValue(Buffer.from("ok"));

    const result = await qualityGateHook(makeTaskCompletedInput(), undefined, { signal });
    expect(result).toEqual({});
    expect(mockedExecSync).toHaveBeenCalledTimes(3); // tsc + tests + lint
  });

  it("returns failure message when TypeScript check fails", async () => {
    const error = new Error("tsc failed") as Error & { stdout: Buffer };
    error.stdout = Buffer.from("error TS2345: Argument of type 'string' is not assignable");
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("tsc")) throw error;
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
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("npm test")) throw error;
      return Buffer.from("ok");
    });

    const result = await qualityGateHook(makeTaskCompletedInput(), undefined, { signal });
    expect(result.systemMessage).toBeDefined();
    expect(result.systemMessage).toContain("Tests failed");
  });

  it("treats lint failure as non-blocking warning", async () => {
    // All checks pass (lint uses || true, so it returns success even on lint errors)
    mockedExecSync.mockReturnValue(Buffer.from("ok"));

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
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("includes both fatal failures and non-fatal warnings", async () => {
    const tscError = new Error("tsc failed") as Error & { stdout: Buffer };
    tscError.stdout = Buffer.from("type error");
    const lintError = new Error("lint failed") as Error & { stdout: Buffer };
    lintError.stdout = Buffer.from("lint warning");

    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("tsc")) throw tscError;
      if (typeof cmd === "string" && cmd.includes("lint")) throw lintError;
      return Buffer.from("ok");
    });

    const result = await qualityGateHook(makeTaskCompletedInput(), undefined, { signal });
    expect(result.systemMessage).toContain("Quality gate FAILED");
    expect(result.systemMessage).toContain("TypeScript type-check failed");
    expect(result.systemMessage).toContain("Lint warning");
  });
});
