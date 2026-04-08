import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentBlueprint, EvolutionEntry } from "../state/project-state.js";
import type { BenchmarkResult } from "./benchmarks.js";
import { randomUUID } from "node:crypto";

export type MutationType =
  | "agent_prompt"
  | "tool_config"
  | "phase_logic"
  | "quality_threshold";

export interface Mutation {
  id: string;
  targetName: string;
  type: EvolutionEntry["type"];
  description: string;
  apply: () => AgentBlueprint;
  rollback: () => AgentBlueprint;
}

// ── Prompts for each mutation type ──

const PROMPT_MUTATION = `You are a Meta-Optimizer. Given an agent's current system prompt and its
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

const TOOL_CONFIG_MUTATION = `You are a Meta-Optimizer specializing in agent tool configuration.
Given an agent's current tools and benchmark results, suggest tool changes.

Analyze:
1. Which tasks failed because the agent lacked a needed tool?
2. Which tools are present but never useful for this agent's role?
3. What tools from this list could help: Read, Write, Edit, Bash, Glob, Grep, Agent, WebSearch, WebFetch, AskUserQuestion

Rules:
- Only suggest tools relevant to the agent's role
- Adding too many tools increases confusion — be selective
- If the agent scores poorly on research tasks, consider WebSearch/WebFetch
- If the agent scores poorly on code tasks, ensure Bash, Read, Write, Edit are present

Output a JSON array of tool names (strings). Nothing else.`;

const PHASE_LOGIC_MUTATION = `You are a Meta-Optimizer specializing in agent execution parameters.
Given an agent's current config and benchmark results, suggest parameter changes.

Consider adjusting:
- maxTurns: if benchmarks timeout, reduce; if output is incomplete, increase
- model: "opus" for complex tasks, "sonnet" for simpler/faster tasks, "haiku" for quick evaluations

Rules:
- maxTurns should be between 3 and 30
- Only suggest model changes if there's clear evidence it would help
- Consider cost: opus is expensive, haiku is cheap

Output JSON: { "maxTurns": number, "model": "opus" | "sonnet" | "haiku" }. Nothing else.`;

// ── Mutation type selection ──

function selectMutationType(history: EvolutionEntry[]): MutationType {
  const types: MutationType[] = [
    "agent_prompt",
    "tool_config",
    "phase_logic",
    "quality_threshold",
  ];

  // Count recent usage of each type (last 20 entries)
  const recent = history.slice(-20);
  const counts = new Map<string, number>();
  for (const type of types) {
    counts.set(type, 0);
  }
  for (const entry of recent) {
    const current = counts.get(entry.type) ?? 0;
    counts.set(entry.type, current + 1);
  }

  // Pick the least-explored type (with some randomness)
  const minCount = Math.min(...types.map((t) => counts.get(t) ?? 0));
  const leastUsed = types.filter((t) => (counts.get(t) ?? 0) === minCount);

  // Add weight toward prompt mutations (they're the most impactful)
  if (
    leastUsed.includes("agent_prompt") ||
    Math.random() < 0.4
  ) {
    return leastUsed.includes("agent_prompt")
      ? "agent_prompt"
      : leastUsed[Math.floor(Math.random() * leastUsed.length)] ?? "agent_prompt";
  }

  return leastUsed[Math.floor(Math.random() * leastUsed.length)] ?? "agent_prompt";
}

// ── Main mutation generator ──

export async function generateMutations(
  blueprint: AgentBlueprint,
  benchmarkResults: BenchmarkResult[],
  history: EvolutionEntry[]
): Promise<Mutation[]> {
  const mutationType = selectMutationType(history);
  console.log(`[mutation] Selected mutation type: ${mutationType}`);

  switch (mutationType) {
    case "agent_prompt":
      return generatePromptMutation(blueprint, benchmarkResults, history);
    case "tool_config":
      return generateToolConfigMutation(blueprint, benchmarkResults, history);
    case "phase_logic":
      return generatePhaseLogicMutation(blueprint, benchmarkResults, history);
    case "quality_threshold":
      return generateQualityThresholdMutation(
        blueprint,
        benchmarkResults,
        history
      );
  }
}

// ── Prompt mutation ──

async function generatePromptMutation(
  blueprint: AgentBlueprint,
  benchmarkResults: BenchmarkResult[],
  history: EvolutionEntry[]
): Promise<Mutation[]> {
  const recentHistory = formatHistory(blueprint.name, history);
  const benchmarkSummary = formatBenchmarks(benchmarkResults);

  let resultText = "";
  let costUsd = 0;

  try {
    for await (const message of query({
      prompt: `${PROMPT_MUTATION}

