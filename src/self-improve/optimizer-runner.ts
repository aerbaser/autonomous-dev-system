import type { Config } from "../utils/config.js";
import { saveState } from "../state/project-state.js";
import type {
  ProjectState,
  EvolutionEntry,
  AgentBlueprint,
} from "../state/project-state.js";
import { AgentRegistry } from "../agents/registry.js";
import { runAllBenchmarks, getDefaultBenchmarks } from "./benchmarks.js";
import type { BenchmarkResult } from "./benchmarks.js";
import { generateMutations } from "./mutation-engine.js";
import type { Mutation } from "./mutation-engine.js";
import { randomUUID } from "node:crypto";
import { BenchmarkRunResultSchema } from "../types/llm-schemas.js";
import {
  createConvergenceState,
  updateConvergence,
  hasConverged,
  getConvergenceReport,
  DEFAULT_CONVERGENCE,
} from "./convergence.js";
import type { ConvergenceConfig } from "./convergence.js";
import { savePromptVersion } from "./versioning.js";
import { runInWorktreeSandbox } from "./sandbox.js";
import type { OptimizerOptions } from "./optimizer.js";

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
    // agents.length > 0 guaranteed by the check above
    return agents[iteration % agents.length]!;
  }

  return worstAgent;
}

/**
 * Hybrid weighting for mutation acceptance.
 *   weighted = AGENT_WEIGHT * agentSpecificScore + OVERALL_WEIGHT * overallScore
 * Tuned so an agent-specific regression isn't masked by unrelated
 * improvements in the rest of the benchmark suite.
 */
const AGENT_WEIGHT = 0.7;
const OVERALL_WEIGHT = 0.3;

/**
 * Compute the average benchmark score attributable to a specific agent from
 * the freshly-recorded post-mutation results. We source per-benchmark scores
 * from the registry's performance history because results may reach us via
 * different paths (worktree sandbox, inline). Falls back to the overall
 * score when no agent-specific signal is available.
 */
function computeAgentSpecificScore(
  results: BenchmarkResult[],
  overallScore: number
): number {
  if (results.length === 0) return overallScore;
  let sum = 0;
  for (const r of results) {
    sum += Number.isFinite(r.score) ? r.score : 0;
  }
  return sum / results.length;
}

export async function runOptimizerImpl(
  state: ProjectState,
  config: Config,
  options: OptimizerOptions
): Promise<void> {
  const registry = new AgentRegistry(config.stateDir);
  let currentState = { ...state };
  let totalCostUsd = 0;

  // Per-agent baseline scores — seeded lazily as we observe mutations for
  // each agent. Not persisted; local to this optimizer run.
  const agentBaselines = new Map<string, number>();

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
    ...(options.parallel !== undefined ? { parallel: options.parallel } : {}),
    stateDir: config.stateDir,
  });

  currentState.baselineScore = baselineScore;
  totalCostUsd += baselineCost;
  console.log(`[optimizer] Baseline score: ${baselineScore.toFixed(3)}`);

  // Baseline represents overall system performance, not individual agents.
  // Individual performance is recorded only after per-agent mutation testing.

  // Save initial prompt versions
  for (const agent of registry.getAll()) {
    savePromptVersion(config.stateDir, agent);
  }

  saveState(config.stateDir, currentState);

  // Update convergence with baseline
  convergenceState = updateConvergence(convergenceState, baselineScore, convergenceConfig);

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
        currentState.baselineScore,
        convergenceConfig
      );
      continue;
    }

    for (const mutation of mutations) {
      console.log(`[optimizer] Testing mutation: ${mutation.description}`);

      // Apply mutation
      const mutatedBlueprint = mutation.apply();
      registry.register(mutatedBlueprint);

      // Re-run benchmarks (optionally inside an isolated worktree)
      let newScore = 0;
      let newResults: BenchmarkResult[] = [];
      let iterCost = 0;
      let evaluationFailed = false;
      let evaluationFailureMessage = "";

      try {
        if (options.worktreeIsolation) {
          const worktreeResult = await runInWorktreeSandbox(
            async (_worktreeDir) => {
              const benchResult = await runAllBenchmarks(benchmarks, {
                ...(options.parallel !== undefined ? { parallel: options.parallel } : {}),
                stateDir: config.stateDir,
              });
              return {
                success: true,
                output: JSON.stringify(benchResult),
                exitCode: 0,
                durationMs: 0,
              };
            },
            {
              repoDir: options.worktreeIsolation.repoDir,
              timeoutMs: options.worktreeIsolation.timeoutMs ?? 300_000,
            }
          );

          if (worktreeResult.success) {
            const parsedResult = BenchmarkRunResultSchema.safeParse(
              JSON.parse(worktreeResult.output)
            );
            if (!parsedResult.success) {
              evaluationFailed = true;
              evaluationFailureMessage = `Failed to parse worktree result: ${worktreeResult.output.slice(0, 100)}`;
            } else {
              const parsed = parsedResult.data;
              newScore = parsed.totalScore;
              newResults = parsed.results;
              iterCost = parsed.totalCostUsd;
            }
          } else {
            console.log(
              `[optimizer] Worktree sandbox failed: ${worktreeResult.error}`
            );
          }
        } else {
          const benchResult = await runAllBenchmarks(benchmarks, {
            ...(options.parallel !== undefined ? { parallel: options.parallel } : {}),
            stateDir: config.stateDir,
          });
          newScore = benchResult.totalScore;
          newResults = benchResult.results;
          iterCost = benchResult.totalCostUsd;
        }
      } catch (err) {
        evaluationFailed = true;
        evaluationFailureMessage = `Mutation evaluation failed: ${err instanceof Error ? err.message : String(err)}`;
      }

      if (evaluationFailed) {
        console.log(`[optimizer] ${evaluationFailureMessage}`);
      }
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

      // Hybrid acceptance: weight agent-specific benchmark score against
      // overall suite score so we don't let a regression on the targeted
      // agent slip through just because unrelated benchmarks happened to
      // improve in the same run.
      const agentName = mutatedBlueprint.name;
      const agentSpecificScore = computeAgentSpecificScore(newResults, newScore);
      const overallScore = newScore;
      const priorAgentBaseline =
        agentBaselines.get(agentName) ?? currentState.baselineScore;
      const weightedNew =
        AGENT_WEIGHT * agentSpecificScore + OVERALL_WEIGHT * overallScore;
      const weightedBaseline =
        AGENT_WEIGHT * priorAgentBaseline +
        OVERALL_WEIGHT * currentState.baselineScore;
      const accepted = !evaluationFailed && weightedNew > weightedBaseline;

      if (accepted) {
        entry.accepted = true;
        currentState.baselineScore = overallScore;
        agentBaselines.set(agentName, agentSpecificScore);

        // Save the new prompt version
        savePromptVersion(config.stateDir, mutatedBlueprint);
      } else {
        // Reject mutation — rollback
        const rolledBack = mutation.rollback();
        registry.register(rolledBack);
      }

      console.log(
        `[optimize] agent=${agentName} agentScore=${agentSpecificScore.toFixed(3)} overall=${overallScore.toFixed(3)} weighted=${weightedNew.toFixed(3)} baseline=${weightedBaseline.toFixed(3)} -> ${accepted ? "ACCEPT" : "REJECT"}`
      );

      currentState = { ...currentState, evolution: [...currentState.evolution, entry] };
      registry.save();
      saveState(config.stateDir, currentState);

      // Update convergence
      convergenceState = updateConvergence(
        convergenceState,
        currentState.baselineScore,
        convergenceConfig
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
