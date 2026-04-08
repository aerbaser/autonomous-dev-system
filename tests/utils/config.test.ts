import { describe, it, expect, afterEach } from "vitest";

const originalKey = process.env.ANTHROPIC_API_KEY;

describe("validateRequiredEnv", () => {
  afterEach(() => {
    // Restore original value after each test
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it("throws when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { validateRequiredEnv } = await import("../../src/utils/config.js");
    expect(() => validateRequiredEnv()).toThrow(
      "Missing required environment variable: ANTHROPIC_API_KEY"
    );
  });

  it("does not throw when ANTHROPIC_API_KEY is present", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const { validateRequiredEnv } = await import("../../src/utils/config.js");
    expect(() => validateRequiredEnv()).not.toThrow();
  });
});
