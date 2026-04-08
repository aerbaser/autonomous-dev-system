import { describe, it, expect } from "vitest";
import {
  discoverPlugins,
  checkPluginConflicts,
  type PluginRecommendation,
} from "../../src/environment/plugin-manager.js";

describe("discoverPlugins", () => {
  it("returns TypeScript plugins for typescript stack", () => {
    const results = discoverPlugins(["TypeScript"], "web");

    const names = results.map((p) => p.name);
    expect(names).toContain("ts-dev-kit");
    expect(names).toContain("composure");
    // Every result must have required fields
    for (const plugin of results) {
      expect(plugin.name).toBeTruthy();
      expect(plugin.description).toBeTruthy();
      expect(plugin.installCommand).toBeTruthy();
    }
  });

  it("returns Python plugins for python stack", () => {
    const results = discoverPlugins(["Python"], "api");

    const names = results.map((p) => p.name);
    expect(names).toContain("python-lint");
    expect(names).toContain("pytest-runner");
  });

  it("deduplicates plugins when stack items overlap", () => {
    // Both "typescript" entries map to the same plugins — no dupes expected
    const results = discoverPlugins(["TypeScript", "typescript"], "web");
    const names = results.map((p) => p.name);
    const unique = new Set(names);
    expect(names.length).toBe(unique.size);
  });

  it("includes domain-specific plugins", () => {
    const results = discoverPlugins([], "machine-learning");
    const names = results.map((p) => p.name);
    expect(names).toContain("ml-experiment");
  });

  it("returns empty array for unknown stack and domain", () => {
    const results = discoverPlugins(["cobol"], "underwater-basket-weaving");
    expect(results).toEqual([]);
  });
});

describe("checkPluginConflicts", () => {
  it("detects hook overlaps between existing and new plugins", () => {
    const existing: PluginRecommendation[] = [
      {
        name: "ts-dev-kit",
        description: "TS toolkit",
        installCommand: "claude plugin install ts-dev-kit",
        hooks: ["on-save", "pre-commit"],
        skills: ["format-ts"],
      },
    ];

    const newPlugins: PluginRecommendation[] = [
      {
        name: "custom-formatter",
        description: "Custom format plugin",
        installCommand: "claude plugin install custom-formatter",
        hooks: ["pre-commit"],
        skills: ["format-custom"],
      },
    ];

    const report = checkPluginConflicts(existing, newPlugins);
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings[0]).toContain("pre-commit");
    expect(report.warnings[0]).toContain("custom-formatter");
    expect(report.warnings[0]).toContain("ts-dev-kit");
  });

  it("detects skill duplications", () => {
    const existing: PluginRecommendation[] = [
      {
        name: "plugin-a",
        description: "Plugin A",
        installCommand: "install-a",
        skills: ["lint-python", "format"],
      },
    ];

    const newPlugins: PluginRecommendation[] = [
      {
        name: "plugin-b",
        description: "Plugin B",
        installCommand: "install-b",
        skills: ["lint-python"],
      },
    ];

    const report = checkPluginConflicts(existing, newPlugins);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain("lint-python");
    expect(report.warnings[0]).toContain("plugin-b");
    expect(report.warnings[0]).toContain("plugin-a");
  });

  it("returns no warnings when there are no conflicts", () => {
    const existing: PluginRecommendation[] = [
      {
        name: "plugin-a",
        description: "Plugin A",
        installCommand: "install-a",
        hooks: ["on-save"],
        skills: ["format"],
      },
    ];

    const newPlugins: PluginRecommendation[] = [
      {
        name: "plugin-b",
        description: "Plugin B",
        installCommand: "install-b",
        hooks: ["post-deploy"],
        skills: ["deploy-check"],
      },
    ];

    const report = checkPluginConflicts(existing, newPlugins);
    expect(report.warnings).toHaveLength(0);
  });

  it("handles plugins without hooks or skills gracefully", () => {
    const existing: PluginRecommendation[] = [
      {
        name: "minimal",
        description: "Minimal plugin",
        installCommand: "install-minimal",
      },
    ];

    const newPlugins: PluginRecommendation[] = [
      {
        name: "also-minimal",
        description: "Also minimal",
        installCommand: "install-also",
      },
    ];

    const report = checkPluginConflicts(existing, newPlugins);
    expect(report.warnings).toHaveLength(0);
  });
});
