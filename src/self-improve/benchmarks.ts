import { execSync } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";

export interface BenchmarkTask {
  instruction: string;
  expectedOutput?: string;
  evaluationPrompt?: string;
  timeout: number;
}

export interface Benchmark {
  id: string;
  name: string;
  tasks: BenchmarkTask[];
  verifier: "deterministic" | "llm";
  weight: number;
}

export interface BenchmarkResult {
  benchmarkId: string;
  score: number;
  details: Record<string, unknown>;
  timestamp: string;
}

export function getDefaultBenchmarks(): Benchmark[] {
  return [
    {
      id: "code-quality",
      name: "Generated Code Quality",
      tasks: [
        {
          instruction: "Generate a REST API endpoint for user registration with validation, password hashing, and error handling",
          evaluationPrompt: "Rate this code on a 0-1 scale for: correctness, security (password handling), error handling, code structure. Average the scores.",
          timeout: 120_000,
        },
        {
          instruction: "Write a function that implements rate limiting using a sliding window algorithm",
          evaluationPrompt: "Rate this code 0-1: algorithm correctness, edge case handling, performance, readability.",
          timeout: 120_000,
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
          instruction: "Write comprehensive tests for a shopping cart module with add/remove/discount/checkout",
          evaluationPrompt: "Rate test quality 0-1: coverage of happy paths, edge cases (empty cart, negative quantities, overflow), error paths, test independence, clear naming.",
          timeout: 120_000,
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
          instruction: "Create a product specification for a collaborative document editor (like Google Docs lite)",
          evaluationPrompt: "Rate spec quality 0-1: user story coverage, acceptance criteria specificity, non-functional requirements, edge cases considered, domain analysis.",
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
          instruction: "Design the architecture for a real-time chat application supporting 10k concurrent users",
          evaluationPrompt: "Rate architecture 0-1: appropriate tech choices, scalability plan, component separation, API design, data model, trade-off analysis.",
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

export async function runBenchmark(benchmark: Benchmark): Promise<BenchmarkResult> {
  const taskScores: number[] = [];

  for (const task of benchmark.tasks) {
    if (benchmark.verifier === "deterministic") {
      const score = runDeterministicTask(task);
      taskScores.push(score);
    } else {
      const score = await runLlmTask(task);
      taskScores.push(score);
    }
  }

  const avgScore =
    taskScores.length > 0
      ? taskScores.reduce((a, b) => a + b, 0) / taskScores.length
      : 0;

  return {
    benchmarkId: benchmark.id,
    score: avgScore,
    details: { taskScores },
    timestamp: new Date().toISOString(),
  };
}

function runDeterministicTask(task: BenchmarkTask): number {
  try {
    execSync(task.instruction, { timeout: task.timeout, stdio: "pipe" });
    return 1.0;
  } catch {
    return 0.0;
  }
}

async function runLlmTask(task: BenchmarkTask): Promise<number> {
  // Step 1: Generate output
  let generatedOutput = "";
  for await (const message of query({
    prompt: task.instruction,
    options: {
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      maxTurns: 15,
    },
  })) {
    if ("result" in message && typeof message.result === "string") {
      generatedOutput = message.result;
    }
  }

  if (!generatedOutput || !task.evaluationPrompt) return 0;

  // Step 2: Evaluate with LLM judge
  let evalResult = "";
  for await (const message of query({
    prompt: `${task.evaluationPrompt}

Output to evaluate:
---
${generatedOutput.slice(0, 5000)}
---

Respond with ONLY a single number between 0.0 and 1.0`,
    options: { maxTurns: 1 },
  })) {
    if ("result" in message && typeof message.result === "string") {
      evalResult = message.result;
    }
  }

  const score = parseFloat(evalResult.trim());
  return isNaN(score) ? 0 : Math.max(0, Math.min(1, score));
}

export async function runAllBenchmarks(
  benchmarks?: Benchmark[]
): Promise<{ totalScore: number; results: BenchmarkResult[] }> {
  const suite = benchmarks ?? getDefaultBenchmarks();
  const results: BenchmarkResult[] = [];

  for (const benchmark of suite) {
    console.log(`[benchmark] Running: ${benchmark.name}...`);
    const result = await runBenchmark(benchmark);
    results.push(result);
    console.log(`[benchmark] ${benchmark.name}: ${result.score.toFixed(3)}`);
  }

  // Weighted average
  let totalWeight = 0;
  let weightedSum = 0;
  for (let i = 0; i < suite.length; i++) {
    weightedSum += results[i].score * suite[i].weight;
    totalWeight += suite[i].weight;
  }

  const totalScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  return { totalScore, results };
}
