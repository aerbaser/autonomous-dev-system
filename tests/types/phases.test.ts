import { describe, it, expect } from "vitest";
import { ALL_PHASES } from "../../src/types/phases.js";
import type { Phase } from "../../src/types/phases.js";

describe("ALL_PHASES", () => {
  it("contains the twelve phases in the expected lifecycle order", () => {
    expect(ALL_PHASES).toEqual([
      "ideation",
      "specification",
      "architecture",
      "environment-setup",
      "development",
      "testing",
      "review",
      "staging",
      "ab-testing",
      "analysis",
      "production",
      "monitoring",
    ]);
  });

  it("is declared `as const` so items narrow to the Phase string-literal union", () => {
    // `satisfies readonly Phase[]` on the source guarantees compile-time
    // membership; at runtime we just assert the tuple's first element narrows
    // to Phase.
    const first: Phase = ALL_PHASES[0]!;
    expect(first).toBe("ideation");
  });

  it("has no duplicate entries", () => {
    const set = new Set(ALL_PHASES);
    expect(set.size).toBe(ALL_PHASES.length);
  });
});
