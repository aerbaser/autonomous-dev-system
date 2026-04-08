import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * TaskCompleted hook: runs lint as a lightweight quality gate.
 * Full tsc + test checks are handled by runQualityChecks() in development-runner.
 */
export const qualityGateHook: HookCallback = async (input, _toolUseID, _ctx) => {
  if (input.hook_event_name !== "TaskCompleted") return {};

  try {
    await execFileAsync("npm", ["run", "lint"], { timeout: 60_000 });
  } catch (err) {
    const output = err instanceof Error && "stdout" in err ? String((err as { stdout: Buffer }).stdout) : String(err);
    return {
      systemMessage: `Lint check failed:\n${output.slice(0, 500)}`,
    };
  }

  return {};
};
