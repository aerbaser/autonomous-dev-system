import { fork, execFile, type ChildProcess } from "node:child_process";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

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
 * Run a benchmark task in an isolated subprocess.
 * Uses Node.js fork() with resource limits.
 */
export async function runInSandbox(
  scriptPath: string,
  args: string[],
  options: SandboxOptions
): Promise<SandboxResult> {
  const startTime = Date.now();
  const memoryMb = options.memoryLimitMb ?? 512;
  const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB, same as runCommandInSandbox maxBuffer

  return new Promise<SandboxResult>((res) => {
    const child: ChildProcess = fork(resolve(scriptPath), args, {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...getSafeEnv(),
        ...options.env,
        NODE_OPTIONS: `--max-old-space-size=${memoryMb}`,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      silent: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (result: SandboxResult) => {
      if (settled) return;
      settled = true;
      res(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk.toString();
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += chunk.toString();
      }
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({
        success: false,
        output: stdout,
        error: `Timeout after ${options.timeoutMs}ms`,
        exitCode: null,
        durationMs: Date.now() - startTime,
      });
    }, options.timeoutMs);

    child.on("exit", (code) => {
      clearTimeout(timer);
      settle({
        success: code === 0,
        output: stdout,
        ...(stderr ? { error: stderr } : {}),
        exitCode: code,
        durationMs: Date.now() - startTime,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      settle({
        success: false,
        output: stdout,
        error: err.message,
        exitCode: null,
        durationMs: Date.now() - startTime,
      });
    });
  });
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
  taskFn: (worktreeDir: string) => Promise<SandboxResult>,
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

/**
 * Run a task function with a timeout. Uses Promise.race so the timeout
 * resolves immediately; a `timedOut` flag signals the task to stop.
 */
async function withTimeout(
  taskFn: (dir: string) => Promise<SandboxResult>,
  dir: string,
  timeoutMs: number,
  startTime: number
): Promise<SandboxResult> {
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; }, timeoutMs);

  try {
    const result = await Promise.race([
      taskFn(dir).then((r) => {
        if (timedOut) return null;
        return r;
      }),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs)
      ),
    ]);

    if (result === null) {
      return {
        success: false,
        output: "",
        error: `Timeout after ${timeoutMs}ms`,
        exitCode: null,
        durationMs: Date.now() - startTime,
      };
    }

    return result;
  } finally {
    clearTimeout(timer);
  }
}
