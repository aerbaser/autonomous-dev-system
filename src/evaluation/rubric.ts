import type { Phase, ProjectState } from "../state/project-state.js";

// --- Core rubric types ---

export interface RubricCriterion {
  name: string;
  description: string;
  weight: number;     // 0-1, criteria weights should sum to 1
  threshold: number;  // 0-1, minimum score to pass this criterion
}

export interface Rubric {
  name: string;
  description: string;
  criteria: RubricCriterion[];
}

export interface CriterionScore {
  criterionName: string;
  score: number;        // 0-1
  passed: boolean;      // score >= criterion threshold
  feedback: string;     // specific gap or confirmation
}

export interface RubricResult {
  rubricName: string;
  scores: CriterionScore[];
  verdict: "satisfied" | "needs_revision" | "failed";
  overallScore: number;  // weighted average of scores
  summary: string;
  iteration: number;
}

export interface EvaluatedPhaseResult {
  success: boolean;
  nextPhase?: Phase;
  state: ProjectState;
  error?: string;
  sessionId?: string;
  costUsd?: number;
  rubricResult: RubricResult;
  totalIterations: number;
}

// --- Scoring helpers ---

export function computeWeightedScore(scores: CriterionScore[], criteria: RubricCriterion[]): number {
  if (scores.length === 0) return 0;

  let totalWeight = 0;
  let weightedSum = 0;

  for (const score of scores) {
    const criterion = criteria.find(c => c.name === score.criterionName);
    const weight = criterion?.weight ?? 0;
    weightedSum += score.score * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

export function determineVerdict(
  scores: CriterionScore[],
): "satisfied" | "needs_revision" | "failed" {
  const failedCount = scores.filter(s => !s.passed).length;

  // If more than half of criteria failed, it's a fundamental failure
  if (failedCount > scores.length / 2) return "failed";

  // If all passed, satisfied
  if (failedCount === 0) return "satisfied";

  // Some criteria failed — needs revision
  return "needs_revision";
}
