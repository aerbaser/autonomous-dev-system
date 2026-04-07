import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "node:child_process";

/**
 * TaskCompleted hook: ensures all quality checks pass before a task can close.
 * Returns systemMessage feedback if checks fail.
 */
export const qualityGateHook: HookCallback = async (input, _toolUseID, _ctx) => {
  if (input.hook_event_name !== "TaskCompleted") return {};

  const checks: Array<{ name: string; command: string; fatal: boolean }> = [
    { name: "TypeScript type-check", command: "npx tsc --noEmit 2>&1", fatal: true },
    { name: "Tests", command: "npm test 2>&1", fatal: true },
    { name: "Lint", command: "npm run lint 2>&1 || true", fatal: false },
  ];

  const failures: string[] = [];
  const warnings: string[] = [];

  for (const check of checks) {
    try {
      execSync(check.command, { timeout: 120_000, stdio: "pipe" });
    } catch (err) {
      const output = err instanceof Error && "stdout" in err
        ? String((err as NodeJS.ErrnoException & { stdout: Buffer }).stdout)
        : String(err);
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
