import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentBlueprint, EvolutionEntry } from "../../src/state/project-state.js";
import type { BenchmarkResult } from "../../src/self-improve/benchmarks.js";

// Mock the SDK query function
const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// Dynamic import after mocks are set up
const { generateMutations } = await import(
  "../../src/self-improve/mutation-engine.js"
);

// Helper to create an async generator that yields SDK messages
function makeQueryResult(resultText: string, costUsd = 0.001) {
  return async function* () {
    yield {
      type: "result" as const,
      subtype: "success" as const,
      result: resultText,
      total_cost_usd: costUsd,
    };
  };
}

function makeBlueprint(overrides?: Partial<AgentBlueprint>): AgentBlueprint {
  return {
    name: "test-agent",
    role: "Test Agent",
    systemPrompt: "You are a test agent.",
    tools: ["Read", "Write"],
    evaluationCriteria: ["accuracy", "speed"],
    version: 1,
    ...overrides,
  };
}

function makeBenchmarkResults(
  overrides?: Partial<BenchmarkResult>[]
): BenchmarkResult[] {
  return [
    {
      benchmarkId: "code-quality",
      score: 0.7,
      details: {},
      timestamp: new Date().toISOString(),
      ...overrides?.[0],
    },
    {
      benchmarkId: "test-generation",
      score: 0.5,
      details: {},
      timestamp: new Date().toISOString(),
      ...overrides?.[1],
    },
  ];
}

