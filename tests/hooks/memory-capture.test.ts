import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the SDK query before importing
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

const { query: mockedQuery } = await import("@anthropic-ai/claude-agent-sdk");

const { capturePhaseMemories } = await import("../../src/hooks/memory-capture.js");
import { MemoryStore } from "../../src/state/memory-store.js";
import type { Config } from "../../src/utils/config.js";
import type { PhaseResult } from "../../src/phases/types.js";
import { createInitialState } from "../../src/state/project-state.js";

const TEST_STATE_DIR = join(tmpdir(), `ads-test-memcapture-${process.pid}`);

function makeConfig(memoryEnabled: boolean): Config {
  return {
    model: "claude-sonnet-4-6",
    subagentModel: "claude-sonnet-4-6",
    selfImprove: { enabled: false, maxIterations: 0, nightlyOptimize: false },
    projectDir: ".",
    stateDir: TEST_STATE_DIR,
    autonomousMode: true,
    maxTurns: {
      default: 50, decomposition: 3, development: 200, qualityFix: 30,
      testing: 30, review: 20, deployment: 20, monitoring: 10,
      ideation: 10, architecture: 10, abTesting: 10, stackResearch: 15,
      domainAnalysis: 5, ossScan: 10,
    },
    dryRun: false,
    quickMode: false,
    confirmSpec: false,
    memory: {
      enabled: memoryEnabled,
      maxDocuments: 500,
      maxDocumentSizeKb: 100,
    },
    rubrics: { enabled: false, maxIterations: 3 },
  };
}

function makePhaseResult(success: boolean): PhaseResult {
  return {
    success,
    state: createInitialState("test idea"),
    error: success ? undefined : "test error",
  };
}

function mockQueryStream(responseText: string) {
  const asyncIterator = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "result" as const,
        subtype: "success" as const,
        result: responseText,
        session_id: "test-session",
        total_cost_usd: 0.001,
        num_turns: 1,
      };
    },
  };
  (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(asyncIterator);
}

describe("capturePhaseMemories", () => {
  let store: MemoryStore;

  beforeEach(() => {
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
    mkdirSync(TEST_STATE_DIR, { recursive: true });
    store = new MemoryStore(TEST_STATE_DIR);
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
  });

  it("does nothing when memory is disabled", async () => {
    const config = makeConfig(false);
    await capturePhaseMemories(makePhaseResult(true), "testing", store, config);

    const docs = await store.list();
    expect(docs).toHaveLength(0);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("extracts learnings and writes to store", async () => {
    const config = makeConfig(true);
    const learnings = [
      { topic: "Testing patterns", content: "Use integration tests for DB queries", tags: ["testing", "database"] },
      { topic: "Error handling", content: "Always validate user input at boundary", tags: ["security"] },
    ];

    mockQueryStream(JSON.stringify(learnings));

    await capturePhaseMemories(makePhaseResult(true), "testing", store, config);

    const docs = await store.list();
    expect(docs).toHaveLength(2);

    const topics = docs.map((d) => d.topic);
    expect(topics).toContain("Testing patterns");
    expect(topics).toContain("Error handling");
  });

  it("adds phase tag to learnings", async () => {
    const config = makeConfig(true);
    const learnings = [
      { topic: "Deployment tip", content: "Use blue-green", tags: ["devops"] },
    ];

    mockQueryStream(JSON.stringify(learnings));

    await capturePhaseMemories(makePhaseResult(true), "development", store, config);

    const docs = await store.list();
    expect(docs).toHaveLength(1);
    expect(docs[0]!.tags).toContain("development");
    expect(docs[0]!.tags).toContain("devops");
  });

  it("handles invalid JSON gracefully", async () => {
    const config = makeConfig(true);
    mockQueryStream("This is not valid JSON at all");

    await capturePhaseMemories(makePhaseResult(true), "testing", store, config);

    const docs = await store.list();
    expect(docs).toHaveLength(0);
  });

  it("handles query failure gracefully", async () => {
    const config = makeConfig(true);
    (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result" as const,
          subtype: "error" as const,
          errors: ["API error"],
          session_id: "test-session",
          total_cost_usd: 0,
        };
      },
    });

    // Should not throw
    await capturePhaseMemories(makePhaseResult(true), "testing", store, config);

    const docs = await store.list();
    expect(docs).toHaveLength(0);
  });

  it("deduplicates phase tag from learning tags", async () => {
    const config = makeConfig(true);
    const learnings = [
      { topic: "Tip", content: "Content", tags: ["testing", "other"] },
    ];

    mockQueryStream(JSON.stringify(learnings));

    await capturePhaseMemories(makePhaseResult(true), "testing", store, config);

    const docs = await store.list();
    expect(docs).toHaveLength(1);
    // "testing" should appear only once
    const testingCount = docs[0]!.tags.filter((t) => t === "testing").length;
    expect(testingCount).toBe(1);
  });
});
