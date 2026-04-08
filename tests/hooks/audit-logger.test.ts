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
const { auditLoggerHook } = await import("../../src/hooks/audit-logger.js");

const signal = new AbortController().signal;

function makePostToolUseInput(toolName: string, toolInput: Record<string, unknown>) {
  return {
    hook_event_name: "PostToolUse" as const,
    session_id: "test-session",
    transcript_path: "/tmp/test-transcript",
    cwd: "/tmp",
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: "",
    tool_use_id: "test-tool-use-1",
  };
}

describe("Audit Logger Hook", () => {
  beforeEach(() => {
    mockedAppendFileSync.mockReset();
    mockedExistsSync.mockReset();
    mockedMkdirSync.mockReset();
    mockedExistsSync.mockReturnValue(true);
  });

  it("logs file operations to JSONL", async () => {
    const result = await auditLoggerHook(
      makePostToolUseInput("Write", { file_path: "/project/src/main.ts" }),
      undefined,
      { signal }
    );

    expect(result).toEqual({});
    expect(mockedAppendFileSync).toHaveBeenCalledOnce();

    const written = mockedAppendFileSync.mock.calls[0]![1] as string;
    const entry = JSON.parse(written.trim());
    expect(entry.toolName).toBe("Write");
    expect(entry.filePath).toBe("/project/src/main.ts");
    expect(entry.event).toBe("PostToolUse");
    expect(entry.timestamp).toBeDefined();
  });

  it("creates directory if it does not exist", async () => {
    mockedExistsSync.mockReturnValue(false);

    await auditLoggerHook(
      makePostToolUseInput("Edit", { file_path: "/project/src/utils.ts" }),
      undefined,
      { signal }
    );

    expect(mockedMkdirSync).toHaveBeenCalledOnce();
    expect(mockedMkdirSync.mock.calls[0]![1]).toEqual({ recursive: true });
  });

  it("ignores non-PostToolUse events", async () => {
    const result = await auditLoggerHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "test",
        transcript_path: "/tmp/t",
        cwd: "/tmp",
        tool_name: "Bash",
        tool_input: { file_path: "/some/file" },
        tool_use_id: "t1",
      } as any,
      undefined,
      { signal }
    );

    expect(result).toEqual({});
    expect(mockedAppendFileSync).not.toHaveBeenCalled();
  });

  it("skips logging when tool_input has no file_path", async () => {
    const result = await auditLoggerHook(
      makePostToolUseInput("Bash", { command: "ls -la" }),
      undefined,
      { signal }
    );

    expect(result).toEqual({});
    expect(mockedAppendFileSync).not.toHaveBeenCalled();
  });
});