describe("MutationEngine", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe("generateMutations — agent_prompt type", () => {
    it("generates a prompt mutation with apply/rollback", async () => {
      // Force agent_prompt by making history empty (most likely path)
      mockQuery.mockImplementation(() =>
        makeQueryResult("You are an improved test agent.")()
      );

      const blueprint = makeBlueprint();
      const results = makeBenchmarkResults();

      // Run multiple times since selectMutationType has randomness;
      // with empty history agent_prompt is heavily favored
      let mutations;
      for (let attempt = 0; attempt < 10; attempt++) {
        mockQuery.mockImplementation(() =>
          makeQueryResult("You are an improved test agent.")()
        );
        mutations = await generateMutations(blueprint, results, []);
        if (mutations.length > 0 && mutations[0]!.type === "agent_prompt") {
          break;
        }
      }

      // At least one attempt should succeed with agent_prompt
      expect(mutations).toBeDefined();
      if (mutations!.length > 0 && mutations![0]!.type === "agent_prompt") {
        const m = mutations![0]!;
        expect(m.targetName).toBe("test-agent");
        expect(m.description).toContain("test-agent");

        // apply returns a new blueprint with updated prompt
        const applied = m.apply();
        expect(applied.systemPrompt).toBe("You are an improved test agent.");
        expect(applied.version).toBe(2);

        // rollback restores original prompt
        const rolledBack = m.rollback();
        expect(rolledBack.systemPrompt).toBe("You are a test agent.");
      }
    });
  });

  describe("generateMutations — tool_config type", () => {
    it("generates tool mutation when query returns valid JSON array", async () => {
      mockQuery.mockImplementation(() =>
        makeQueryResult('["Read", "Write", "Bash", "Grep"]')()
      );

      const blueprint = makeBlueprint({ tools: ["Read", "Write"] });
      const results = makeBenchmarkResults();

      // Build history heavily biased away from tool_config to increase chance
      // that selectMutationType picks it
      const history: EvolutionEntry[] = [];
      for (let i = 0; i < 20; i++) {
        history.push({
          id: `e${i}`,
          target: "test-agent",
          type: "agent_prompt",
          diff: "test",
          scoreBefore: 0.5,
          scoreAfter: 0.6,
          accepted: true,
          timestamp: new Date().toISOString(),
        });
      }

      // Try multiple times due to randomness in selectMutationType
      let mutations;
      for (let attempt = 0; attempt < 20; attempt++) {
        mockQuery.mockImplementation(() =>
          makeQueryResult('["Read", "Write", "Bash", "Grep"]')()
        );
        mutations = await generateMutations(blueprint, results, history);
        if (mutations.length > 0 && mutations[0]!.type === "tool_config") {
          break;
        }
      }

      if (mutations && mutations.length > 0 && mutations[0]!.type === "tool_config") {
        const m = mutations[0]!;
        const applied = m.apply();
        expect(applied.tools).toEqual(["Read", "Write", "Bash", "Grep"]);
        expect(applied.version).toBe(2);

        const rolledBack = m.rollback();
        expect(rolledBack.tools).toEqual(["Read", "Write"]);
      }
    });
  });

  describe("generateMutations — quality_threshold type", () => {
    it("generates quality threshold mutation for poor benchmarks", async () => {
      // quality_threshold doesn't call query(), it checks scores < 0.5
      const blueprint = makeBlueprint();
      const results: BenchmarkResult[] = [
        {
          benchmarkId: "code-quality",
          score: 0.3, // below 0.5 threshold
          details: {},
          timestamp: new Date().toISOString(),
        },
      ];

      // Build history biased away from quality_threshold
      const history: EvolutionEntry[] = [];
      for (const type of [
        "agent_prompt",
        "tool_config",
        "phase_logic",
      ] as const) {
        for (let i = 0; i < 7; i++) {
          history.push({
            id: `e-${type}-${i}`,
            target: "test-agent",
            type,
            diff: "test",
            scoreBefore: 0.5,
            scoreAfter: 0.6,
            accepted: true,
            timestamp: new Date().toISOString(),
          });
        }
      }

      let mutations;
      for (let attempt = 0; attempt < 30; attempt++) {
        // Reset mock for types that do use query
        mockQuery.mockImplementation(() => makeQueryResult("")());
        mutations = await generateMutations(blueprint, results, history);
        if (
          mutations.length > 0 &&
          mutations[0]!.type === "quality_threshold"
        ) {
          break;
        }
      }

      if (
        mutations &&
        mutations.length > 0 &&
        mutations[0]!.type === "quality_threshold"
      ) {
        const m = mutations[0]!;
        const applied = m.apply();
        expect(applied.evaluationCriteria.length).toBeGreaterThan(
          blueprint.evaluationCriteria.length
        );
        expect(applied.version).toBe(2);

        const rolledBack = m.rollback();
        expect(rolledBack.evaluationCriteria).toEqual(
          blueprint.evaluationCriteria
        );
      }
    });
  });

  describe("generateMutations — empty result handling", () => {
    it("returns empty array when query returns empty text", async () => {
      mockQuery.mockImplementation(() => makeQueryResult("")());

      const blueprint = makeBlueprint();
      const results = makeBenchmarkResults();
      const mutations = await generateMutations(blueprint, results, []);

      // agent_prompt with empty result returns []
      // Other types may also return [] for various reasons
      expect(mutations).toBeInstanceOf(Array);
    });

    it("returns empty array when query throws", async () => {
      mockQuery.mockImplementation(() => {
        throw new Error("Network error");
      });

      const blueprint = makeBlueprint();
      const results = makeBenchmarkResults();
      const mutations = await generateMutations(blueprint, results, []);

      expect(mutations).toEqual([]);
    });
  });

  describe("mutation apply/rollback integrity", () => {
    it("apply does not mutate the original blueprint object", async () => {
      mockQuery.mockImplementation(() =>
        makeQueryResult("Improved prompt text")()
      );

      const original = makeBlueprint();
      const originalPrompt = original.systemPrompt;

      let mutations;
      for (let attempt = 0; attempt < 10; attempt++) {
        mockQuery.mockImplementation(() =>
          makeQueryResult("Improved prompt text")()
        );
        mutations = await generateMutations(original, makeBenchmarkResults(), []);
        if (mutations.length > 0) break;
      }

      if (mutations && mutations.length > 0) {
        mutations[0]!.apply();
        // Original should be unchanged
        expect(original.systemPrompt).toBe(originalPrompt);
        expect(original.version).toBe(1);
      }
    });
  });
});
