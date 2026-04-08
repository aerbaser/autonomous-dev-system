import {
  existsSync,
  readFileSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDeterministicVerifier,
  createLlmVerifier,
} from "./verifiers.js";
import type { Verifier } from "./verifiers.js";
import type {
  BenchmarkTask,
  Benchmark,
  BenchmarkResult,
} from "./benchmark-types.js";
import { getDefaultBenchmarks } from "./benchmark-defaults.js";
import { ExternalBenchmarkFileSchema } from "../types/llm-schemas.js";

// Re-exports for backwards compatibility
export {
  createDeterministicVerifier,
  createLlmVerifier,
} from "./verifiers.js";
export type {
  Verifier,
  VerifierResult,
  VerifierTask,
  LlmVerifierOptions,
} from "./verifiers.js";
export type { BenchmarkTask, BenchmarkFixture, Benchmark, BenchmarkResult } from "./benchmark-types.js";
export { getDefaultBenchmarks } from "./benchmark-defaults.js";

// ── External benchmark loader ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getBenchmarksDir(): string {
  return resolve(__dirname, "..", "..", "benchmarks");
}

interface ExternalBenchmarkFile {
  id: string;
  name: string;
  verifier: "deterministic" | "llm";
  weight: number;
  tasks: BenchmarkTask[];
}

/**
 * Load benchmark tasks from benchmarks/<benchmarkId>/tasks.json.
 * Falls back to inline defaults if the external file doesn't exist.
 */
export function loadBenchmarkTasks(benchmarkId: string): Benchmark | null {
  const tasksPath = join(getBenchmarksDir(), benchmarkId, "tasks.json");

  if (!existsSync(tasksPath)) {
    const defaults = getDefaultBenchmarks();
    return defaults.find((b) => b.id === benchmarkId) ?? null;
  }

  try {
    const raw = readFileSync(tasksPath, "utf-8");
    const parseResult = ExternalBenchmarkFileSchema.safeParse(JSON.parse(raw));
    if (!parseResult.success) {
      const defaults = getDefaultBenchmarks();
      return defaults.find((b) => b.id === benchmarkId) ?? null;
    }
    const data = parseResult.data;
    return {
      id: data.id,
      name: data.name,
      tasks: data.tasks as BenchmarkTask[],
      verifier: data.verifier,
      weight: data.weight,
    };
  } catch (err) {
    console.log(
      `[benchmark] Failed to load ${tasksPath}: ${err instanceof Error ? err.message : String(err)}`
    );
    const defaults = getDefaultBenchmarks();
    return defaults.find((b) => b.id === benchmarkId) ?? null;
  }
}

// ── Benchmark execution ──

export async function runBenchmark(
  benchmark: Benchmark,
  stateDir?: string
): Promise<BenchmarkResult> {
  const taskScores: number[] = [];
  let totalCost = 0;

  const verifier: Verifier =
    benchmark.verifier === "deterministic"
      ? createDeterministicVerifier()
      : createLlmVerifier("Rate the quality of the output on a scale of 0 to 1, considering correctness, completeness, and clarity.", {});

  for (const task of benchmark.tasks) {
    const result = await verifier.run(task);
    taskScores.push(result.score);
    totalCost += result.costUsd;
  }

  const avgScore =
    taskScores.length > 0
      ? taskScores.reduce((a, b) => a + b, 0) / taskScores.length
      : 0;

  const benchmarkResult: BenchmarkResult = {
    benchmarkId: benchmark.id,
    score: avgScore,
    details: { taskScores },
    timestamp: new Date().toISOString(),
    costUsd: totalCost,
  };

  if (stateDir) {
    persistBenchmarkResult(stateDir, benchmarkResult);
  }

  return benchmarkResult;
}

// ── Benchmark suite runner ──

export async function runAllBenchmarks(
  benchmarks?: Benchmark[],
  options?: { parallel?: boolean; stateDir?: string }
): Promise<{ totalScore: number; results: BenchmarkResult[]; totalCostUsd: number }> {
  const suite = benchmarks ?? getDefaultBenchmarks();
  let results: BenchmarkResult[];
  let totalCost = 0;

  if (options?.parallel) {
    console.log(`[benchmark] Running ${suite.length} benchmarks in parallel...`);
    results = await Promise.all(
      suite.map(async (benchmark) => {
        console.log(`[benchmark] Starting: ${benchmark.name}...`);
        const result = await runBenchmark(benchmark, options?.stateDir);
        console.log(
          `[benchmark] ${benchmark.name}: ${result.score.toFixed(3)}`
        );
        return result;
      })
    );
  } else {
    results = [];
    for (const benchmark of suite) {
      console.log(`[benchmark] Running: ${benchmark.name}...`);
      const result = await runBenchmark(benchmark, options?.stateDir);
      results.push(result);
      console.log(
        `[benchmark] ${benchmark.name}: ${result.score.toFixed(3)}`
      );
    }
  }

  for (const r of results) {
    totalCost += r.costUsd ?? 0;
  }

  // Weighted average
  let totalWeight = 0;
  let weightedSum = 0;
  for (let i = 0; i < suite.length; i++) {
    const result = results[i];
    const benchmark = suite[i];
    if (result && benchmark) {
      weightedSum += result.score * benchmark.weight;
      totalWeight += benchmark.weight;
    }
  }

  const totalScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  return { totalScore, results, totalCostUsd: totalCost };
}

// ── Persistence ──

function persistBenchmarkResult(
  stateDir: string,
  result: BenchmarkResult
): void {
  const dir = resolve(stateDir, "benchmarks");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, `${result.benchmarkId}.jsonl`);
  appendFileSync(filePath, JSON.stringify(result) + "\n");
}
