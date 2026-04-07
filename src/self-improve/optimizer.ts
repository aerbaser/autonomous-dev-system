import type { Config } from "../utils/config.js";
import type {
  ProjectState,
  EvolutionEntry,
  AgentBlueprint,
} from "../state/project-state.js";
import { saveState } from "../state/project-state.js";
import { AgentRegistry } from "../agents/registry.js";
import {
  runAllBenchmarks,
  getDefaultBenchmarks,
  type BenchmarkResult,
} from "./benchmarks.js";
import { generateMutations, type Mutation } from "./mutation-engine.js";
import { randomUUID } from "node:crypto";
import {
  createConvergenceState,
  updateConvergence,
  hasConverged,
  getConvergenceReport,
  type ConvergenceConfig,
  DEFAULT_CONVERGENCE,
} from "./convergence.js";
import { savePromptVersion } from "./versioning.js";

interface OptimizerOptions {
  benchmarkId?: string;
  maxIterations: number;
  convergence?: Partial<ConvergenceConfig>;
  parallel?: boolean;
}

/**
 * Select the worst-performing agent based on recent benchmark results.
 * Falls back to round-robin if no performance data exists.
 */
function selectTargetAgent(
  registry: AgentRegistry,
  results: BenchmarkResult[],
  iteration: number
): AgentBlueprint {
  const agents = registry.getAll();
  if (agents.length === 0) {
    throw new Error("No agents registered");
  }

  // Try to pick the worst performer based on average historical score
  let worstAgent: AgentBlueprint | undefined;
  let worstScore = Infinity;

  for (const agent of agents) {
    const avgScore = registry.getAverageScore(agent.name);
    // Only consider agents with performance history
    if (avgScore > 0 && avgScore < worstScore) {
      worstScore = avgScore;
      worstAgent = agent;
    }
  }

  // Fall back to round-robin if no performance data
  if (!worstAgent) {
    return agents[iteration % agents.length];
  }

  return worstAgent;
}

export async function runOptimizer(
  state: ProjectState,
  config: Config,
  options: OptimizerOptions
): Promise<void> {
  const registry = new AgentRegistry(config.stateDir);
  let currentState = { ...state };
  let totalCostUsd = 0;

  // Merge convergence config
  const convergenceConfig: ConvergenceConfig = {
    ...DEFAULT_CONVERGENCE,
    ...options.convergence,
  };
  let convergenceState = createConvergenceState();

  console.log("[optimizer] Starting self-improvement loop...");
  console.log(`[optimizer] Max iterations: ${options.maxIterations}`);
  console.log(
    `[optimizer] Convergence: window=${convergenceConfig.windowSize}, ` +
      `minImprovement=${convergenceConfig.minImprovement}, ` +
      `maxStagnant=${convergenceConfig.maxStagnantIterations}`
  );
  console.log(
    `[optimizer] Current baseline score: ${currentState.baselineScore}`
  );

  // Step 1: Establish baseline
  console.log("\n[optimizer] Running baseline benchmarks...");
  const benchmarks = getDefaultBenchmarks().filter(
    (b) => !options.benchmarkId || b.id === options.benchmarkId
  );
  const {
    totalScore: baselineScore,
    results: baselineResults,
    totalCostUsd: baselineCost,
  } = await runAllBenchmarks(benchmarks, {
    parallel: options.parallel,
    stateDir: config.stateDir,
  });

  currentState.baselineScore = baselineScore;
  totalCostUsd += baselineCost;
  console.log(`[optimizer] Baseline score: ${baselineScore.toFixed(3)}`);

  // Record baseline performance for each agent
  for (const agent of registry.getAll()) {
    for (const result of baselineResults) {
      registry.recordPerformance(agent.name, {
        benchmarkId: result.benchmarkId,
        score: result.score,
        timestamp: result.timestamp,
      });
    }
  }

  // Save initial prompt versions
  for (const agent of registry.getAll()) {
    savePromptVersion(config.stateDir, agent);
  }

  // Update convergence with baseline
  convergenceState = updateConvergence(convergenceState, baselineScore);

  // Step 2: Optimization loop
  for (let iteration = 0; iteration < options.maxIterations; iteration++) {
    // Check convergence
    if (hasConverged(convergenceState, convergenceConfig)) {
      console.log("\n[optimizer] Convergence detected — stopping early.");
      console.log(getConvergenceReport(convergenceState));
      break;
    }

    console.log(
      `\n[optimizer] === Iteration ${iteration + 1}/${options.maxIterations} ===`
    );

    // Pick the worst-performing agent
    const targetAgent = selectTargetAgent(
      registry,
      baselineResults,
      iteration
    );
    console.log(`[optimizer] Target: ${targetAgent.name} (${targetAgent.role})`);

    // Generate mutations
    const mutations = await generateMutations(
      targetAgent,
      baselineResults,
      currentState.evolution
    );

    if (mutations.length === 0) {
      console.log("[optimizer] No mutations generated, skipping...");
      convergenceState = updateConvergence(
        convergenceState,
        currentState.baselineScore
      );
      continue;
    }

    for (const mutation of mutations) {
      console.log(`[optimizer] Testing mutation: ${mutation.description}`);

      // Apply mutation
      const mutatedBlueprint = mutation.apply();
      registry.register(mutatedBlueprint);

      // Re-run benchmarks
      const {
        totalScore: newScore,
        results: newResults,
        totalCostUsd: iterCost,
      } = await runAllBenchmarks(benchmarks, {
        parallel: options.parallel,
        stateDir: config.stateDir,
      });
      totalCostUsd += iterCost;

      // Record performance
      for (const result of newResults) {
        registry.recordPerformance(mutatedBlueprint.name, {
          benchmarkId: result.benchmarkId,
          score: result.score,
          timestamp: result.timestamp,
        });
      }

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

        // Save the new prompt version
        savePromptVersion(config.stateDir, mutatedBlueprint);

        console.log(
          `[optimizer] ACCEPTED: ${entry.scoreBefore.toFixed(3)} → ${newScore.toFixed(3)} (+${(newScore - entry.scoreBefore).toFixed(3)})`
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

      // Update convergence
      convergenceState = updateConvergence(
        convergenceState,
        currentState.baselineScore
      );
    }
  }

  // Summary
  const accepted = currentState.evolution.filter((e) => e.accepted).length;
  const total = currentState.evolution.length;
  console.log(`\n[optimizer] Optimization complete.`);
  console.log(`[optimizer] Mutations: ${accepted}/${total} accepted`);
  console.log(
    `[optimizer] Final score: ${currentState.baselineScore.toFixed(3)}`
  );
  console.log(`[optimizer] Total cost: $${totalCostUsd.toFixed(4)}`);
  console.log("\n[optimizer] Convergence report:");
  console.log(getConvergenceReport(convergenceState));
}
