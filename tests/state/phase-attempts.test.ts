import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInitialState, loadState, saveState, type ProjectState } from "../../src/state/project-state.js";
import { incrementBackloopCount, isBackloopUnderCap } from "../../src/orchestrator.js";

const TEST_DIR = join(tmpdir(), `ads-test-phase-attempts-${process.pid}`);

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

describe("phaseAttempts + backloopCounts (v1.1 super-lead)", () => {
  it("createInitialState initializes both fields to empty objects", () => {
    const s = createInitialState("idea");
    expect(s.phaseAttempts).toEqual({});
    expect(s.backloopCounts).toEqual({});
  });

  it("loadState migrates pre-v1.1 state.json that lacks the new fields", () => {
    const preV11: Record<string, unknown> = {
      id: "run-1",
      idea: "build",
      currentPhase: "ideation",
      spec: null,
      architecture: null,
      environment: null,
      agents: [],
      tasks: [],
      completedPhases: [],
      phaseResults: { ideation: { success: true, timestamp: new Date().toISOString() } },
      // phaseAttempts + backloopCounts deliberately absent
      deployments: [],
      abTests: [],
      evolution: [],
      checkpoints: [],
      baselineScore: 0,
      totalCostUsd: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(join(TEST_DIR, "state.json"), JSON.stringify(preV11));
    const loaded = loadState(TEST_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.phaseAttempts).toEqual({});
    expect(loaded!.backloopCounts).toEqual({});
    // And the existing field still round-trips.
    expect(loaded!.phaseResults["ideation"]?.success).toBe(true);
  });

  it("saveState + loadState round-trips phaseAttempts and backloopCounts", () => {
    const s: ProjectState = {
      ...createInitialState("idea"),
      phaseAttempts: {
        architecture: [
          { success: false, error: "bad", timestamp: new Date().toISOString() },
          { success: true, timestamp: new Date().toISOString(), costUsd: 0.5 },
        ],
      },
      backloopCounts: { "testing->development": 2 },
    };
    saveState(TEST_DIR, s);
    const loaded = loadState(TEST_DIR);
    expect(loaded?.phaseAttempts["architecture"]?.length).toBe(2);
    expect(loaded?.backloopCounts["testing->development"]).toBe(2);
  });
});

describe("incrementBackloopCount", () => {
  it("starts at 1 on the first increment for a (from→to) pair", () => {
    const s = createInitialState("idea");
    const next = incrementBackloopCount(s, "testing", "development");
    expect(next.backloopCounts["testing->development"]).toBe(1);
  });

  it("increments existing counts without touching unrelated pairs", () => {
    const base: ProjectState = {
      ...createInitialState("idea"),
      backloopCounts: { "testing->development": 2, "review->development": 1 },
    };
    const next = incrementBackloopCount(base, "testing", "development");
    expect(next.backloopCounts["testing->development"]).toBe(3);
    expect(next.backloopCounts["review->development"]).toBe(1);
  });
});

describe("isBackloopUnderCap", () => {
  it("returns true when cap is undefined (no guard)", () => {
    const s = createInitialState("idea");
    expect(isBackloopUnderCap(s, "testing", "development", undefined)).toBe(true);
  });

  it("returns true while current < cap", () => {
    const s: ProjectState = {
      ...createInitialState("idea"),
      backloopCounts: { "testing->development": 2 },
    };
    expect(isBackloopUnderCap(s, "testing", "development", 3)).toBe(true);
  });

  it("returns false when current === cap (livelock guard fires)", () => {
    const s: ProjectState = {
      ...createInitialState("idea"),
      backloopCounts: { "testing->development": 3 },
    };
    expect(isBackloopUnderCap(s, "testing", "development", 3)).toBe(false);
  });
});
