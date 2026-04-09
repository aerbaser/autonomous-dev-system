import { describe, it, expect } from "vitest";

describe("loadConfig", () => {
  it("can be imported without requiring ANTHROPIC_API_KEY", async () => {
    // The SDK authenticates through Claude Code CLI subscription — no API key needed.
    const { loadConfig } = await import("../../src/utils/config.js");
    expect(typeof loadConfig).toBe("function");
  });
});
