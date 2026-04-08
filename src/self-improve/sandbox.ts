import { fork, execFile, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

export interface SandboxOptions {
  timeoutMs: number;
  memoryLimitMb?: number;
  cwd?: string;
  env?: Record<string, string>;
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

  return new Promise<SandboxResult>((res) => {
    const child: ChildProcess = fork(resolve(scriptPath), args, {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
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
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
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
        error: stderr || undefined,
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

  // Split command into executable + args for execFile (avoids shell injection)
  const parts = command.split(/\s+/);
  const executable = parts[0] ?? command;
  const args = parts.slice(1);

  return new Promise<SandboxResult>((res) => {
    const child = execFile(
      executable,
      args,
      {
        cwd: options.cwd ?? process.cwd(),
        timeout: options.timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: {
          ...process.env,
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
            error: stderr || undefined,
            exitCode: 0,
            durationMs,
          });
        }
      }
    );

    // Guard against the child process handle not being created
    if (!child) {
      res({
        success: false,
        output: "",
        error: "Failed to spawn process",
        exitCode: null,
        durationMs: Date.now() - startTime,
      });
    }
  });
}
