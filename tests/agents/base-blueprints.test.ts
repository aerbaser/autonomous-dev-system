import { describe, it, expect } from "vitest";
import { getBaseBlueprints, getBaseAgentNames } from "../../src/agents/base-blueprints.js";

describe("getBaseBlueprints", () => {
  it("returns an array of blueprints", () => {
    const blueprints = getBaseBlueprints();
    expect(Array.isArray(blueprints)).toBe(true);
    expect(blueprints.length).toBeGreaterThan(0);
  });

  it("each blueprint has required fields", () => {
    const blueprints = getBaseBlueprints();
    for (const bp of blueprints) {
      expect(bp.name).toBeTruthy();
      expect(typeof bp.name).toBe("string");
      expect(bp.role).toBeTruthy();
      expect(typeof bp.role).toBe("string");
      expect(bp.systemPrompt).toBeTruthy();
      expect(typeof bp.systemPrompt).toBe("string");
      expect(Array.isArray(bp.tools)).toBe(true);
      expect(Array.isArray(bp.evaluationCriteria)).toBe(true);
      expect(bp.version).toBe(1);
    }
  });

  it("includes product-manager blueprint", () => {
    const blueprints = getBaseBlueprints();
    const pm = blueprints.find((bp) => bp.name === "product-manager");
    expect(pm).toBeDefined();
    expect(pm!.role).toBe("Product Manager");
  });

  it("includes architect blueprint", () => {
    const blueprints = getBaseBlueprints();
    const architect = blueprints.find((bp) => bp.name === "architect");
    expect(architect).toBeDefined();
  });

  it("each blueprint has at least one evaluation criterion", () => {
    const blueprints = getBaseBlueprints();
    for (const bp of blueprints) {
      expect(bp.evaluationCriteria.length).toBeGreaterThan(0);
    }
  });

  it("blueprint names are kebab-case", () => {
    const blueprints = getBaseBlueprints();
    for (const bp of blueprints) {
      expect(bp.name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});

describe("getBaseAgentNames", () => {
  it("returns a Set", () => {
    const names = getBaseAgentNames();
    expect(names instanceof Set).toBe(true);
  });

  it("contains the same names as getBaseBlueprints", () => {
    const blueprints = getBaseBlueprints();
    const names = getBaseAgentNames();
    expect(names.size).toBe(blueprints.length);
    for (const bp of blueprints) {
      expect(names.has(bp.name)).toBe(true);
    }
  });

  it("returns the same Set instance on repeated calls (cached)", () => {
    const first = getBaseAgentNames();
    const second = getBaseAgentNames();
    expect(first).toBe(second);
  });
});
