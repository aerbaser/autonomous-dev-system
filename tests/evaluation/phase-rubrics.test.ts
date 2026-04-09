import { describe, it, expect } from "vitest";
import { getPhaseRubric } from "../../src/evaluation/phase-rubrics.js";
import type { Phase } from "../../src/state/project-state.js";

describe("getPhaseRubric", () => {
  it("returns a rubric for development phase", () => {
    const rubric = getPhaseRubric("development");
    expect(rubric).not.toBeNull();
    expect(rubric!.name).toBe("development");
    expect(rubric!.criteria.length).toBeGreaterThan(0);
  });

  it("returns a rubric for testing phase", () => {
    const rubric = getPhaseRubric("testing");
    expect(rubric).not.toBeNull();
    expect(rubric!.name).toBe("testing");
  });

  it("returns a rubric for review phase", () => {
    const rubric = getPhaseRubric("review");
    expect(rubric).not.toBeNull();
    expect(rubric!.name).toBe("review");
  });

  it("returns a rubric for architecture phase", () => {
    const rubric = getPhaseRubric("architecture");
    expect(rubric).not.toBeNull();
    expect(rubric!.name).toBe("architecture");
  });

  it("returns null for ideation phase", () => {
    expect(getPhaseRubric("ideation")).toBeNull();
  });

  it("returns null for specification phase", () => {
    expect(getPhaseRubric("specification")).toBeNull();
  });

  it("returns null for staging phase", () => {
    expect(getPhaseRubric("staging")).toBeNull();
  });

  it("returns null for ab-testing phase", () => {
    expect(getPhaseRubric("ab-testing")).toBeNull();
  });

  it("returns null for analysis phase", () => {
    expect(getPhaseRubric("analysis")).toBeNull();
  });

  it("returns null for production phase", () => {
    expect(getPhaseRubric("production")).toBeNull();
  });

  it("returns null for monitoring phase", () => {
    expect(getPhaseRubric("monitoring")).toBeNull();
  });

  it("returns null for environment-setup phase", () => {
    expect(getPhaseRubric("environment-setup")).toBeNull();
  });

  it("criteria weights sum to 1 for development rubric", () => {
    const rubric = getPhaseRubric("development")!;
    const totalWeight = rubric.criteria.reduce((sum, c) => sum + c.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0);
  });

  it("criteria weights sum to 1 for testing rubric", () => {
    const rubric = getPhaseRubric("testing")!;
    const totalWeight = rubric.criteria.reduce((sum, c) => sum + c.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0);
  });

  it("criteria weights sum to 1 for review rubric", () => {
    const rubric = getPhaseRubric("review")!;
    const totalWeight = rubric.criteria.reduce((sum, c) => sum + c.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0);
  });

  it("criteria weights sum to 1 for architecture rubric", () => {
    const rubric = getPhaseRubric("architecture")!;
    const totalWeight = rubric.criteria.reduce((sum, c) => sum + c.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0);
  });

  it("all thresholds are between 0 and 1", () => {
    const phases: Phase[] = ["development", "testing", "review", "architecture"];
    for (const phase of phases) {
      const rubric = getPhaseRubric(phase);
      if (rubric) {
        for (const c of rubric.criteria) {
          expect(c.threshold).toBeGreaterThanOrEqual(0);
          expect(c.threshold).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
