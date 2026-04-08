import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";

interface ExecError extends Error {
  stdout: Buffer;
}

function isExecError(err: unknown): err is ExecError {
  return err instanceof Error && "stdout" in err;
}

/**
 * TaskCompleted hook: ensures all quality checks pass before a task can close.
 * Returns systemMessage feedback if checks fail.
 */
export const qualityGateHook: HookCallback = async (input, _toolUseID, _ctx) => {
  if (input.hook_event_name !== "TaskCompleted") return {};

  const checks: Array<{ name: string; executable: string; args: string[]; fatal: boolean }> = [
    { name: "TypeScript type-check", executable: "npx", args: ["tsc", "--noEmit"], fatal: true },
    { name: "Tests", executable: "npm", args: ["test"], fatal: true },
    { name: "Lint", executable: "npm", args: ["run", "lint"], fatal: false },
  ];

  const failures: string[] = [];
  const warnings: string[] = [];

  for (const check of checks) {
    try {
      execFileSync(check.executable, check.args, { timeout: 120_000, stdio: "pipe" });
    } catch (err) {
      const output = isExecError(err) ? String(err.stdout) : String(err);
      if (check.fatal) {
        failures.push(`${check.name} failed:\n${output.slice(0, 500)}`);
      } else {
        warnings.push(`${check.name} warning:\n${output.slice(0, 500)}`);
      }
    }
  }

  if (failures.length > 0) {
    const warningSection = warnings.length > 0 ? `\n\nWarnings (non-blocking):\n${warnings.join("\n\n")}` : "";
    return {
      systemMessage: `Quality gate FAILED. Fix these issues before completing the task:\n\n${failures.join("\n\n")}${warningSection}`,
    };
  }

  return {};
};
