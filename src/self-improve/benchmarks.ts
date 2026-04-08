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
  type Verifier,
} from "./verifiers.js";
import type {
  BenchmarkTask,
  BenchmarkFixture,
  Benchmark,
  BenchmarkResult,
} from "./benchmark-types.js";

// Re-export verifier types for backward compatibility
export {
  createDeterministicVerifier,
  createLlmVerifier,
  type Verifier,
  type VerifierResult,
  type VerifierTask,
  type LlmVerifierOptions,
} from "./verifiers.js";

// Re-export types for backwards compatibility
export type { BenchmarkTask, BenchmarkFixture, Benchmark, BenchmarkResult } from "./benchmark-types.js";

// ── Fixtures ──

const CODE_QUALITY_FIXTURE: BenchmarkFixture = {
  files: {
    "package.json": JSON.stringify(
      {
        name: "benchmark-project",
        version: "1.0.0",
        type: "module",
        scripts: {
          build: "tsc --noEmit",
          test: "node --test src/**/*.test.ts",
        },
        devDependencies: {
          typescript: "^5.0.0",
          "@types/node": "^20.0.0",
        },
      },
      null,
      2
    ),
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "Node16",
          moduleResolution: "Node16",
          strict: true,
          outDir: "dist",
          rootDir: "src",
        },
        include: ["src/**/*"],
      },
      null,
      2
    ),
    "src/utils.ts": [
      'export function hashPassword(password: string): string {',
      '  // placeholder — agent should replace with proper hashing',
      '  return password;',
      '}',
      '',
      'export function validateEmail(email: string): boolean {',
      '  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);',
      '}',
    ].join("\n"),
  },
};

const TEST_GENERATION_FIXTURE: BenchmarkFixture = {
  files: {
    "package.json": JSON.stringify(
      {
        name: "test-gen-benchmark",
        version: "1.0.0",
        type: "module",
        scripts: { test: "node --test src/**/*.test.ts" },
      },
      null,
      2
    ),
    "src/cart.ts": [
      "export interface CartItem {",
      "  id: string;",
      "  name: string;",
      "  price: number;",
      "  quantity: number;",
      "}",
      "",
      "export class ShoppingCart {",
      "  private items: CartItem[] = [];",
      "",
      "  add(item: CartItem): void {",
      "    const existing = this.items.find((i) => i.id === item.id);",
      "    if (existing) {",
      "      existing.quantity += item.quantity;",
      "    } else {",
      "      this.items.push({ ...item });",
      "    }",
      "  }",
      "",
      "  remove(id: string): boolean {",
      "    const idx = this.items.findIndex((i) => i.id === id);",
      "    if (idx === -1) return false;",
      "    this.items.splice(idx, 1);",
      "    return true;",
      "  }",
      "",
      "  applyDiscount(percentage: number): void {",
      "    if (percentage < 0 || percentage > 100) {",
      '      throw new Error("Discount must be between 0 and 100");',
      "    }",
      "    const multiplier = 1 - percentage / 100;",
      "    for (const item of this.items) {",
      "      item.price = Math.round(item.price * multiplier * 100) / 100;",
      "    }",
      "  }",
      "",
      "  getTotal(): number {",
      "    return this.items.reduce((sum, i) => sum + i.price * i.quantity, 0);",
      "  }",
      "",
      "  getItems(): ReadonlyArray<Readonly<CartItem>> {",
      "    return this.items;",
      "  }",
      "",
      "  clear(): void {",
      "    this.items = [];",
      "  }",
      "",
      "  checkout(): { items: CartItem[]; total: number } {",
      "    if (this.items.length === 0) {",
      '      throw new Error("Cannot checkout empty cart");',
      "    }",
      "    const result = { items: [...this.items], total: this.getTotal() };",
      "    this.clear();",
      "    return result;",
      "  }",
      "}",
    ].join("\n"),
  },
};

// ── External benchmark loader ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getBenchmarksDir(): string {
  // Resolve to <project-root>/benchmarks/ regardless of whether running from src/ or dist/
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
    // Fall back to inline default
    const defaults = getDefaultBenchmarks();
    return defaults.find((b) => b.id === benchmarkId) ?? null;
  }

  try {
    const raw = readFileSync(tasksPath, "utf-8");
    const data = JSON.parse(raw) as ExternalBenchmarkFile;
    return {
      id: data.id,
      name: data.name,
      tasks: data.tasks,
      verifier: data.verifier,
      weight: data.weight,
    };
  } catch (err) {
    console.log(
      `[benchmark] Failed to load ${tasksPath}: ${err instanceof Error ? err.message : String(err)}`
    );
    // Fall back to inline default
    const defaults = getDefaultBenchmarks();
    return defaults.find((b) => b.id === benchmarkId) ?? null;
  }
}

