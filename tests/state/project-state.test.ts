import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as nodeFs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInitialState,
  saveState,
  loadState,
  transitionPhase,
  canTransition,
  addTask,
  updateTask,
  saveCheckpoint,
  getLatestCheckpoint,
  getCheckpointHistory,
  withStateLock,
  assertSafePath,
  assertSafeWritePath,
  MAX_CHECKPOINTS_PER_PHASE,
  type ProjectState,
  type PhaseCheckpoint,
} from "../../src/state/project-state.js";

const TEST_STATE_DIR = join(tmpdir(), `ads-test-state-${process.pid}`);

describe("ProjectState", () => {
  beforeEach(() => {
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
    mkdirSync(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
  });

  describe("createInitialState", () => {
    it("creates state with correct defaults", () => {
      const state = createInitialState("Build a todo app");
      expect(state.idea).toBe("Build a todo app");
      expect(state.currentPhase).toBe("ideation");
      expect(state.spec).toBeNull();
      expect(state.architecture).toBeNull();
      expect(state.environment).toBeNull();
      expect(state.agents).toEqual([]);
      expect(state.tasks).toEqual([]);
      expect(state.id).toBeTruthy();
    });
  });

  describe("persistence", () => {
    it("saves and loads state", () => {
      const state = createInitialState("Test idea");
      saveState(TEST_STATE_DIR, state);

      const loaded = loadState(TEST_STATE_DIR);
      expect(loaded).not.toBeNull();
      expect(loaded!.idea).toBe("Test idea");
      expect(loaded!.id).toBe(state.id);
    });

    it("returns null for missing state", () => {
      const loaded = loadState(join(tmpdir(), "ads-nonexistent-dir"));
      expect(loaded).toBeNull();
    });

    it("returns null for schema-invalid state", () => {
      writeFileSync(join(TEST_STATE_DIR, "state.json"), JSON.stringify({ idea: "partial state" }));

      const loaded = loadState(TEST_STATE_DIR);
      expect(loaded).toBeNull();
    });

    it("returns null for malformed state JSON", () => {
      const statePath = join(TEST_STATE_DIR, "state.json");
      writeFileSync(statePath, "{not valid json");

      const loaded = loadState(TEST_STATE_DIR);
      expect(loaded).toBeNull();
    });
  });

  describe("phase transitions", () => {
    it("allows valid transitions", () => {
      expect(canTransition("ideation", "specification")).toBe(true);
      expect(canTransition("specification", "architecture")).toBe(true);
      expect(canTransition("architecture", "environment-setup")).toBe(true);
      expect(canTransition("environment-setup", "development")).toBe(true);
      expect(canTransition("development", "testing")).toBe(true);
      expect(canTransition("testing", "review")).toBe(true);
      expect(canTransition("testing", "development")).toBe(true);
      expect(canTransition("review", "staging")).toBe(true);
      expect(canTransition("review", "development")).toBe(true);
      expect(canTransition("monitoring", "development")).toBe(true);
    });

    it("rejects invalid transitions", () => {
      expect(canTransition("ideation", "development")).toBe(false);
      expect(canTransition("testing", "staging")).toBe(false);
      expect(canTransition("review", "monitoring")).toBe(false);
    });

    it("transitionPhase updates current phase", () => {
      const state = createInitialState("test");
      const next = transitionPhase(state, "specification");
      expect(next.currentPhase).toBe("specification");
    });

    it("transitionPhase throws for invalid transition", () => {
      const state = createInitialState("test");
      expect(() => transitionPhase(state, "development")).toThrow(
        /Invalid phase transition/
      );
    });
  });

  describe("task management", () => {
    it("adds tasks", () => {
      let state = createInitialState("test");
      state = addTask(state, {
        title: "Implement auth",
        description: "User authentication module",
      });

      expect(state.tasks).toHaveLength(1);
      expect(state.tasks[0].title).toBe("Implement auth");
      expect(state.tasks[0].status).toBe("pending");
      expect(state.tasks[0].id).toBeTruthy();
    });

    it("updates task status", () => {
      let state = createInitialState("test");
      state = addTask(state, {
        title: "Task 1",
        description: "Description",
      });

      const taskId = state.tasks[0].id;
      state = updateTask(state, taskId, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });

      expect(state.tasks[0].status).toBe("completed");
      expect(state.tasks[0].completedAt).toBeTruthy();
    });
  });

  describe("atomic saveState", () => {
    it("writes valid JSON atomically on happy path", () => {
      const state = createInitialState("happy");
      saveState(TEST_STATE_DIR, state);
      const loaded = loadState(TEST_STATE_DIR);
      expect(loaded).not.toBeNull();
      expect(loaded!.idea).toBe("happy");
    });

    it("leaves no tmp files behind after a successful write", () => {
      const state = createInitialState("no-tmp");
      saveState(TEST_STATE_DIR, state);
      const residual = (nodeFs.readdirSync(TEST_STATE_DIR) as string[]).filter((f) =>
        f.startsWith("state.json.tmp."),
      );
      expect(residual).toEqual([]);
    });

    it("preserves existing state.json when the write path fails", () => {
      // Seed a valid state.json.
      const state = createInitialState("baseline");
      saveState(TEST_STATE_DIR, state);
      const statePath = join(TEST_STATE_DIR, "state.json");
      const before = readFileSync(statePath, "utf-8");

      // Trigger a failure by targeting a path where mkdirSync / openSync
      // cannot succeed (a non-directory parent).
      const unwritable = "/dev/null/cannot-mkdir/here";
      const bogus = createInitialState("should-never-persist");
      expect(() => saveState(unwritable, bogus)).toThrow();

      // The original, valid state.json under TEST_STATE_DIR is untouched.
      expect(readFileSync(statePath, "utf-8")).toBe(before);

      // No stray .tmp files were left behind in TEST_STATE_DIR.
      const residual = (nodeFs.readdirSync(TEST_STATE_DIR) as string[]).filter((f) =>
        f.startsWith("state.json.tmp."),
      );
      expect(residual).toEqual([]);
    });

    it("cleans up the .tmp sibling when rename fails", () => {
      // Create a directory at the rename target so renameSync fails (EISDIR on
      // POSIX, EEXIST on some platforms). saveState must unlink its tmp file.
      const statePath = join(TEST_STATE_DIR, "state.json");
      mkdirSync(statePath, { recursive: true });

      const victim = createInitialState("tmp-cleanup");
      expect(() => saveState(TEST_STATE_DIR, victim)).toThrow();

      const residual = (nodeFs.readdirSync(TEST_STATE_DIR) as string[]).filter((f) =>
        f.startsWith("state.json.tmp."),
      );
      expect(residual).toEqual([]);
    });
  });

  describe("saveCheckpoint history", () => {
    const baseTime = Date.now();
    function makeCheckpoint(offsetMs: number): PhaseCheckpoint {
      return {
        phase: "development",
        completedTasks: [],
        pendingTasks: [],
        timestamp: new Date(baseTime + offsetMs).toISOString(),
      };
    }

    it("keeps last 3 checkpoints per phase and discards older ones", () => {
      let state = createInitialState("test");
      const checkpoints = [0, 1000, 2000, 3000, 4000].map(makeCheckpoint);
      for (const cp of checkpoints) {
        state = saveCheckpoint(state, cp);
      }

      const devCheckpoints = state.checkpoints.filter((c) => c.phase === "development");
      expect(devCheckpoints.length).toBe(MAX_CHECKPOINTS_PER_PHASE);

      const history = getCheckpointHistory(state, "development");
      expect(history.length).toBe(MAX_CHECKPOINTS_PER_PHASE);
      // Newest-first: strictly descending timestamps.
      const timestamps = history.map((c) => Date.parse(c.timestamp));
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i - 1]).toBeGreaterThan(timestamps[i]);
      }
      const retainedTs = new Set(timestamps);
      expect(retainedTs.has(Date.parse(checkpoints[4]!.timestamp))).toBe(true);
      expect(retainedTs.has(Date.parse(checkpoints[3]!.timestamp))).toBe(true);
      expect(retainedTs.has(Date.parse(checkpoints[2]!.timestamp))).toBe(true);
      expect(retainedTs.has(Date.parse(checkpoints[0]!.timestamp))).toBe(false);
      expect(retainedTs.has(Date.parse(checkpoints[1]!.timestamp))).toBe(false);
    });

    it("keeps checkpoints for other phases unaffected", () => {
      let state = createInitialState("test");
      const devCps = [0, 1000, 2000, 3000, 4000].map(makeCheckpoint);
      for (const cp of devCps) state = saveCheckpoint(state, cp);
      // A checkpoint for a different phase is preserved independently.
      state = saveCheckpoint(state, {
        phase: "testing",
        completedTasks: [],
        pendingTasks: [],
        timestamp: new Date(baseTime + 9999).toISOString(),
      });
      expect(state.checkpoints.filter((c) => c.phase === "development").length).toBe(
        MAX_CHECKPOINTS_PER_PHASE,
      );
      expect(state.checkpoints.filter((c) => c.phase === "testing").length).toBe(1);
    });

    it("getLatestCheckpoint returns newest by timestamp", () => {
      let state = createInitialState("test");
      const older = makeCheckpoint(0);
      const newest = makeCheckpoint(10_000);
      const middle = makeCheckpoint(5_000);
      // Deliberately save older-then-newer to confirm sort order, not insertion order.
      state = saveCheckpoint(state, older);
      state = saveCheckpoint(state, newest);
      state = saveCheckpoint(state, middle);

      const latest = getLatestCheckpoint(state, "development");
      expect(latest).not.toBeNull();
      expect(latest!.timestamp).toBe(newest.timestamp);
    });
  });

  describe("withStateLock", () => {
    it("serializes concurrent saveState calls without corruption", async () => {
      const baseline = createInitialState("concurrent");
      saveState(TEST_STATE_DIR, baseline);

      // Fire 10 overlapping writes, each carrying a distinct idea so we can
      // verify one of them wins cleanly (no corruption, always a valid parse).
      const writers = Array.from({ length: 10 }, (_, i) =>
        withStateLock(TEST_STATE_DIR, () => {
          const mutated: ProjectState = { ...baseline, idea: `writer-${i}` };
          saveState(TEST_STATE_DIR, mutated);
        }),
      );
      await Promise.all(writers);

      const loaded = loadState(TEST_STATE_DIR);
      expect(loaded).not.toBeNull();
      expect(loaded!.idea).toMatch(/^writer-\d+$/);

      // Lock file must be released at the end.
      expect(existsSync(join(TEST_STATE_DIR, ".lock"))).toBe(false);
    });

    it("reclaims a stale lock file (mtime > 5 min old)", async () => {
      const lockPath = join(TEST_STATE_DIR, ".lock");
      writeFileSync(lockPath, "9999999");
      // Backdate mtime by 10 minutes.
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
      utimesSync(lockPath, tenMinAgo, tenMinAgo);

      let ran = false;
      await withStateLock(TEST_STATE_DIR, () => {
        ran = true;
      });
      expect(ran).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    });

    it("releases lock even when the callback throws", async () => {
      await expect(
        withStateLock(TEST_STATE_DIR, () => {
          throw new Error("callback blew up");
        }),
      ).rejects.toThrow(/callback blew up/);
      expect(existsSync(join(TEST_STATE_DIR, ".lock"))).toBe(false);
    });
  });

  describe("loadState lenient warning", () => {
    it("logs a warning when state.json fails schema validation", () => {
      writeFileSync(
        join(TEST_STATE_DIR, "state.json"),
        JSON.stringify({ idea: "missing required fields" }),
      );
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const loaded = loadState(TEST_STATE_DIR);
        expect(loaded).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
        const msg = String(warnSpy.mock.calls[0]?.[0] ?? "");
        expect(msg).toMatch(/schema validation failed/);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("logs a warning when state.json is malformed JSON", () => {
      writeFileSync(join(TEST_STATE_DIR, "state.json"), "{not valid json");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const loaded = loadState(TEST_STATE_DIR);
        expect(loaded).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
        const msg = String(warnSpy.mock.calls[0]?.[0] ?? "");
        expect(msg).toMatch(/failed to parse/);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});

describe("SEC-07 assertSafeWritePath", () => {
  const base = mkdtempSync(join(tmpdir(), "sec07-"));
  const stateDir = join(base, ".autonomous-dev");

  it("accepts a child path under stateDir", () => {
    expect(() =>
      assertSafeWritePath(stateDir, join(stateDir, "memory", "foo.json")),
    ).not.toThrow();
  });

  it("accepts the stateDir itself", () => {
    expect(() => assertSafeWritePath(stateDir, stateDir)).not.toThrow();
  });

  it("rejects a relative '..' escape", () => {
    expect(() =>
      assertSafeWritePath(stateDir, join(stateDir, "..", "etc", "passwd")),
    ).toThrow(/Path traversal/);
  });

  it("rejects an absolute path that is not under stateDir", () => {
    expect(() => assertSafeWritePath(stateDir, "/etc/passwd")).toThrow(
      /Path traversal/,
    );
  });

  it("rejects a sibling directory that shares a prefix substring (e.g. stateDir-evil)", () => {
    // Guards against a naive `startsWith(stateDir)` without the trailing '/'.
    expect(() =>
      assertSafeWritePath(stateDir, stateDir + "-evil/file.json"),
    ).toThrow(/Path traversal/);
  });

  it("existing assertSafePath continues to work (regression)", () => {
    expect(() => assertSafePath("/tmp")).not.toThrow(); // absolute path — allowed
    expect(() => assertSafePath(".autonomous-dev")).not.toThrow(); // relative under cwd — allowed
  });
});
