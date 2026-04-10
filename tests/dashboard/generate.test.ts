import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectDashboardData, openInBrowser } from "../../src/dashboard/generate.js";

const TEST_DIR = join(tmpdir(), `ads-test-dashboard-${process.pid}`);

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

function makeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "project-123",
    idea: "Build a dashboard",
    currentPhase: "testing",
    totalCostUsd: 1.25,
    createdAt: "2026-04-10T10:00:00.000Z",
    ...overrides,
  };
}

describe("collectDashboardData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("returns a pending dashboard snapshot when state is missing", () => {
    const data = collectDashboardData(TEST_DIR);

    expect(data.stateExists).toBe(false);
    expect(data.events).toEqual([]);
    expect(data.phases.every((phase) => phase.status === "pending")).toBe(true);
    expect(data.createdAt).toBe(data.generatedAt);
    expect(data.idea).toContain("No project found");
  });

  it("ignores malformed events and sorts valid events by sequence", () => {
    writeFileSync(join(TEST_DIR, "state.json"), JSON.stringify(makeState()), "utf8");
    mkdirSync(join(TEST_DIR, "events"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "events", "phase.jsonl"),
      [
        '{"seq":3,"type":"orchestrator.phase.end","timestamp":"2026-04-10T10:03:00.000Z","data":{"phase":"testing"}}',
        "not-json",
        '{"seq":1,"type":"orchestrator.phase.start","timestamp":"2026-04-10T10:01:00.000Z","data":{"phase":"ideation"}}',
        '{"seq":2,"type":"orchestrator.phase.end","timestamp":"2026-04-10T10:02:00.000Z","data":null}',
      ].join("\n"),
      "utf8"
    );

    const data = collectDashboardData(TEST_DIR);

    expect(data.stateExists).toBe(true);
    expect(data.events.map((event) => event.seq)).toEqual([1, 3]);
    expect(data.events[0]?.type).toBe("orchestrator.phase.start");
    expect(data.events[1]?.type).toBe("orchestrator.phase.end");
  });
});

describe("openInBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back after the platform opener fails", async () => {
    execFileMock
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("open not available"));
      })
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "", "");
      });

    await openInBrowser("/tmp/dashboard.html");

    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      "open",
      ["/tmp/dashboard.html"],
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "xdg-open",
      ["/tmp/dashboard.html"],
      expect.any(Function)
    );
  });
});
