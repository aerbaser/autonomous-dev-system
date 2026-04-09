import { describe, it, expect } from "vitest";
import {
  computeWeightedScore,
  determineVerdict,
} from "../../src/evaluation/rubric.js";
import type {
  RubricCriterion,
  CriterionScore,
  Rubric,
  RubricResult,
} from "../../src/evaluation/rubric.js";

describe("Rubric Types", () => {
  it("constructs a valid RubricCriterion", () => {
    const criterion: RubricCriterion = {
      name: "compiles_cleanly",
      description: "Code compiles without errors",
      weight: 0.3,
      threshold: 0.8,
    };
    expect(criterion.name).toBe("compiles_cleanly");
    expect(criterion.weight).toBe(0.3);
    expect(criterion.threshold).toBe(0.8);
  });

  it("constructs a valid Rubric with multiple criteria", () => {
    const rubric: Rubric = {
      name: "development",
      description: "Development phase rubric",
      criteria: [
        { name: "a", description: "A", weight: 0.5, threshold: 0.7 },
        { name: "b", description: "B", weight: 0.5, threshold: 0.8 },
      ],
    };
    expect(rubric.criteria).toHaveLength(2);
  });

  it("constructs a valid RubricResult", () => {
    const result: RubricResult = {
      rubricName: "testing",
      scores: [
        { criterionName: "coverage", score: 0.9, passed: true, feedback: "Good" },
      ],
      verdict: "satisfied",
      overallScore: 0.9,
      summary: "All criteria met",
      iteration: 1,
    };
    expect(result.verdict).toBe("satisfied");
    expect(result.iteration).toBe(1);
  });
});

describe("computeWeightedScore", () => {
  const criteria: RubricCriterion[] = [
    { name: "a", description: "A", weight: 0.6, threshold: 0.7 },
    { name: "b", description: "B", weight: 0.4, threshold: 0.8 },
  ];

  it("computes correct weighted average", () => {
    const scores: CriterionScore[] = [
      { criterionName: "a", score: 1.0, passed: true, feedback: "Perfect" },
      { criterionName: "b", score: 0.5, passed: false, feedback: "Needs work" },
    ];
    // (1.0 * 0.6 + 0.5 * 0.4) / (0.6 + 0.4) = 0.8
    expect(computeWeightedScore(scores, criteria)).toBeCloseTo(0.8);
  });

  it("returns 0 for empty scores", () => {
    expect(computeWeightedScore([], criteria)).toBe(0);
  });

  it("handles single criterion", () => {
    const single: RubricCriterion[] = [
      { name: "only", description: "Only", weight: 1.0, threshold: 0.5 },
    ];
    const scores: CriterionScore[] = [
      { criterionName: "only", score: 0.75, passed: true, feedback: "OK" },
    ];
    expect(computeWeightedScore(scores, single)).toBeCloseTo(0.75);
  });

  it("handles scores with unknown criterion names (weight 0)", () => {
    const scores: CriterionScore[] = [
      { criterionName: "unknown", score: 1.0, passed: true, feedback: "?" },
    ];
    expect(computeWeightedScore(scores, criteria)).toBe(0);
  });
});

describe("determineVerdict", () => {
  it("returns 'satisfied' when all criteria pass", () => {
    const scores: CriterionScore[] = [
      { criterionName: "a", score: 0.9, passed: true, feedback: "Good" },
      { criterionName: "b", score: 0.85, passed: true, feedback: "Good" },
    ];
    expect(determineVerdict(scores)).toBe("satisfied");
  });

  it("returns 'needs_revision' when some criteria fail", () => {
    const scores: CriterionScore[] = [
      { criterionName: "a", score: 0.9, passed: true, feedback: "Good" },
      { criterionName: "b", score: 0.3, passed: false, feedback: "Bad" },
      { criterionName: "c", score: 0.8, passed: true, feedback: "OK" },
    ];
    expect(determineVerdict(scores)).toBe("needs_revision");
  });

  it("returns 'failed' when more than half criteria fail", () => {
    const scores: CriterionScore[] = [
      { criterionName: "a", score: 0.2, passed: false, feedback: "Bad" },
      { criterionName: "b", score: 0.1, passed: false, feedback: "Bad" },
      { criterionName: "c", score: 0.9, passed: true, feedback: "OK" },
    ];
    expect(determineVerdict(scores)).toBe("failed");
  });

  it("returns 'failed' when all criteria fail", () => {
    const scores: CriterionScore[] = [
      { criterionName: "a", score: 0.1, passed: false, feedback: "Bad" },
      { criterionName: "b", score: 0.2, passed: false, feedback: "Bad" },
    ];
    expect(determineVerdict(scores)).toBe("failed");
  });
});