// ── Default benchmarks ──

export function getDefaultBenchmarks(): Benchmark[] {
  return [
    {
      id: "code-quality",
      name: "Generated Code Quality",
      tasks: [
        {
          instruction:
            "In the project directory, implement a REST API endpoint handler function in src/register.ts for user registration. " +
            "It should validate email format, require passwords of 8+ characters, hash the password (use the hashPassword utility from src/utils.ts — improve it to use crypto.scrypt), " +
            "and return structured JSON responses with appropriate status codes. Include error handling for duplicate emails.",
          evaluationPrompt:
            "Rate this code on a 0-1 scale for: correctness (does it compile and handle all cases), " +
            "security (proper password hashing, no plaintext storage), error handling (all failure modes covered), " +
            "code structure (clean, modular, readable). Average the four sub-scores.",
          timeout: 120_000,
          fixture: CODE_QUALITY_FIXTURE,
        },
        {
          instruction:
            "Write a function in src/rate-limiter.ts that implements rate limiting using a sliding window algorithm. " +
            "The function should accept (key: string, windowMs: number, maxRequests: number) and return { allowed: boolean, remaining: number, retryAfterMs: number }. " +
            "Use an in-memory Map for storage. Handle edge cases: first request, window expiry, concurrent keys.",
          evaluationPrompt:
            "Rate this code 0-1: algorithm correctness (proper sliding window, not fixed window), " +
            "edge case handling (first request, expiry, boundary), performance (O(1) or O(log n) lookup), " +
            "readability (clear naming, comments only where needed). Average the four sub-scores.",
          timeout: 120_000,
          fixture: CODE_QUALITY_FIXTURE,
        },
      ],
      verifier: "llm",
      weight: 0.3,
    },
    {
      id: "test-generation",
      name: "Test Generation Quality",
      tasks: [
        {
          instruction:
            "Read src/cart.ts and write comprehensive tests in src/cart.test.ts using Node.js built-in test runner (node:test). " +
            "Cover: adding items, removing items, applying discounts, checkout flow, error cases (empty cart checkout, invalid discount), " +
            "edge cases (negative quantities, zero prices, duplicate item IDs).",
          evaluationPrompt:
            "Rate test quality 0-1: coverage of happy paths (add/remove/discount/checkout all tested), " +
            "edge cases (empty cart, negative quantities, overflow, duplicate IDs), error paths (invalid discount, empty checkout), " +
            "test independence (each test is self-contained), clear naming (test names describe behavior). Average the five sub-scores.",
          timeout: 120_000,
          fixture: TEST_GENERATION_FIXTURE,
        },
      ],
      verifier: "llm",
      weight: 0.25,
    },
    {
      id: "spec-completeness",
      name: "Specification Completeness",
      tasks: [
        {
          instruction:
            "Create a product specification for a collaborative document editor (like Google Docs lite)",
          evaluationPrompt:
            "Rate spec quality 0-1: user story coverage, acceptance criteria specificity, " +
            "non-functional requirements, edge cases considered, domain analysis. Average the scores.",
          timeout: 120_000,
        },
      ],
      verifier: "llm",
      weight: 0.2,
    },
    {
      id: "architecture-quality",
      name: "Architecture Decisions",
      tasks: [
        {
          instruction:
            "Design the architecture for a real-time chat application supporting 10k concurrent users",
          evaluationPrompt:
            "Rate architecture 0-1: appropriate tech choices, scalability plan, component separation, " +
            "API design, data model, trade-off analysis. Average the scores.",
          timeout: 120_000,
        },
      ],
      verifier: "llm",
      weight: 0.15,
    },
    {
      id: "build-success",
      name: "Build and Lint Success",
      tasks: [
        {
          instruction: "npm run build",
          expectedOutput: "exit_code_0",
          timeout: 60_000,
        },
      ],
      verifier: "deterministic",
      weight: 0.1,
    },
  ];
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
      : createLlmVerifier("", {});

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

  // Persist result if stateDir provided
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
    // Run independent benchmarks concurrently
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
