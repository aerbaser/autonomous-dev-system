import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { isApiRetry } from "../utils/shared.js";
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { runCommandInSandbox } from "./sandbox.js";
import type { BenchmarkFixture } from "./benchmarks.js";

// ── Types ──

export interface VerifierResult {
  score: number;
  costUsd: number;
}

export interface Verifier {
  type: "deterministic" | "llm";
  run(task: VerifierTask): Promise<VerifierResult>;
}

export interface VerifierTask {
  instruction: string;
  expectedOutput?: string;
  evaluationPrompt?: string;
  timeout: number;
  fixture?: BenchmarkFixture;
}

export interface LlmVerifierOptions {
  maxTurns?: number;
  maxOutputLength?: number;
}

// ── Deterministic verifier ──

export function createDeterministicVerifier(command?: string): Verifier {
  return {
    type: "deterministic",
    async run(task: VerifierTask): Promise<VerifierResult> {
      const cmd = command ?? task.instruction;

      if (!cmd.trim()) {
        return { score: 0, costUsd: 0 };
      }

      const sandboxResult = await runCommandInSandbox(cmd, {
        timeoutMs: task.timeout,
        cwd: process.cwd(),
      });

      if (!sandboxResult.success) {
        console.log(
          `[verifier] Deterministic task failed: ${sandboxResult.error ?? "unknown error"}`
        );
      }

      return { score: sandboxResult.success ? 1.0 : 0.0, costUsd: 0 };
    },
  };
}

// ── LLM verifier ──

export function createLlmVerifier(
  evaluationPrompt: string,
  options?: LlmVerifierOptions
): Verifier {
  const maxTurns = options?.maxTurns ?? 15;
  const maxOutputLength = options?.maxOutputLength ?? 5000;

  return {
    type: "llm",
    async run(task: VerifierTask): Promise<VerifierResult> {
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
        ? `You MUST work exclusively in this directory: ${fixtureCwd}\nAll file paths should be relative to or inside this directory.\n\n${task.instruction}`
        : task.instruction;

      try {
        for await (const message of query({
          prompt,
          options: {
            allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
            maxTurns,
          },
        })) {
          if (message.type === "result") {
            if (message.subtype === "success") {
              generatedOutput = message.result;
              costUsd += message.total_cost_usd;
            } else {
              console.log(
                `[verifier] Agent error: ${message.errors?.join(", ")}`
              );
              costUsd += message.total_cost_usd;
            }
          } else if (isApiRetry(message)) {
            console.log(
              `[verifier] API retry ${message.attempt}/${message.max_retries}`
            );
          }
        }
      } catch (err) {
        console.log(
          `[verifier] Query failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const evalPrompt = task.evaluationPrompt ?? evaluationPrompt;

      if (!generatedOutput || !evalPrompt) {
        cleanupFixture(fixtureCwd);
        return { score: 0, costUsd };
      }

      // Step 2: Evaluate with LLM judge
      let evalResult = "";
      try {
        for await (const message of query({
          prompt: `${evalPrompt}

Output to evaluate:
---
${generatedOutput.slice(0, maxOutputLength)}
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
          `[verifier] Evaluation query failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      cleanupFixture(fixtureCwd);

      const score = parseFloat(evalResult.trim());
      return {
        score: isNaN(score) ? 0 : Math.max(0, Math.min(1, score)),
        costUsd,
      };
    },
  };
}

// ── Helpers ──


function cleanupFixture(fixtureCwd: string | undefined): void {
  if (fixtureCwd && existsSync(fixtureCwd)) {
    try {
      rmSync(fixtureCwd, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}
