import { describe, it, expect, vi, beforeEach } from "vitest";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";

// Mock node:fs before importing the hook
vi.mock("node:fs", () => ({
  appendFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
}));

const mockedAppendFileSync = vi.mocked(appendFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

// Dynamic import after mock setup
const { improvementTrackerHook } = await import("../../src/hooks/improvement-tracker.js");

const signal = new AbortController().signal;

function makePreToolUseInput(toolName: string) {
  return {
    hook_event_name: "PreToolUse" as const,
    session_id: "test-session",
    transcript_path: "/tmp/test-transcript",
    cwd: "/tmp",
    tool_name: toolName,
    tool_input: {},
    tool_use_id: "test-tool-use-1",
  };
}

function makePostToolUseInput(toolName: string, toolUseId: string) {
  return {
    hook_event_name: "PostToolUse" as const,
    session_id: "test-session",
    transcript_path: "/tmp/test-transcript",
    cwd: "/tmp",
    tool_name: toolName,
    tool_input: {},
    tool_response: "",
    tool_use_id: toolUseId,
  };
}

function makePostToolUseFailureInput(toolName: string, toolUseId: string, error: string) {
  return {
    hook_event_name: "PostToolUseFailure" as const,
    session_id: "test-session",
    transcript_path: "/tmp/test-transcript",
    cwd: "/tmp",
    tool_name: toolName,
    tool_input: {},
    tool_response: "",
    tool_use_id: toolUseId,
    error,
  };
}

describe("Improvement Tracker Hook", () => {
  beforeEach(() => {
    mockedAppendFileSync.mockReset();
    mockedExistsSync.mockReset();
    mockedMkdirSync.mockReset();
    mockedExistsSync.mockReturnValue(true);
  });

  it("records successful tool usage on PostToolUse", async () => {
    const toolUseId = "track-success-1";

    // PreToolUse records start time
    await improvementTrackerHook(
      makePreToolUseInput("Bash"),
      toolUseId,
      { signal }
    );

    // PostToolUse writes the record
    const result = await improvementTrackerHook(
      makePostToolUseInput("Bash", toolUseId),
      toolUseId,
      { signal }
    );

    expect(result).toEqual({});
    expect(mockedAppendFileSync).toHaveBeenCalledOnce();

    const written = mockedAppendFileSync.mock.calls[0]![1] as string;
    const record = JSON.parse(written.trim());
    expect(record.toolName).toBe("Bash");
    expect(record.success).toBe(true);
    expect(record.durationMs).toBeTypeOf("number");
    expect(record.error).toBeUndefined();
    expect(record.timestamp).toBeDefined();
  });

  it("records failure on PostToolUseFailure", async () => {
    const toolUseId = "track-fail-1";

    await improvementTrackerHook(
      makePreToolUseInput("Write"),
      toolUseId,
      { signal }
    );

    const result = await improvementTrackerHook(
      makePostToolUseFailureInput("Write", toolUseId, "Permission denied") as any,
      toolUseId,
      { signal }
    );

    expect(result).toEqual({});
    expect(mockedAppendFileSync).toHaveBeenCalledOnce();

    const written = mockedAppendFileSync.mock.calls[0]![1] as string;
    const record = JSON.parse(written.trim());
    expect(record.toolName).toBe("Write");
    expect(record.success).toBe(false);
    expect(record.error).toBe("Permission denied");
  });

  it("ignores unrelated events", async () => {
    const result = await improvementTrackerHook(
      {
        hook_event_name: "Notification",
        session_id: "test",
        transcript_path: "/tmp/t",
        cwd: "/tmp",
        message: "hello",
      } as any,
      undefined,
      { signal }
    );

    expect(result).toEqual({});
    expect(mockedAppendFileSync).not.toHaveBeenCalled();
  });

  it("creates directory if it does not exist", async () => {
    mockedExistsSync.mockReturnValue(false);

    await improvementTrackerHook(
      makePostToolUseInput("Read", "create-dir-1"),
      "create-dir-1",
      { signal }
    );

    expect(mockedMkdirSync).toHaveBeenCalledOnce();
    expect(mockedMkdirSync.mock.calls[0]![1]).toEqual({ recursive: true });
  });
});
