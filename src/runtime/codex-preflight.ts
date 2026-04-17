import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errMsg } from "../utils/shared.js";

const execFileAsync = promisify(execFile);

/**
 * Phase 2 (narrowed): preflight check for Codex-backed native team mode.
 *
 * The full Phase-2 spec calls for a native agent-team runtime where Codex runs
 * as a first-class team member. Claude Agent SDK exposes `query({ agents })` +
 * the `Agent` tool, and our `codex-proxy.ts` already returns a valid subagent
 * definition that shell-wraps `codex exec`. That's a legal team member in SDK
 * terms — so the remaining risk is that operators flip `codexSubagents.enabled`
 * on a host without a working Codex binary and silently fall back to the
 * expensive proxy prompt without Codex actually being invoked.
 *
 * This module refuses to proceed in that case. It:
 *   - runs `codex --version`
 *   - throws a deterministic error tagged `unsupported_team_runtime` on failure
 *   - lets callers record the failure in the run ledger before re-raising
 *
 * The caller is expected to invoke this once per run (orchestrator startup)
 * whenever `codexSubagents.enabled === true`.
 */
export const UNSUPPORTED_RUNTIME_PREFIX = "unsupported_team_runtime";

export interface CodexPreflightResult {
  ok: true;
  version: string;
}

export class UnsupportedTeamRuntimeError extends Error {
  readonly reasonCode = "unsupported_team_runtime" as const;
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(`${UNSUPPORTED_RUNTIME_PREFIX}: ${message}`);
    this.name = "UnsupportedTeamRuntimeError";
    if (cause !== undefined) this.cause = cause;
  }
}

export interface CodexPreflightOptions {
  /** Command to invoke (default `codex`). Tests override this. */
  command?: string;
  /** Timeout in ms for the `--version` probe. */
  timeoutMs?: number;
}

/**
 * Probe the Codex CLI. Throws `UnsupportedTeamRuntimeError` on any failure
 * (binary missing, non-zero exit, timeout, etc.). Returns the version string
 * on success so callers can log it.
 */
export async function runCodexPreflight(
  options: CodexPreflightOptions = {},
): Promise<CodexPreflightResult> {
  const command = options.command ?? "codex";
  const timeoutMs = options.timeoutMs ?? 10_000;

  try {
    const { stdout, stderr } = await execFileAsync(command, ["--version"], {
      timeout: timeoutMs,
    });
    const version = (stdout || stderr || "").trim();
    if (!version) {
      throw new UnsupportedTeamRuntimeError(
        `'${command} --version' returned empty output`,
      );
    }
    return { ok: true, version };
  } catch (err) {
    if (err instanceof UnsupportedTeamRuntimeError) throw err;
    throw new UnsupportedTeamRuntimeError(
      `'${command} --version' failed: ${errMsg(err)}`,
      err,
    );
  }
}

/**
 * Phase 10: the CLI `nightly` / `optimize` subcommands set this env flag so the
 * orchestrator knows a live run is not active, and self-improvement paths are
 * allowed to mutate prompts. Any other process is treated as a live run.
 */
export const NIGHTLY_ENV_FLAG = "AUTONOMOUS_NIGHTLY";

export function isNightlyRun(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[NIGHTLY_ENV_FLAG] === "1";
}
