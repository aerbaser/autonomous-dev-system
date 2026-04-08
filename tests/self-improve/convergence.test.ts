import { describe, it, expect } from "vitest";
import {
  createConvergenceState,
  updateConvergence,
  hasConverged,
  getConvergenceReport,
  DEFAULT_CONVERGENCE,
  type ConvergenceConfig,
  type ConvergenceState,
} from "../../src/self-improve/convergence.js";

describe("Convergence", () => {
  describe("createConvergenceState", () => {
    it("returns a fresh state with empty scores and -Infinity best", () => {
      const state = createConvergenceState();
      expect(state.scores).toEqual([]);
      expect(state.iterationsWithoutImprovement).toBe(0);
      expect(state.bestScore).toBe(-Infinity);
      expect(state.bestIteration).toBe(0);
    });
  });

  describe("updateConvergence", () => {
    it("records improvement when score exceeds best + minImprovement", () => {
      const state = createConvergenceState();
      const updated = updateConvergence(state, 0.5);

      expect(updated.scores).toEqual([0.5]);
      expect(updated.bestScore).toBe(0.5);
      expect(updated.bestIteration).toBe(1);
      expect(updated.iterationsWithoutImprovement).toBe(0);
    });

    it("increments stagnation counter when score does not improve enough", () => {
      let state = createConvergenceState();
      state = updateConvergence(state, 0.5);
      // Score within minImprovement (0.005) of best — not an improvement
      state = updateConvergence(state, 0.504);

      expect(state.iterationsWithoutImprovement).toBe(1);
      expect(state.bestScore).toBe(0.5);
    });

    it("resets stagnation counter on real improvement", () => {
      let state = createConvergenceState();
      state = updateConvergence(state, 0.5);
      state = updateConvergence(state, 0.5); // stagnant
      state = updateConvergence(state, 0.5); // stagnant
      expect(state.iterationsWithoutImprovement).toBe(2);

      // Now a real improvement
      state = updateConvergence(state, 0.51);
      expect(state.iterationsWithoutImprovement).toBe(0);
      expect(state.bestScore).toBe(0.51);
    });

    it("accumulates all scores in order", () => {
      let state = createConvergenceState();
      const values = [0.1, 0.3, 0.2, 0.5, 0.4];
      for (const v of values) {
        state = updateConvergence(state, v);
      }
      expect(state.scores).toEqual(values);
    });
  });

  describe("hasConverged", () => {
    it("never converges before minIterations", () => {
      const config: ConvergenceConfig = {
        ...DEFAULT_CONVERGENCE,
        minIterations: 5,
        maxStagnantIterations: 1,
      };

      let state = createConvergenceState();
      // Add 4 identical scores — stagnation is high but below minIterations
      for (let i = 0; i < 4; i++) {
        state = updateConvergence(state, 0.5);
      }

      expect(state.scores.length).toBe(4);
      expect(hasConverged(state, config)).toBe(false);
    });

    it("detects stagnation after maxStagnantIterations without improvement", () => {
      const config: ConvergenceConfig = {
        ...DEFAULT_CONVERGENCE,
        minIterations: 1,
        maxStagnantIterations: 3,
      };

      let state = createConvergenceState();
      state = updateConvergence(state, 0.5); // initial (improvement from -Inf)
      state = updateConvergence(state, 0.5); // stagnant 1
      state = updateConvergence(state, 0.5); // stagnant 2
      state = updateConvergence(state, 0.5); // stagnant 3

      expect(state.iterationsWithoutImprovement).toBe(3);
      expect(hasConverged(state, config)).toBe(true);
    });

    it("detects plateau when window scores are within minImprovement", () => {
      const config: ConvergenceConfig = {
        windowSize: 3,
        minImprovement: 0.01,
        maxStagnantIterations: 100, // disable stagnation check
        minIterations: 1,
      };

      let state = createConvergenceState();
      // All scores in the window differ by less than 0.01
      state = updateConvergence(state, 0.500);
      state = updateConvergence(state, 0.502);
      state = updateConvergence(state, 0.508);

      expect(hasConverged(state, config)).toBe(true);
    });

    it("does not converge when scores are still improving", () => {
      const config: ConvergenceConfig = {
        ...DEFAULT_CONVERGENCE,
        minIterations: 1,
      };

      let state = createConvergenceState();
      state = updateConvergence(state, 0.1);
      state = updateConvergence(state, 0.2);
      state = updateConvergence(state, 0.3);
      state = updateConvergence(state, 0.4);
      state = updateConvergence(state, 0.5);

      expect(hasConverged(state, config)).toBe(false);
    });

    it("returns false for empty state", () => {
      const state = createConvergenceState();
      expect(hasConverged(state)).toBe(false);
    });
  });

  describe("getConvergenceReport", () => {
    it("returns a message for empty state", () => {
      const state = createConvergenceState();
      const report = getConvergenceReport(state);
      expect(report).toBe("No iterations completed yet.");
    });

    it("includes iterations count and best score", () => {
      let state = createConvergenceState();
      state = updateConvergence(state, 0.5);
      state = updateConvergence(state, 0.7);

      const report = getConvergenceReport(state);
      expect(report).toContain("Iterations completed: 2");
      expect(report).toContain("Best score: 0.7000");
    });

    it("includes total improvement percentage", () => {
      let state = createConvergenceState();
      state = updateConvergence(state, 0.5);
      state = updateConvergence(state, 0.6);

      const report = getConvergenceReport(state);
      expect(report).toContain("Total improvement:");
      expect(report).toContain("+0.1000");
    });

    it("includes recent scores window", () => {
      let state = createConvergenceState();
      state = updateConvergence(state, 0.1);
      state = updateConvergence(state, 0.2);
      state = updateConvergence(state, 0.3);

      const report = getConvergenceReport(state);
      expect(report).toContain("Recent scores (last 3):");
      expect(report).toContain("0.1000");
      expect(report).toContain("0.2000");
      expect(report).toContain("0.3000");
    });

    it("includes current score and stagnation info", () => {
      let state = createConvergenceState();
      state = updateConvergence(state, 0.5);
      state = updateConvergence(state, 0.5);

      const report = getConvergenceReport(state);
      expect(report).toContain("Current score: 0.5000");
      expect(report).toContain("Iterations without improvement: 1");
    });
  });
});
