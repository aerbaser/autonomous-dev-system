// Extracted type definitions for benchmarks

export interface BenchmarkTask {
  instruction: string;
  expectedOutput?: string;
  evaluationPrompt?: string;
  timeout: number;
  /** Optional fixture setup: creates a temp directory with files for the task */
  fixture?: BenchmarkFixture;
}

export interface BenchmarkFixture {
  files: Record<string, string>;
  /** Shell command to run after fixture setup (e.g. "npm install") */
  setupCommand?: string;
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
  costUsd: number;
}
