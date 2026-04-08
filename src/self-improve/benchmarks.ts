import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  appendFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { runCommandInSandbox } from "./sandbox.js";
import type {
  BenchmarkTask,
  BenchmarkFixture,
  Benchmark,
  BenchmarkResult,
} from "./benchmark-types.js";

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

  for (const task of benchmark.tasks) {
    if (benchmark.verifier === "deterministic") {
      const score = await runDeterministicTask(task);
      taskScores.push(score);
    } else {
      const { score, costUsd } = await runLlmTask(task);
      taskScores.push(score);
      totalCost += costUsd;
    }
  }

  const avgScore =
    taskScores.length > 0
      ? taskScores.reduce((a, b) => a + b, 0) / taskScores.length
      : 0;

  const result: BenchmarkResult = {
    benchmarkId: benchmark.id,
    score: avgScore,
    details: { taskScores },
    timestamp: new Date().toISOString(),
    costUsd: totalCost,
  };

  // Persist result if stateDir provided
  if (stateDir) {
    persistBenchmarkResult(stateDir, result);
  }

  return result;
}

async function runDeterministicTask(task: BenchmarkTask): Promise<number> {
  const sandboxResult = await runCommandInSandbox(task.instruction, {
    timeoutMs: task.timeout,
    cwd: process.cwd(),
  });

  if (!sandboxResult.success) {
    console.log(
      `[benchmark] Deterministic task failed: ${sandboxResult.error ?? "unknown error"}`
    );
  }

  return sandboxResult.success ? 1.0 : 0.0;
}

async function runLlmTask(
  task: BenchmarkTask
): Promise<{ score: number; costUsd: number }> {
  let costUsd = 0;

  // Set up fixture directory if needed
  let fixtureCwd: string | undefined;
  if (task.fixture) {
    fixtureCwd = mkdtempSync(join(tmpdir(), "benchmark-"));
    for (const [filePath, content] of Object.entries(task.fixture.files)) {
      const absPath = resolve(fixtureCwd, filePath);
      const dir = resolve(absPath, "..");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(absPath, content);
    }

    if (task.fixture.setupCommand) {
      await runCommandInSandbox(task.fixture.setupCommand, {
        timeoutMs: 60_000,
        cwd: fixtureCwd,
      });
    }
  }

  // Step 1: Generate output
  let generatedOutput = "";
  const prompt = fixtureCwd
    ? `Working directory: ${fixtureCwd}\n\n${task.instruction}`
    : task.instruction;

  try {
    for await (const message of query({
      prompt,
      options: {
        allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        maxTurns: 15,
        ...(fixtureCwd ? { cwd: fixtureCwd } : {}),
      },
    })) {
      if (message.type === "result") {
        if (message.subtype === "success") {
          generatedOutput = message.result;
          costUsd += message.total_cost_usd;
        } else {
          console.log(
            `[benchmark] Agent error: ${message.errors?.join(", ")}`
          );
          costUsd += message.total_cost_usd;
        }
      } else if (
        message.type === "system" &&
        "subtype" in message &&
        message.subtype === "api_retry"
      ) {
        const retryMsg = message as Extract<SDKMessage, { subtype: "api_retry" }>;
        console.log(
          `[benchmark] API retry ${retryMsg.attempt}/${retryMsg.max_retries}`
        );
      }
    }
  } catch (err) {
    console.log(
      `[benchmark] Query failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!generatedOutput || !task.evaluationPrompt) {
    cleanupFixture(fixtureCwd);
    return { score: 0, costUsd };
  }

  // Step 2: Evaluate with LLM judge
  let evalResult = "";
  try {
    for await (const message of query({
      prompt: `${task.evaluationPrompt}

Output to evaluate:
---
${generatedOutput.slice(0, 5000)}
---

Respond with ONLY a single number between 0.0 and 1.0`,
      options: { maxTurns: 1 },
    })) {
      if (message.type === "result" && message.subtype === "success") {
        evalResult = message.result;
        costUsd += message.total_cost_usd;
      }
    }
  } catch (err) {
    console.log(
      `[benchmark] Evaluation query failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  cleanupFixture(fixtureCwd);

  const score = parseFloat(evalResult.trim());
  return {
    score: isNaN(score) ? 0 : Math.max(0, Math.min(1, score)),
    costUsd,
  };
}

function cleanupFixture(fixtureCwd: string | undefined): void {
  if (fixtureCwd && existsSync(fixtureCwd)) {
    try {
      rmSync(fixtureCwd, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
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
