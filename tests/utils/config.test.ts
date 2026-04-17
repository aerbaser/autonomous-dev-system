import { describe, it, expect } from "vitest";

describe("loadConfig", () => {
  it("can be imported without requiring ANTHROPIC_API_KEY", async () => {
    // The SDK authenticates through Claude Code CLI subscription — no API key needed.
    const { loadConfig } = await import("../../src/utils/config.js");
    expect(typeof loadConfig).toBe("function");
  });

  it("exposes sane defaults for optional codex-backed subagents", async () => {
    const { getCodexSubagentsConfig } = await import("../../src/utils/config.js");
    const codex = getCodexSubagentsConfig();

    expect(codex.enabled).toBe(false);
    expect(codex.model).toBe("gpt-5.4");
    expect(codex.reasoningEffort).toBe("xhigh");
    expect(codex.sandbox).toBe("workspace-write");
  });

  it("defaults auxiliaryProfile to 'minimal' (Phase 8)", async () => {
    const { ConfigSchema } = await import("../../src/utils/config.js");
    const cfg = ConfigSchema.parse({});
    expect(cfg.auxiliaryProfile).toBe("minimal");
  });

  it("defaults rubrics.enabled to false (Phase 3: debug tier)", async () => {
    const { ConfigSchema } = await import("../../src/utils/config.js");
    const cfg = ConfigSchema.parse({});
    expect(cfg.rubrics.enabled).toBe(false);
  });

  it("defaults developmentCoordinator.enabled to false (Phase 3)", async () => {
    const { ConfigSchema } = await import("../../src/utils/config.js");
    const cfg = ConfigSchema.parse({});
    expect(cfg.developmentCoordinator.enabled).toBe(false);
  });

  it("accepts debug/nightly auxiliary profiles", async () => {
    const { ConfigSchema } = await import("../../src/utils/config.js");
    expect(ConfigSchema.parse({ auxiliaryProfile: "debug" }).auxiliaryProfile).toBe("debug");
    expect(ConfigSchema.parse({ auxiliaryProfile: "nightly" }).auxiliaryProfile).toBe("nightly");
    expect(() => ConfigSchema.parse({ auxiliaryProfile: "bogus" })).toThrow();
  });
});

describe("resolveAuxiliaryFlags", () => {
  it("minimal profile turns everything off", async () => {
    const { ConfigSchema, resolveAuxiliaryFlags } = await import("../../src/utils/config.js");
    const cfg = ConfigSchema.parse({ auxiliaryProfile: "minimal", rubrics: { enabled: true } });
    const flags = resolveAuxiliaryFlags(cfg);
    expect(flags.rubric).toBe(false);
    expect(flags.memoryCapturePerTask).toBe(false);
    expect(flags.qualityFixRetry).toBe(false);
    expect(flags.verbose).toBe(false);
  });

  it("debug profile enables everything (rubric off only if explicitly false)", async () => {
    const { ConfigSchema, resolveAuxiliaryFlags } = await import("../../src/utils/config.js");
    const cfg = ConfigSchema.parse({ auxiliaryProfile: "debug" });
    const flags = resolveAuxiliaryFlags(cfg);
    expect(flags.memoryCapturePerTask).toBe(true);
    expect(flags.qualityFixRetry).toBe(true);
    expect(flags.verbose).toBe(true);
    // rubric defaults to false, so debug respects that; must flip rubrics.enabled explicitly
    expect(flags.rubric).toBe(false);
    const cfgWithRubric = ConfigSchema.parse({
      auxiliaryProfile: "debug",
      rubrics: { enabled: true },
    });
    expect(resolveAuxiliaryFlags(cfgWithRubric).rubric).toBe(true);
  });

  it("nightly profile enables rubric + qualityFix but not per-task memory", async () => {
    const { ConfigSchema, resolveAuxiliaryFlags } = await import("../../src/utils/config.js");
    const cfg = ConfigSchema.parse({ auxiliaryProfile: "nightly" });
    const flags = resolveAuxiliaryFlags(cfg);
    expect(flags.rubric).toBe(true);
    expect(flags.qualityFixRetry).toBe(true);
    expect(flags.memoryCapturePerTask).toBe(false);
  });
});