Agent: ${blueprint.name} (${blueprint.role})

Current system prompt:
---
${blueprint.systemPrompt}
---

Recent benchmark results:
${benchmarkSummary}

Recent mutation history (learn from past attempts):
${recentHistory || "No prior mutations"}

Generate an improved version of this agent's system prompt.`,
      options: { maxTurns: 3 },
    })) {
      if (message.type === "result") {
        if (message.subtype === "success") {
          resultText = message.result;
          costUsd = message.total_cost_usd;
        } else {
          console.log(
            `[mutation] Prompt mutation error: ${message.errors?.join(", ")}`
          );
        }
      } else if (isApiRetry(message)) {
        const retryMsg = message as Extract<SDKMessage, { subtype: "api_retry" }>;
        console.log(
          `[mutation] API retry ${retryMsg.attempt}/${retryMsg.max_retries}`
        );
      }
    }
  } catch (err) {
    console.log(
      `[mutation] Query failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }

  if (!resultText.trim()) return [];

  const newPrompt = resultText.trim();
  const originalPrompt = blueprint.systemPrompt;

  return [
    {
      id: randomUUID(),
      targetName: blueprint.name,
      type: "agent_prompt",
      description: `Optimized ${blueprint.name} system prompt based on benchmark feedback (cost: $${costUsd.toFixed(4)})`,
      apply: () => ({
        ...blueprint,
        systemPrompt: newPrompt,
        version: blueprint.version + 1,
      }),
      rollback: () => ({
        ...blueprint,
        systemPrompt: originalPrompt,
      }),
    },
  ];
}

// ── Tool config mutation ──

async function generateToolConfigMutation(
  blueprint: AgentBlueprint,
  benchmarkResults: BenchmarkResult[],
  history: EvolutionEntry[]
): Promise<Mutation[]> {
  const recentHistory = formatHistory(blueprint.name, history);
  const benchmarkSummary = formatBenchmarks(benchmarkResults);

  let resultText = "";

  try {
    for await (const message of query({
      prompt: `${TOOL_CONFIG_MUTATION}

Agent: ${blueprint.name} (${blueprint.role})
Current tools: ${JSON.stringify(blueprint.tools)}

Recent benchmark results:
${benchmarkSummary}

Recent mutation history:
${recentHistory || "No prior mutations"}

Suggest an updated tool list for this agent.`,
      options: { maxTurns: 1 },
    })) {
      if (message.type === "result" && message.subtype === "success") {
        resultText = message.result;
      }
    }
  } catch (err) {
    console.log(
      `[mutation] Tool config query failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }

  // Parse the tool list from the response
  let newTools: string[];
  try {
    const jsonMatch = resultText.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];
    newTools = JSON.parse(jsonMatch[0]) as string[];
    if (!Array.isArray(newTools) || newTools.length === 0) return [];
    // Validate all entries are strings
    newTools = newTools.filter((t): t is string => typeof t === "string");
  } catch {
    console.log("[mutation] Failed to parse tool config response");
    return [];
  }

  // Don't create a mutation if tools haven't changed
  const sortedOld = [...blueprint.tools].sort().join(",");
  const sortedNew = [...newTools].sort().join(",");
  if (sortedOld === sortedNew) return [];

  const originalTools = [...blueprint.tools];

  return [
    {
      id: randomUUID(),
      targetName: blueprint.name,
      type: "tool_config",
      description: `Updated ${blueprint.name} tools: [${originalTools.join(", ")}] → [${newTools.join(", ")}]`,
      apply: () => ({
        ...blueprint,
        tools: newTools,
        version: blueprint.version + 1,
      }),
      rollback: () => ({
        ...blueprint,
        tools: originalTools,
      }),
    },
  ];
}

// ── Phase logic mutation ──

