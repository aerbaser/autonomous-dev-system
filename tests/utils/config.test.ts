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
});
