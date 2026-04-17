import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { savePromptVersion } from "../../src/self-improve/versioning.js";
import type { AgentBlueprint } from "../../src/state/project-state.js";

const TEST_DIR = join(tmpdir(), `ads-test-versioning-${process.pid}`);

function makeBlueprint(overrides: Partial<AgentBlueprint> = {}): AgentBlueprint {
  return {
    name: "test-agent",
    role: "tester",
    systemPrompt: "You are a test agent.",
    tools: ["Read"],
    evaluationCriteria: ["runs"],
    version: 1,
    ...overrides,
  };
}

describe("savePromptVersion", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("writes v{version}.md in the agent's evolution dir", () => {
    const bp = makeBlueprint({ version: 1 });
    savePromptVersion(TEST_DIR, bp);
    const filePath = join(TEST_DIR, "evolution", "agents", "test-agent", "v1.md");
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("<!-- version: 1 -->");
    expect(content).toContain("<!-- role: tester -->");
    expect(content).toContain("You are a test agent.");
  });

  it("bumps version number in the filename when the blueprint version increments", () => {
    savePromptVersion(TEST_DIR, makeBlueprint({ version: 1, systemPrompt: "v1 prompt" }));
    savePromptVersion(TEST_DIR, makeBlueprint({ version: 2, systemPrompt: "v2 prompt" }));
    savePromptVersion(TEST_DIR, makeBlueprint({ version: 3, systemPrompt: "v3 prompt" }));

    const base = join(TEST_DIR, "evolution", "agents", "test-agent");
    expect(existsSync(join(base, "v1.md"))).toBe(true);
    expect(existsSync(join(base, "v2.md"))).toBe(true);
    expect(existsSync(join(base, "v3.md"))).toBe(true);
    // Each snapshot preserves its own prompt (no cross-contamination).
    expect(readFileSync(join(base, "v1.md"), "utf8")).toContain("v1 prompt");
    expect(readFileSync(join(base, "v2.md"), "utf8")).toContain("v2 prompt");
    expect(readFileSync(join(base, "v3.md"), "utf8")).toContain("v3 prompt");
  });

  it("records the score when present and 'N/A' otherwise", () => {
    savePromptVersion(TEST_DIR, makeBlueprint({ version: 10, score: 0.875 }));
    savePromptVersion(TEST_DIR, makeBlueprint({ name: "other", version: 1 }));
    const scored = readFileSync(
      join(TEST_DIR, "evolution", "agents", "test-agent", "v10.md"),
      "utf8",
    );
    const unscored = readFileSync(
      join(TEST_DIR, "evolution", "agents", "other", "v1.md"),
      "utf8",
    );
    expect(scored).toContain("<!-- score: 0.875 -->");
    expect(unscored).toContain("<!-- score: N/A -->");
  });
});
