import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SandboxResult } from "../../src/self-improve/sandbox.js";

// Mock child_process before importing the module
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock node:fs so worktree tests don't touch disk
vi.mock("node:fs", () => ({
  mkdtempSync: vi.fn(() => "/tmp/worktree-sandbox-mock"),
  existsSync: vi.fn(() => true),
}));

import { execFile } from "node:child_process";
import {
  runCommandInSandbox,
  runInWorktreeSandbox,
} from "../../src/self-improve/sandbox.js";

const mockExecFile = vi.mocked(execFile);

describe("sandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("runCommandInSandbox", () => {
    it("still exports and is callable", () => {
      expect(typeof runCommandInSandbox).toBe("function");
    });
  });

  // ── runInWorktreeSandbox ──

  describe("runInWorktreeSandbox", () => {
    it("creates a worktree, runs taskFn, and cleans up", async () => {
      // Mock git commands: first call = worktree add, last call = worktree remove
      let callCount = 0;
      mockExecFile.mockImplementation(
        (cmd: any, args: any, opts: any, callback: any) => {
          callCount++;
          const cb = typeof opts === "function" ? opts : callback;
          // Succeed for both git worktree add and git worktree remove
          cb(null, "", "");
          return {} as any;
        }
      );

      const taskFn = vi.fn(async (worktreeDir: string): Promise<SandboxResult> => {
        expect(worktreeDir).toContain("worktree-sandbox-");
        return {
          success: true,
          output: "task completed",
          exitCode: 0,
          durationMs: 42,
        };
      });

      const result = await runInWorktreeSandbox(taskFn, {
        repoDir: "/repo",
        timeoutMs: 10_000,
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe("task completed");
      expect(taskFn).toHaveBeenCalledOnce();

      // Verify git was called for both add and remove
      expect(mockExecFile).toHaveBeenCalledTimes(2);

      // First call: worktree add
      const addCall = mockExecFile.mock.calls[0]!;
      expect(addCall[0]).toBe("git");
      expect(addCall[1]).toContain("add");
      expect(addCall[1]).toContain("--detach");

      // Second call: worktree remove
      const removeCall = mockExecFile.mock.calls[1]!;
      expect(removeCall[0]).toBe("git");
      expect(removeCall[1]).toContain("remove");
      expect(removeCall[1]).toContain("--force");
    });

    it("handles timeout by returning error result", async () => {
      // Git worktree add succeeds
      mockExecFile.mockImplementation(
        (cmd: any, args: any, opts: any, callback: any) => {
          const cb = typeof opts === "function" ? opts : callback;
          cb(null, "", "");
          return {} as any;
        }
      );

      // Task that never resolves
      const taskFn = vi.fn(
        () => new Promise<SandboxResult>(() => {/* never resolves */})
      );

      const resultPromise = runInWorktreeSandbox(taskFn, {
        repoDir: "/repo",
        timeoutMs: 500,
      });

      // Advance timer past the timeout
      await vi.advanceTimersByTimeAsync(600);

      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Timeout after 500ms");

      // Cleanup (worktree remove) should still be called
      const removeCalls = mockExecFile.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1].includes("remove")
      );
      expect(removeCalls.length).toBe(1);
    });

    it("handles taskFn error and still cleans up worktree", async () => {
      // Git commands succeed
      mockExecFile.mockImplementation(
        (cmd: any, args: any, opts: any, callback: any) => {
          const cb = typeof opts === "function" ? opts : callback;
          cb(null, "", "");
          return {} as any;
        }
      );

      const taskFn = vi.fn(async (): Promise<SandboxResult> => {
        throw new Error("task exploded");
      });

      const result = await runInWorktreeSandbox(taskFn, {
        repoDir: "/repo",
        timeoutMs: 10_000,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("task exploded");

      // Cleanup should still happen
      const removeCalls = mockExecFile.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1].includes("remove")
      );
      expect(removeCalls.length).toBe(1);
    });

    it("returns error if git worktree add fails", async () => {
      // Git worktree add fails
      mockExecFile.mockImplementation(
        (cmd: any, args: any, opts: any, callback: any) => {
          const cb = typeof opts === "function" ? opts : callback;
          cb(new Error("git failed"), "", "not a git repository");
          return {} as any;
        }
      );

      const taskFn = vi.fn(async (): Promise<SandboxResult> => ({
        success: true,
        output: "should not run",
        exitCode: 0,
        durationMs: 0,
      }));

      const result = await runInWorktreeSandbox(taskFn, {
        repoDir: "/not-a-repo",
        timeoutMs: 10_000,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to create worktree");
      // Task should never have been called
      expect(taskFn).not.toHaveBeenCalled();
    });

    it("handles worktree remove failure gracefully", async () => {
      let callCount = 0;
      mockExecFile.mockImplementation(
        (cmd: any, args: any, opts: any, callback: any) => {
          callCount++;
          const cb = typeof opts === "function" ? opts : callback;
          if (callCount === 1) {
            // worktree add succeeds
            cb(null, "", "");
          } else {
            // worktree remove fails
            cb(new Error("remove failed"), "", "");
          }
          return {} as any;
        }
      );

      const taskFn = vi.fn(async (): Promise<SandboxResult> => ({
        success: true,
        output: "done",
        exitCode: 0,
        durationMs: 10,
      }));

      // Should not throw even if cleanup fails
      const result = await runInWorktreeSandbox(taskFn, {
        repoDir: "/repo",
        timeoutMs: 10_000,
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe("done");
    });
  });
});
