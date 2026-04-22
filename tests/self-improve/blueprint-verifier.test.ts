import { describe, it, expect } from "vitest";
import { verifyBlueprint } from "../../src/self-improve/blueprint-verifier.js";
import type { AgentBlueprint } from "../../src/state/project-state.js";

// 99 chars — well above the 51-char minimum enforced by the verifier.
const VALID_PROMPT =
  "You are an expert TypeScript developer. " +
  "Implement tasks carefully, run tests, and commit your work.";

function makeBlueprint(overrides: Partial<AgentBlueprint> = {}): AgentBlueprint {
  return {
    name: "test-agent",
    role: "test role",
    systemPrompt: VALID_PROMPT,
    tools: ["Read", "Write"],
    evaluationCriteria: ["correctness"],
    version: 1,
    ...overrides,
  };
}

describe("verifyBlueprint", () => {
  it("accepts a valid blueprint", () => {
    const result = verifyBlueprint(makeBlueprint());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.name).toBe("test-agent");
      expect(result.blueprint.systemPrompt).toBe(VALID_PROMPT);
    }
  });

  it("rejects when schema validation fails (missing required field)", () => {
    // Omit the `name` field — Zod's AgentBlueprintSchema rejects.
    const { name: _name, ...rest } = makeBlueprint();
    void _name;
    const result = verifyBlueprint(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/^schema_invalid:/);
    }
  });

  it("rejects when systemPrompt is too short", () => {
    const result = verifyBlueprint(makeBlueprint({ systemPrompt: "hi" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/^system_prompt_too_short: length=2 minimum=51$/);
    }
  });

  it("rejects when systemPrompt exceeds the 20_000-char upper bound", () => {
    const result = verifyBlueprint(
      makeBlueprint({ systemPrompt: "x".repeat(20_001) })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/^system_prompt_too_long: length=20001 maximum=20000$/);
    }
  });

  it("rejects when tools array is empty", () => {
    const result = verifyBlueprint(makeBlueprint({ tools: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("tools_empty");
    }
  });

  it("rejects disallowed tool names", () => {
    const result = verifyBlueprint(
      makeBlueprint({ tools: ["Read", "EvilTool"] })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("disallowed_tool: EvilTool");
    }
  });

  it("accepts mcp__-prefixed tool names", () => {
    const result = verifyBlueprint(
      makeBlueprint({ tools: ["mcp__playwright__navigate", "Read"] })
    );
    expect(result.ok).toBe(true);
  });

  it("rejects when name is whitespace-only", () => {
    const result = verifyBlueprint(makeBlueprint({ name: "   " }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("empty_name");
    }
  });
});
