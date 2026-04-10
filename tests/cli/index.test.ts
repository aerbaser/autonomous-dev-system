import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState, saveState } from "../../src/state/project-state.js";

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`EXIT:${code}`);
  }
}

const originalArgv = [...process.argv];
const TEST_ROOT = join(tmpdir(), `ads-test-cli-${process.pid}`);

vi.mock("../../src/orchestrator.js", () => ({
  runOrchestrator: vi.fn(),
  getInterrupter: vi.fn(() => ({ requestShutdown: vi.fn() })),
}));

vi.mock("../../src/self-improve/optimizer.js", () => ({
  runOptimizer: vi.fn(),
}));

vi.mock("../../src/nightly/nightly-runner.js", () => ({
  runNightlyMaintenance: vi.fn(async () => ({
    status: "passed",
    steps: [],
  })),
}));

vi.mock("../../src/dashboard/generate.js", () => ({
  generateDashboard: vi.fn(),
  openInBrowser: vi.fn(),
}));

const { runOrchestrator } = await import("../../src/orchestrator.js");
const { runOptimizer } = await import("../../src/self-improve/optimizer.js");
const { runNightlyMaintenance } = await import("../../src/nightly/nightly-runner.js");
const { generateDashboard, openInBrowser } = await import("../../src/dashboard/generate.js");

process.argv = ["node", "autonomous-dev"];
const { createCliProgram } = await import("../../src/index.js");
process.argv = originalArgv;

const mockedRunOrchestrator = vi.mocked(runOrchestrator);
const mockedRunOptimizer = vi.mocked(runOptimizer);
const mockedRunNightlyMaintenance = vi.mocked(runNightlyMaintenance);
const mockedGenerateDashboard = vi.mocked(generateDashboard);
const mockedOpenInBrowser = vi.mocked(openInBrowser);

function makeStateDir(testName: string): string {
  const dir = join(TEST_ROOT, testName);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  return join(dir, ".autonomous-dev");
}

function makeMalformedStateDir(testName: string): string {
  const stateDir = makeStateDir(testName);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), "{not valid json");
  return stateDir;
}

async function runCli(args: string[]): Promise<void> {
  const program = createCliProgram();
  await program.parseAsync(args, { from: "user" });
}

