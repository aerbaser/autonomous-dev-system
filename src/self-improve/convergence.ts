export interface ConvergenceConfig {
  /** Number of recent iterations to consider */
  windowSize: number;
  /** Minimum score delta to consider "improving" */
  minImprovement: number;
  /** Stop after this many iterations without improvement */
  maxStagnantIterations: number;
  /** Always run at least this many iterations */
  minIterations: number;
}

export const DEFAULT_CONVERGENCE: ConvergenceConfig = {
  windowSize: 5,
  minImprovement: 0.005, // 0.5% improvement threshold
  maxStagnantIterations: 10,
  minIterations: 3,
};

export interface ConvergenceState {
  scores: number[];
  iterationsWithoutImprovement: number;
  bestScore: number;
  bestIteration: number;
}

export function createConvergenceState(): ConvergenceState {
  return {
    scores: [],
    iterationsWithoutImprovement: 0,
    bestScore: -Infinity,
    bestIteration: 0,
  };
}

export function updateConvergence(
  state: ConvergenceState,
  newScore: number
): ConvergenceState {
  const updatedScores = [...state.scores, newScore];
  const iteration = updatedScores.length;

  const improved = newScore > state.bestScore + DEFAULT_CONVERGENCE.minImprovement;

  return {
    scores: updatedScores,
    iterationsWithoutImprovement: improved
      ? 0
      : state.iterationsWithoutImprovement + 1,
    bestScore: improved ? newScore : state.bestScore,
    bestIteration: improved ? iteration : state.bestIteration,
  };
}

export function hasConverged(
  state: ConvergenceState,
  config: ConvergenceConfig = DEFAULT_CONVERGENCE
): boolean {
  // Always run minimum iterations
  if (state.scores.length < config.minIterations) {
    return false;
  }

  // Stagnation check: too many iterations without improvement
  if (state.iterationsWithoutImprovement >= config.maxStagnantIterations) {
    return true;
  }

  // Window-based trend check: look at the last windowSize scores
  if (state.scores.length >= config.windowSize) {
    const window = state.scores.slice(-config.windowSize);
    const windowMin = Math.min(...window);
    const windowMax = Math.max(...window);
    const range = windowMax - windowMin;

    // If all scores in the window are within minImprovement of each other,
    // the optimizer has plateaued
    if (range < config.minImprovement) {
      return true;
    }
  }

  return false;
}

export function getConvergenceReport(state: ConvergenceState): string {
  if (state.scores.length === 0) {
    return "No iterations completed yet.";
  }

  const lines: string[] = [];
  lines.push(`Iterations completed: ${state.scores.length}`);
  lines.push(`Best score: ${state.bestScore.toFixed(4)} (iteration ${state.bestIteration})`);
  lines.push(`Current score: ${state.scores[state.scores.length - 1].toFixed(4)}`);
  lines.push(
    `Iterations without improvement: ${state.iterationsWithoutImprovement}`
  );

  if (state.scores.length >= 2) {
    const first = state.scores[0];
    const last = state.scores[state.scores.length - 1];
    const totalDelta = last - first;
    lines.push(
      `Total improvement: ${totalDelta >= 0 ? "+" : ""}${totalDelta.toFixed(4)} (${((totalDelta / Math.max(Math.abs(first), 0.0001)) * 100).toFixed(1)}%)`
    );
  }

  // Show recent window trend
  const windowSize = Math.min(5, state.scores.length);
  const window = state.scores.slice(-windowSize);
  lines.push(
    `Recent scores (last ${windowSize}): [${window.map((s) => s.toFixed(4)).join(", ")}]`
  );

  return lines.join("\n");
}
