import { execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const ALLOWED_EXECUTABLES = new Set([
  'npm', 'npx', 'tsc', 'vitest', 'node', 'git',
]);

export interface SandboxOptions {
  timeoutMs: number;
  memoryLimitMb?: number;
  cwd?: string;
  env?: Record<string, string>;
}

const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL',
  'NODE_ENV', 'NODE_PATH', 'NPM_CONFIG_PREFIX',
  'TMPDIR', 'TMP', 'TEMP',
] as const;

function getSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  return env;
}

export interface SandboxResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number | null;
  durationMs: number;
}

/**
 * Run a shell command in sandbox (for deterministic benchmarks like `npm run build`).
 * Uses execFile with timeout and resource limits.
 */
export async function runCommandInSandbox(
  command: string,
  options: SandboxOptions
): Promise<SandboxResult> {
  const startTime = Date.now();
  const memoryMb = options.memoryLimitMb ?? 512;

  // Parse command into executable + args, respecting quoted strings
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (const ch of command) {
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; } else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (/\s/.test(ch)) {
      if (current) { args.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  const executable = args.shift() ?? command;

  // Reject executables not in the allowlist — prevents LLM-controlled benchmark commands from escaping
  if (!ALLOWED_EXECUTABLES.has(executable)) {
    return Promise.resolve({
      success: false,
      output: "",
      error: `Blocked: '${executable}' is not an allowed executable. Allowed: ${[...ALLOWED_EXECUTABLES].join(', ')}`,
      exitCode: 1,
      durationMs: 0,
    });
  }

  return new Promise<SandboxResult>((res) => {
    const child = execFile(
      executable,
      args,
      {
        cwd: options.cwd ?? process.cwd(),
        timeout: options.timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: {
          ...getSafeEnv(),
          ...options.env,
          NODE_OPTIONS: `--max-old-space-size=${memoryMb}`,
        },
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startTime;
        if (error) {
          res({
            success: false,
            output: stdout,
            error: stderr || error.message,
            exitCode: error.code != null ? (typeof error.code === "number" ? error.code : 1) : 1,
            durationMs,
          });
        } else {
          res({
            success: true,
            output: stdout,
            ...(stderr ? { error: stderr } : {}),
            exitCode: 0,
            durationMs,
          });
        }
      }
    );

  });
}

// ── Worktree-based isolation ──

export interface WorktreeSandboxOptions extends SandboxOptions {
  repoDir: string;
}

/**
 * Execute a task function inside an isolated git worktree.
 * Creates a detached worktree, runs taskFn with the worktree path,
 * and always cleans up afterwards.
 */
export async function runInWorktreeSandbox(
  taskFn: (worktreeDir: string, signal: AbortSignal) => Promise<SandboxResult>,
  options: WorktreeSandboxOptions
): Promise<SandboxResult> {
  const startTime = Date.now();
  const worktreeDir = join(
    tmpdir(),
    `worktree-sandbox-${randomUUID().slice(0, 8)}`
  );

  // Create isolated worktree
  try {
    await execGit(["worktree", "add", worktreeDir, "--detach"], options.repoDir);
  } catch (err) {
    return {
      success: false,
      output: "",
      error: `Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: null,
      durationMs: Date.now() - startTime,
    };
  }

  try {
    // Run task with timeout
    const result = await withTimeout(
      taskFn,
      worktreeDir,
      options.timeoutMs,
      startTime
    );
    return result;
  } catch (err) {
    return {
      success: false,
      output: "",
      error: err instanceof Error ? err.message : String(err),
      exitCode: null,
      durationMs: Date.now() - startTime,
    };
  } finally {
    // Always clean up the worktree
    await removeWorktree(worktreeDir, options.repoDir);
  }
}

/**
 * Run a git command in the given repo directory.
 */
function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Remove a git worktree. Best-effort — logs but does not throw.
 */
async function removeWorktree(
  worktreeDir: string,
  repoDir: string
): Promise<void> {
  try {
    await execGit(["worktree", "remove", worktreeDir, "--force"], repoDir);
  } catch {
    // Best-effort cleanup — worktree may already be removed
  }
}

async function withTimeout(
  taskFn: (dir: string, signal: AbortSignal) => Promise<SandboxResult>,
  dir: string,
  timeoutMs: number,
  startTime: number
): Promise<SandboxResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await Promise.race([
      taskFn(dir, controller.signal),
      new Promise<SandboxResult>((_, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new Error(`Timeout after ${timeoutMs}ms`))
        );
      }),
    ]);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Timeout after")) {
      return {
        success: false,
        output: "",
        error: `Timeout after ${timeoutMs}ms`,
        exitCode: null,
        durationMs: Date.now() - startTime,
      };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
