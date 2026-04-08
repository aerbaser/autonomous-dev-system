import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDefaultBenchmarks, type Benchmark } from "../../src/self-improve/benchmarks.js";

// Mock the SDK — not needed for getDefaultBenchmarks but required at module resolution
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

// Mock sandbox — not needed for pure functions but required at import
vi.mock("../../src/self-improve/sandbox.js", () => ({
  runCommandInSandbox: vi.fn(),
}));

describe("Benchmarks", () => {
  describe("getDefaultBenchmarks", () => {
    let benchmarks: Benchmark[];

    beforeEach(() => {
      benchmarks = getDefaultBenchmarks();
    });

    it("returns exactly 5 default benchmarks", () => {
      expect(benchmarks).toHaveLength(5);
    });

    it("has weights that sum to approximately 1.0", () => {
      const totalWeight = benchmarks.reduce((sum, b) => sum + b.weight, 0);
      expect(totalWeight).toBeCloseTo(1.0, 5);
    });

    it("includes all expected benchmark IDs", () => {
      const ids = benchmarks.map((b) => b.id);
      expect(ids).toContain("code-quality");
      expect(ids).toContain("test-generation");
      expect(ids).toContain("spec-completeness");
      expect(ids).toContain("architecture-quality");
      expect(ids).toContain("build-success");
    });

    it("every benchmark has at least one task", () => {
      for (const b of benchmarks) {
        expect(b.tasks.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("every benchmark has a valid verifier type", () => {
      for (const b of benchmarks) {
        expect(["deterministic", "llm"]).toContain(b.verifier);
      }
    });

    it("every task has a positive timeout", () => {
      for (const b of benchmarks) {
        for (const task of b.tasks) {
          expect(task.timeout).toBeGreaterThan(0);
        }
      }
    });

    it("build-success benchmark uses deterministic verifier", () => {
      const buildBenchmark = benchmarks.find((b) => b.id === "build-success");
      expect(buildBenchmark).toBeDefined();
      expect(buildBenchmark!.verifier).toBe("deterministic");
    });

    it("code-quality has a fixture defined for its tasks", () => {
      const codeQuality = benchmarks.find((b) => b.id === "code-quality");
      expect(codeQuality).toBeDefined();
      for (const task of codeQuality!.tasks) {
        expect(task.fixture).toBeDefined();
        expect(task.fixture!.files).toBeDefined();
      }
    });
  });
});
