import type { Config } from "../utils/config.js";
import type { ProjectState, EvolutionEntry } from "../state/project-state.js";
import { saveState } from "../state/project-state.js";
import { AgentRegistry } from "../agents/registry.js";
import { runAllBenchmarks, getDefaultBenchmarks, type BenchmarkResult } from "./benchmarks.js";
import { generateMutations, type Mutation } from "./mutation-engine.js";
import { randomUUID } from "node:crypto";

interface OptimizerOptions {
  benchmarkId?: string;
  maxIterations: number;
}

export async function runOptimizer(
  state: ProjectState,
  config: Config,
  options: OptimizerOptions
): Promise<void> {
  const registry = new AgentRegistry(config.stateDir);
  let currentState = { ...state };

  console.log("[optimizer] Starting self-improvement loop...");
  console.log(`[optimizer] Max iterations: ${options.maxIterations}`);
  console.log(`[optimizer] Current baseline score: ${currentState.baselineScore}`);

  // Step 1: Establish baseline
  console.log("\n[optimizer] Running baseline benchmarks...");
  const benchmarks = getDefaultBenchmarks().filter(
    (b) => !options.benchmarkId || b.id === options.benchmarkId
  );
  const { totalScore: baselineScore, results: baselineResults } =
    await runAllBenchmarks(benchmarks);

  currentState.baselineScore = baselineScore;
  console.log(`[optimizer] Baseline score: ${baselineScore.toFixed(3)}`);

  // Step 2: Optimization loop
  for (let iteration = 0; iteration < options.maxIterations; iteration++) {
    console.log(`\n[optimizer] === Iteration ${iteration + 1}/${options.maxIterations} ===`);

    // Pick an agent to optimize (round-robin or worst-performing)
    const agents = registry.getAll();
    const targetAgent = agents[iteration % agents.length];

    console.log(`[optimizer] Target: ${targetAgent.name} (${targetAgent.role})`);

    // Generate mutations
    const mutations = await generateMutations(
      targetAgent,
      baselineResults,
      currentState.evolution
    );

    if (mutations.length === 0) {
      console.log("[optimizer] No mutations generated, skipping...");
      continue;
    }

    for (const mutation of mutations) {
      console.log(`[optimizer] Testing mutation: ${mutation.description}`);

      // Apply mutation
      const mutatedBlueprint = mutation.apply();
      registry.register(mutatedBlueprint);

      // Re-run benchmarks
      const { totalScore: newScore, results: newResults } =
        await runAllBenchmarks(benchmarks);

      const entry: EvolutionEntry = {
        id: randomUUID(),
        target: mutation.targetName,
        type: mutation.type,
        diff: mutation.description,
        scoreBefore: currentState.baselineScore,
        scoreAfter: newScore,
        accepted: false,
        timestamp: new Date().toISOString(),
      };

      if (newScore > currentState.baselineScore) {
        // Accept mutation
        entry.accepted = true;
        currentState.baselineScore = newScore;
        console.log(
          `[optimizer] ACCEPTED: ${currentState.baselineScore.toFixed(3)} → ${newScore.toFixed(3)} (+${(newScore - entry.scoreBefore).toFixed(3)})`
        );
      } else {
        // Reject mutation — rollback
        const rolledBack = mutation.rollback();
        registry.register(rolledBack);
        console.log(
          `[optimizer] REJECTED: ${newScore.toFixed(3)} <= ${currentState.baselineScore.toFixed(3)}`
        );
      }

      currentState.evolution.push(entry);
      registry.save();
      saveState(config.stateDir, currentState);
    }
  }

  // Summary
  const accepted = currentState.evolution.filter((e) => e.accepted).length;
  const total = currentState.evolution.length;
  console.log(`\n[optimizer] Optimization complete.`);
  console.log(`[optimizer] Mutations: ${accepted}/${total} accepted`);
  console.log(`[optimizer] Final score: ${currentState.baselineScore.toFixed(3)}`);
}