describe("CLI contract", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.clearAllMocks();
    process.chdir(originalCwd);
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
    mkdirSync(TEST_ROOT, { recursive: true });
    vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new ExitError(typeof code === "number" ? code : 0);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });

  it("runs the `run` command with a fresh state and preserves autonomy defaults", async () => {
    const stateDir = makeStateDir("run-fresh");
    process.chdir(join(TEST_ROOT, "run-fresh"));

    await runCli(["run", "--idea", "Build a todo app"]);

    expect(mockedRunOrchestrator).toHaveBeenCalledTimes(1);
    const [state, config, resume] = mockedRunOrchestrator.mock.calls[0]!;
    expect(state.idea).toBe("Build a todo app");
    expect(state.currentPhase).toBe("ideation");
    expect(config.stateDir).toBe(".autonomous-dev");
    expect(config.confirmSpec).toBe(false);
    expect(config.dryRun).toBe(false);
    expect(config.quickMode).toBe(false);
    expect(resume).toBeUndefined();
  });

  it("passes explicit run options through to the orchestrator config", async () => {
    const stateDir = makeStateDir("run-options");
    process.chdir(join(TEST_ROOT, "run-options"));

    await runCli([
      "run",
      "--idea", "Build a todo app",
      "--budget", "7",
      "--dry-run",
      "--quick",
      "--confirm-spec",
      "--verbose",
    ]);

    expect(mockedRunOrchestrator).toHaveBeenCalledTimes(1);
    const [_state, config] = mockedRunOrchestrator.mock.calls[0]!;
    expect(config.budgetUsd).toBe(7);
    expect(config.dryRun).toBe(true);
    expect(config.quickMode).toBe(true);
    expect(config.confirmSpec).toBe(true);
  });

  it("exits deterministically when `run` finds existing state without `--resume`", async () => {
    const cwd = join(TEST_ROOT, "run-existing");
    const stateDir = makeStateDir("run-existing");
    process.chdir(cwd);
    saveState(stateDir, createInitialState("Existing project"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["run", "--idea", "Build a todo app"])).rejects.toMatchObject({ code: 1 });

    expect(mockedRunOrchestrator).not.toHaveBeenCalled();
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("Use --resume");
  });

  it("resumes an existing state when `run` receives `--resume`", async () => {
    const cwd = join(TEST_ROOT, "run-resume");
    const stateDir = makeStateDir("run-resume");
    process.chdir(cwd);
    const state = createInitialState("Existing project");
    saveState(stateDir, state);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["run", "--idea", "Ignored idea", "--resume", "session-123"]);

    expect(mockedRunOrchestrator).toHaveBeenCalledTimes(1);
    const [resumedState, _config, resume] = mockedRunOrchestrator.mock.calls[0]!;
    expect(resumedState.id).toBe(state.id);
    expect(resume).toBe("session-123");
    expect(logSpy.mock.calls.flat().join("\n")).toContain("Resuming project");
  });

  it("exits deterministically when `run --resume` has no saved state", async () => {
    const cwd = join(TEST_ROOT, "run-resume-missing");
    mkdirSync(cwd, { recursive: true });
    process.chdir(cwd);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runCli(["run", "--idea", "Build a todo app", "--resume", "session-123"])
    ).rejects.toMatchObject({ code: 1 });

    expect(mockedRunOrchestrator).not.toHaveBeenCalled();
    expect(String(errorSpy.mock.calls.flat().join("\n"))).toContain("No saved state found");
  });

  it("exits deterministically when `run --resume` sees malformed state JSON", async () => {
    const cwd = join(TEST_ROOT, "run-resume-malformed");
    makeMalformedStateDir("run-resume-malformed");
    process.chdir(cwd);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runCli(["run", "--idea", "Build a todo app", "--resume", "session-123"])
    ).rejects.toMatchObject({ code: 1 });

    expect(mockedRunOrchestrator).not.toHaveBeenCalled();
    expect(String(errorSpy.mock.calls.flat().join("\n"))).toContain("Saved state is unreadable");
  });

  it("refuses to start a fresh run over malformed saved state", async () => {
    const cwd = join(TEST_ROOT, "run-malformed");
    makeMalformedStateDir("run-malformed");
    process.chdir(cwd);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["run", "--idea", "Build a todo app"])).rejects.toMatchObject({ code: 1 });

    expect(mockedRunOrchestrator).not.toHaveBeenCalled();
    expect(String(errorSpy.mock.calls.flat().join("\n"))).toContain("Saved state is unreadable");
  });

  it("shows the `status` command output when no state exists", async () => {
    const cwd = join(TEST_ROOT, "status-empty");
    mkdirSync(cwd, { recursive: true });
    process.chdir(cwd);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["status"]);

    expect(logSpy.mock.calls.flat().join("\n")).toContain("No project found");
    expect(mockedRunOrchestrator).not.toHaveBeenCalled();
  });

  it("shows a warning when `status` sees malformed state JSON", async () => {
    const cwd = join(TEST_ROOT, "status-malformed");
    makeMalformedStateDir("status-malformed");
    process.chdir(cwd);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["status"]);

    expect(logSpy.mock.calls.flat().join("\n")).toContain("Saved state is unreadable");
    expect(mockedRunOrchestrator).not.toHaveBeenCalled();
  });

  it("shows the `status` command output for an existing state", async () => {
    const cwd = join(TEST_ROOT, "status-state");
    const stateDir = makeStateDir("status-state");
    process.chdir(cwd);
    const state = createInitialState("Build a dashboard");
    saveState(stateDir, {
      ...state,
      currentPhase: "development",
      tasks: [
        {
          id: "task-1",
          title: "Ship it",
          description: "Task",
          status: "completed",
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      ],
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["status"]);

    expect(logSpy.mock.calls.flat().join("\n")).toContain("Project Status");
    expect(logSpy.mock.calls.flat().join("\n")).toContain("development");
    expect(mockedRunOrchestrator).not.toHaveBeenCalled();
  });

  it("runs the `phase` command for a valid phase", async () => {
    const cwd = join(TEST_ROOT, "phase-valid");
    const stateDir = makeStateDir("phase-valid");
    process.chdir(cwd);
    saveState(stateDir, createInitialState("Build an app"));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["phase", "--name", "testing"]);

    expect(mockedRunOrchestrator).toHaveBeenCalledTimes(1);
    const [state, config, resume, phase] = mockedRunOrchestrator.mock.calls[0]!;
    expect(state.currentPhase).toBe("ideation");
    expect(config.stateDir).toBe(".autonomous-dev");
    expect(resume).toBeUndefined();
    expect(phase).toBe("testing");
    expect(logSpy.mock.calls.flat().join("\n")).toContain("Running single phase");
  });

  it("exits deterministically when `phase` receives an invalid phase", async () => {
    const cwd = join(TEST_ROOT, "phase-invalid");
    const stateDir = makeStateDir("phase-invalid");
    process.chdir(cwd);
    saveState(stateDir, createInitialState("Build an app"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["phase", "--name", "not-a-phase"])).rejects.toMatchObject({ code: 1 });

    expect(mockedRunOrchestrator).not.toHaveBeenCalled();
    expect(String(errorSpy.mock.calls.flat().join("\n"))).toContain("Unknown phase");
  });

  it("exits deterministically when `optimize` runs without saved state", async () => {
    const cwd = join(TEST_ROOT, "optimize-empty");
    mkdirSync(cwd, { recursive: true });
    process.chdir(cwd);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["optimize"])).rejects.toMatchObject({ code: 1 });

    expect(mockedRunOptimizer).not.toHaveBeenCalled();
    expect(String(errorSpy.mock.calls.flat().join("\n"))).toContain("No project state found");
  });

  it("exits deterministically when `optimize` sees malformed state JSON", async () => {
    const cwd = join(TEST_ROOT, "optimize-malformed");
    makeMalformedStateDir("optimize-malformed");
    process.chdir(cwd);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["optimize"])).rejects.toMatchObject({ code: 1 });

    expect(mockedRunOptimizer).not.toHaveBeenCalled();
    expect(String(errorSpy.mock.calls.flat().join("\n"))).toContain("Project state is unreadable");
  });

  it("runs `optimize` with parsed benchmark and iteration options", async () => {
    const cwd = join(TEST_ROOT, "optimize-state");
    const stateDir = makeStateDir("optimize-state");
    process.chdir(cwd);
    const state = createInitialState("Improve prompts");
    saveState(stateDir, state);

    await runCli(["optimize", "--benchmark", "code-quality", "--max-iterations", "7"]);

    expect(mockedRunOptimizer).toHaveBeenCalledTimes(1);
    const [savedState, config, options] = mockedRunOptimizer.mock.calls[0]!;
    expect(savedState.id).toBe(state.id);
    expect(config.stateDir).toBe(".autonomous-dev");
    expect(options).toEqual({
      benchmarkId: "code-quality",
      maxIterations: 7,
    });
  });

  it("runs `nightly` with parsed options and existing state", async () => {
    const cwd = join(TEST_ROOT, "nightly-state");
    const stateDir = makeStateDir("nightly-state");
    process.chdir(cwd);
    const state = createInitialState("Maintain prompts");
    saveState(stateDir, state);

    await runCli([
      "nightly",
      "--max-iterations", "3",
      "--skip-dashboard",
    ]);

    expect(mockedRunNightlyMaintenance).toHaveBeenCalledTimes(1);
    const [savedState, config, options] = mockedRunNightlyMaintenance.mock.calls[0]!;
    expect(savedState.id).toBe(state.id);
    expect(config.stateDir).toBe(".autonomous-dev");
    expect(options).toEqual({
      maxIterations: 3,
      skipOptimize: false,
      skipDashboard: true,
    });
  });

  it("exits deterministically when `nightly` runs without saved state", async () => {
    const cwd = join(TEST_ROOT, "nightly-empty");
    mkdirSync(cwd, { recursive: true });
    process.chdir(cwd);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["nightly"])).rejects.toMatchObject({ code: 1 });

    expect(mockedRunNightlyMaintenance).not.toHaveBeenCalled();
    expect(String(errorSpy.mock.calls.flat().join("\n"))).toContain("No project state found");
  });

  it("exits deterministically when `nightly` sees malformed state JSON", async () => {
    const cwd = join(TEST_ROOT, "nightly-malformed");
    makeMalformedStateDir("nightly-malformed");
    process.chdir(cwd);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["nightly"])).rejects.toMatchObject({ code: 1 });

    expect(mockedRunNightlyMaintenance).not.toHaveBeenCalled();
    expect(String(errorSpy.mock.calls.flat().join("\n"))).toContain("Project state is unreadable");
  });

  it("exits non-zero when the nightly runner reports failure", async () => {
    const cwd = join(TEST_ROOT, "nightly-failed");
    const stateDir = makeStateDir("nightly-failed");
    process.chdir(cwd);
    saveState(stateDir, createInitialState("Maintain project"));
    mockedRunNightlyMaintenance.mockResolvedValueOnce({
      status: "failed",
      steps: [{ name: "optimize", status: "failed", detail: "optimizer exploded" }],
    });

    await expect(runCli(["nightly"])).rejects.toMatchObject({ code: 1 });
  });

  it("runs `dashboard` by generating the file and opening it", async () => {
    const cwd = join(TEST_ROOT, "dashboard");
    mkdirSync(cwd, { recursive: true });
    process.chdir(cwd);

    await runCli(["dashboard"]);

    expect(mockedGenerateDashboard).toHaveBeenCalledTimes(1);
    expect(mockedGenerateDashboard).toHaveBeenCalledWith(
      ".autonomous-dev",
      ".autonomous-dev/dashboard.html"
    );
    expect(mockedOpenInBrowser).toHaveBeenCalledTimes(1);
    expect(mockedOpenInBrowser).toHaveBeenCalledWith(".autonomous-dev/dashboard.html");
  });

  it("regenerates `dashboard --watch` on an interval and exits on SIGINT", async () => {
    const cwd = join(TEST_ROOT, "dashboard-watch");
    mkdirSync(cwd, { recursive: true });
    process.chdir(cwd);

    vi.useFakeTimers();

    let sigintHandler: (() => void) | undefined;
    const processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
      if (event === "SIGINT") sigintHandler = listener;
      return process;
    }) as never);

    const runPromise = runCli(["dashboard", "--watch"]);

    await vi.advanceTimersByTimeAsync(5_100);

    expect(mockedGenerateDashboard).toHaveBeenCalledTimes(2);
    expect(mockedOpenInBrowser).toHaveBeenCalledTimes(1);
    expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(sigintHandler).toBeDefined();

    await expect((async () => {
      sigintHandler?.();
      return runPromise;
    })()).rejects.toMatchObject({ code: 0 });

    vi.useRealTimers();
  });
});
