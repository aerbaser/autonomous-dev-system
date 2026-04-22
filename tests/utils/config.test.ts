import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { ConfigSchema, loadConfig } from "../../src/utils/config.js";

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

describe("SEC-08 Anthropic API key is never in Config", () => {
  const EXPECTED_CONFIG_KEYS = [
    "model",
    "subagentModel",
    "posthogApiKey",
    "githubToken",
    "slackWebhookUrl",
    "deployTarget",
    "selfImprove",
    "projectDir",
    "stateDir",
    "autonomousMode",
    "maxTurns",
    "budgetUsd",
    "dryRun",
    "quickMode",
    "confirmSpec",
    "memory",
    "codexSubagents",
    "rubrics",
    "maxParallelBatches",
    "roles",
    "retryPolicy",
    "developmentCoordinator",
    "auxiliaryProfile",
    "interactive",
  ].sort();

  it("ConfigSchema top-level keys match the expected set exactly", () => {
    const actual = Object.keys(ConfigSchema.shape).sort();
    expect(actual).toEqual(EXPECTED_CONFIG_KEYS);
  });

  it("ConfigSchema has no apiKey / anthropicApiKey / claudeApiKey field", () => {
    const keys = Object.keys(ConfigSchema.shape);
    expect(keys).not.toContain("apiKey");
    expect(keys).not.toContain("anthropicApiKey");
    expect(keys).not.toContain("anthropic_api_key");
    expect(keys).not.toContain("ANTHROPIC_API_KEY");
    expect(keys).not.toContain("claudeApiKey");
    expect(keys).not.toContain("claude_api_key");
  });

  it("loadConfig() does not leak process.env.ANTHROPIC_API_KEY into the Config object", () => {
    const sentinel = "sk-ant-SENTINEL-" + randomUUID();
    const prev = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = sentinel;
    try {
      const cfg = loadConfig();
      const serialized = JSON.stringify(cfg);
      expect(serialized).not.toContain(sentinel);
      expect(serialized).not.toContain("sk-ant-");
    } finally {
      if (prev === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = prev;
    }
  });

  it("loadConfig() ONLY reads third-party provider tokens from env (not Anthropic)", () => {
    const prevPh = process.env['POSTHOG_API_KEY'];
    const prevGh = process.env['GITHUB_TOKEN'];
    const prevSl = process.env['SLACK_WEBHOOK_URL'];
    const prevAn = process.env['ANTHROPIC_API_KEY'];
    process.env['POSTHOG_API_KEY'] = "ph-SENTINEL";
    process.env['GITHUB_TOKEN'] = "gh-SENTINEL";
    process.env['SLACK_WEBHOOK_URL'] = "https://hooks.slack.com/SENTINEL";
    process.env['ANTHROPIC_API_KEY'] = "sk-ant-should-not-propagate";
    try {
      const cfg = loadConfig();
      expect(cfg.posthogApiKey).toBe("ph-SENTINEL");
      expect(cfg.githubToken).toBe("gh-SENTINEL");
      expect(cfg.slackWebhookUrl).toBe("https://hooks.slack.com/SENTINEL");
      const serialized = JSON.stringify(cfg);
      expect(serialized).not.toContain("sk-ant-should-not-propagate");
    } finally {
      const restore = (name: string, val: string | undefined): void => {
        if (val === undefined) delete process.env[name];
        else process.env[name] = val;
      };
      restore('POSTHOG_API_KEY', prevPh);
      restore('GITHUB_TOKEN', prevGh);
      restore('SLACK_WEBHOOK_URL', prevSl);
      restore('ANTHROPIC_API_KEY', prevAn);
    }
  });
});
