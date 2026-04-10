import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
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

const { runOrchestrator } = await import("../../src/orchestrator.js");

process.argv = ["node", "autonomous-dev"];
const { createCliProgram } = await import("../../src/index.js");
process.argv = originalArgv;

const mockedRunOrchestrator = vi.mocked(runOrchestrator);

function makeStateDir(testName: string): string {
  const dir = join(TEST_ROOT, testName);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  return join(dir, ".autonomous-dev");
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

  it("shows the `status` command output when no state exists", async () => {
    const cwd = join(TEST_ROOT, "status-empty");
    mkdirSync(cwd, { recursive: true });
    process.chdir(cwd);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["status"]);

    expect(logSpy.mock.calls.flat().join("\n")).toContain("No project found");
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
});
