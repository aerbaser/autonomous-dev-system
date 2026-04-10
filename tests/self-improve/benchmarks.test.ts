import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Benchmark, BenchmarkResult } from "../../src/self-improve/benchmark-types.js";
import { getDefaultBenchmarks, runAllBenchmarks, runBenchmark } from "../../src/self-improve/benchmarks.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../../src/self-improve/sandbox.js", () => ({
  runCommandInSandbox: vi.fn(),
}));

const mockRun = vi.fn();

vi.mock("../../src/self-improve/verifiers.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    createDeterministicVerifier: () => ({ type: "deterministic" as const, run: mockRun }),
    createLlmVerifier: () => ({ type: "llm" as const, run: mockRun }),
  };
});

describe("Benchmarks", () => {
  let stateDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    stateDir = mkdtempSync(join(tmpdir(), "benchmarks-test-"));
  });

  afterEach(() => {
    if (existsSync(stateDir)) {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  function makeBenchmark(overrides: Partial<Benchmark> = {}): Benchmark {
    return {
      id: "benchmark-1",
      name: "Benchmark 1",
      verifier: "deterministic",
      weight: 1,
      tasks: [
        {
          instruction: "echo ok",
          timeout: 1000,
        },
      ],
      ...overrides,
    };
  }

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

  describe("runBenchmark", () => {
    it("persists each result as an append-only JSONL entry", async () => {
      mockRun
        .mockResolvedValueOnce({ score: 0.4, costUsd: 0.01 })
        .mockResolvedValueOnce({ score: 0.8, costUsd: 0.02 });

      const benchmark = makeBenchmark();

      const first = await runBenchmark(benchmark, stateDir);
      const second = await runBenchmark(benchmark, stateDir);

      expect(first.score).toBe(0.4);
      expect(second.score).toBe(0.8);

      const filePath = join(stateDir, "benchmarks", `${benchmark.id}.jsonl`);
      const lines = readFileSync(filePath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);

      const persisted = lines.map((line) => JSON.parse(line) as BenchmarkResult);
      expect(persisted[0]).toMatchObject({ benchmarkId: benchmark.id, score: 0.4, costUsd: 0.01 });
      expect(persisted[1]).toMatchObject({ benchmarkId: benchmark.id, score: 0.8, costUsd: 0.02 });
    });

    it("downgrades verifier failures to zero-score tasks instead of aborting the benchmark", async () => {
      mockRun
        .mockRejectedValueOnce(new Error("verifier crashed"))
        .mockResolvedValueOnce({ score: 0.8, costUsd: 0.02 });

      const benchmark = makeBenchmark({
        id: "resilient",
        tasks: [
          { instruction: "task 1", timeout: 1000 },
          { instruction: "task 2", timeout: 1000 },
        ],
      });

      const result = await runBenchmark(benchmark);

      expect(result.score).toBeCloseTo(0.4, 5);
      expect(result.costUsd).toBeCloseTo(0.02, 5);
      expect(result.details).toEqual({ taskScores: [0, 0.8] });
    });
  });

  describe("runAllBenchmarks", () => {
    it("computes a weighted total score instead of a plain average", async () => {
      mockRun
        .mockResolvedValueOnce({ score: 0.2, costUsd: 0.1 })
        .mockResolvedValueOnce({ score: 0.8, costUsd: 0.2 });

      const benchmarks: Benchmark[] = [
        makeBenchmark({ id: "low", name: "Low", weight: 0.25 }),
        makeBenchmark({ id: "high", name: "High", weight: 0.75 }),
      ];

      const result = await runAllBenchmarks(benchmarks);

      expect(result.totalScore).toBeCloseTo(0.65, 5);
      expect(result.totalCostUsd).toBeCloseTo(0.3, 5);
      expect(result.results).toHaveLength(2);
    });

    it("treats non-finite benchmark scores as zero so one bad run does not poison the suite total", async () => {
      mockRun
        .mockResolvedValueOnce({ score: 1.0, costUsd: 0.01 })
        .mockResolvedValueOnce({ score: Number.NaN, costUsd: 0.02 });

      const benchmarks: Benchmark[] = [
        makeBenchmark({ id: "stable", name: "Stable", weight: 0.5 }),
        makeBenchmark({ id: "flaky", name: "Flaky", weight: 0.5 }),
      ];

      const result = await runAllBenchmarks(benchmarks);

      expect(Number.isFinite(result.totalScore)).toBe(true);
      expect(result.totalScore).toBeCloseTo(0.5, 5);
      expect(result.results).toHaveLength(2);
      expect(result.results[1]?.benchmarkId).toBe("flaky");
      expect(result.results[1]?.score).toBe(0);
    });
  });
});
