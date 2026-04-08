import type { Config } from "../utils/config.js";
import type { ProjectState } from "../state/project-state.js";
import type { ConvergenceConfig } from "./convergence.js";
import { runOptimizerImpl } from "./optimizer-runner.js";

export interface OptimizerOptions {
  benchmarkId?: string;
  maxIterations: number;
  convergence?: Partial<ConvergenceConfig>;
  parallel?: boolean;
  /** When set, mutations are evaluated inside an isolated git worktree */
  worktreeIsolation?: {
    repoDir: string;
    timeoutMs?: number;
  };
}

export async function runOptimizer(
  state: ProjectState,
  config: Config,
  options: OptimizerOptions
): Promise<void> {
  return runOptimizerImpl(state, config, options);
}