async function generatePhaseLogicMutation(
  blueprint: AgentBlueprint,
  benchmarkResults: BenchmarkResult[],
  history: EvolutionEntry[]
): Promise<Mutation[]> {
  const recentHistory = formatHistory(blueprint.name, history);
  const benchmarkSummary = formatBenchmarks(benchmarkResults);

  let resultText = "";

  try {
    for await (const message of query({
      prompt: `${PHASE_LOGIC_MUTATION}

Agent: ${blueprint.name} (${blueprint.role})
Current model: ${blueprint.model ?? "default (sonnet)"}

Recent benchmark results:
${benchmarkSummary}

Recent mutation history:
${recentHistory || "No prior mutations"}

Suggest updated execution parameters.`,
      options: { maxTurns: 1 },
    })) {
      if (message.type === "result" && message.subtype === "success") {
        resultText = message.result;
      }
    }
  } catch (err) {
    console.log(
      `[mutation] Phase logic query failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }

  // Parse the JSON response
  let params: { maxTurns?: number; model?: "opus" | "sonnet" | "haiku" };
  try {
    const jsonMatch = resultText.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return [];
    params = JSON.parse(jsonMatch[0]) as typeof params;
  } catch {
    console.log("[mutation] Failed to parse phase logic response");
    return [];
  }

  const originalModel = blueprint.model;
  const newModel = params.model ?? blueprint.model;

  // Only create mutation if something changed
  if (newModel === originalModel) return [];

  return [
    {
      id: randomUUID(),
      targetName: blueprint.name,
      type: "phase_logic",
      description: `Updated ${blueprint.name} model: ${originalModel ?? "default"} → ${newModel ?? "default"}`,
      apply: () => ({
        ...blueprint,
        model: newModel,
        version: blueprint.version + 1,
      }),
      rollback: () => ({
        ...blueprint,
        model: originalModel,
      }),
    },
  ];
}

// ── Quality threshold mutation ──

async function generateQualityThresholdMutation(
  blueprint: AgentBlueprint,
  benchmarkResults: BenchmarkResult[],
  history: EvolutionEntry[]
): Promise<Mutation[]> {
  // Quality threshold mutations adjust the evaluation criteria weights
  // by analyzing which criteria the agent consistently fails on.

  const poorBenchmarks = benchmarkResults.filter((r) => r.score < 0.5);
  if (poorBenchmarks.length === 0) {
    console.log("[mutation] All benchmarks above threshold, skipping quality mutation");
    return [];
  }

  // Build new evaluation criteria that emphasize weak areas
  const weakAreas = poorBenchmarks.map((r) => r.benchmarkId);
  const enhancedCriteria = [...blueprint.evaluationCriteria];

  // Add emphasis to criteria related to weak benchmarks
  for (const area of weakAreas) {
    const emphasis = `PRIORITY: Improve performance on ${area} benchmarks — currently scoring below 50%`;
    if (!enhancedCriteria.includes(emphasis)) {
      enhancedCriteria.push(emphasis);
    }
  }

  // Don't create mutation if criteria haven't changed
  if (enhancedCriteria.length === blueprint.evaluationCriteria.length) return [];

  const originalCriteria = [...blueprint.evaluationCriteria];

  return [
    {
      id: randomUUID(),
      targetName: blueprint.name,
      type: "quality_threshold",
      description: `Enhanced ${blueprint.name} evaluation criteria to emphasize weak areas: ${weakAreas.join(", ")}`,
      apply: () => ({
        ...blueprint,
        evaluationCriteria: enhancedCriteria,
        version: blueprint.version + 1,
      }),
      rollback: () => ({
        ...blueprint,
        evaluationCriteria: originalCriteria,
      }),
    },
  ];
}

// ── Helpers ──

function formatHistory(agentName: string, history: EvolutionEntry[]): string {
  return history
    .filter((e) => e.target === agentName)
    .slice(-5)
    .map(
      (e) =>
        `${e.accepted ? "ACCEPTED" : "REJECTED"} [${e.type}]: ${e.diff} (score: ${e.scoreBefore} → ${e.scoreAfter})`
    )
    .join("\n");
}

function formatBenchmarks(results: BenchmarkResult[]): string {
  return results
    .map((r) => `${r.benchmarkId}: ${r.score.toFixed(3)}`)
    .join("\n");
}

function isApiRetry(
  message: SDKMessage
): message is Extract<SDKMessage, { subtype: "api_retry" }> {
  return message.type === "system" && "subtype" in message && (message as Record<string, unknown>).subtype === "api_retry";
}
