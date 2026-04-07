import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentBlueprint, EvolutionEntry } from "../state/project-state.js";
import type { BenchmarkResult } from "./benchmarks.js";
import { randomUUID } from "node:crypto";

export interface Mutation {
  id: string;
  targetName: string;
  type: EvolutionEntry["type"];
  description: string;
  apply: () => AgentBlueprint;
  rollback: () => AgentBlueprint;
}

const MUTATION_PROMPT = `You are a Meta-Optimizer. Given an agent's current system prompt and its
benchmark performance, generate an improved version.

Analyze:
1. What aspects of the output scored poorly?
2. What instructions are missing or unclear?
3. What could be made more specific or actionable?

Rules:
- Keep the core identity and role intact
- Make surgical changes, not complete rewrites
- Each change should target a specific weakness
- Add concrete examples where the prompt is vague
- Remove instructions that didn't help or confused the agent

Output the COMPLETE improved system prompt. Nothing else.`;

export async function generateMutations(
  blueprint: AgentBlueprint,
  benchmarkResults: BenchmarkResult[],
  history: EvolutionEntry[]
): Promise<Mutation[]> {
  const recentHistory = history
    .filter((e) => e.target === blueprint.name)
    .slice(-5)
    .map((e) => `${e.accepted ? "ACCEPTED" : "REJECTED"}: ${e.diff} (score: ${e.scoreBefore} → ${e.scoreAfter})`)
    .join("\n");

  let resultText = "";
  for await (const message of query({
    prompt: `${MUTATION_PROMPT}

Agent: ${blueprint.name} (${blueprint.role})

Current system prompt:
---
${blueprint.systemPrompt}
---

Recent benchmark results:
${benchmarkResults.map((r) => `${r.benchmarkId}: ${r.score.toFixed(3)}`).join("\n")}

Recent mutation history (learn from past attempts):
${recentHistory || "No prior mutations"}

Generate an improved version of this agent's system prompt.`,
    options: { maxTurns: 3 },
  })) {
    if ("result" in message && typeof message.result === "string") {
      resultText = message.result;
    }
  }

  if (!resultText.trim()) return [];

  const newPrompt = resultText.trim();
  const originalPrompt = blueprint.systemPrompt;

  const mutation: Mutation = {
    id: randomUUID(),
    targetName: blueprint.name,
    type: "agent_prompt",
    description: `Optimized ${blueprint.name} system prompt based on benchmark feedback`,
    apply: () => ({
      ...blueprint,
      systemPrompt: newPrompt,
      version: blueprint.version + 1,
    }),
    rollback: () => ({
      ...blueprint,
      systemPrompt: originalPrompt,
    }),
  };

  return [mutation];
}
