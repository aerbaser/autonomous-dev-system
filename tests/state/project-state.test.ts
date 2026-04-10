import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
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
  type ProjectState,
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
});
