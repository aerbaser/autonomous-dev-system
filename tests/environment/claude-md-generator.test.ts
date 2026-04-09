import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateClaudeMd } from "../../src/environment/claude-md-generator.js";
import type { ArchDesign, DomainAnalysis, StackEnvironment } from "../../src/state/project-state.js";

const TEST_DIR = join(tmpdir(), `ads-test-claudemd-${process.pid}`);

function makeArch(): ArchDesign {
  return {
    techStack: { language: "TypeScript", framework: "Next.js", database: "PostgreSQL" },
    components: ["frontend", "api", "db"],
    apiContracts: "REST",
    databaseSchema: "tasks table",
    fileStructure: "src/\n  app/",
  };
}

function makeDomain(): DomainAnalysis {
  return {
    classification: "productivity",
    specializations: ["task management", "collaboration"],
    requiredRoles: [],
    requiredMcpServers: ["playwright"],
    techStack: ["typescript"],
  };
}

function makeEnvironment(overrides?: Partial<StackEnvironment>): StackEnvironment {
  return {
    lspServers: [
      { language: "typescript", server: "vtsls", installCommand: "npm i -g vtsls", installed: true },
      { language: "python", server: "pylsp", installCommand: "pip install pylsp", installed: false },
    ],
    mcpServers: [
      {
        name: "playwright",
        source: "npm:@playwright/mcp",
        config: { command: "npx", args: ["@playwright/mcp@latest"] },
        installed: true,
        reason: "E2E testing",
      },
    ],
    plugins: [],
    openSourceTools: [],
    claudeMd: "- Prefer const over let\n- No var",
    ...overrides,
  };
}

describe("generateClaudeMd", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("creates CLAUDE.md in project root", () => {
    generateClaudeMd(TEST_DIR, makeArch(), makeDomain(), makeEnvironment());
    expect(existsSync(resolve(TEST_DIR, "CLAUDE.md"))).toBe(true);
  });

  it("creates .claude/CLAUDE.md", () => {
    generateClaudeMd(TEST_DIR, makeArch(), makeDomain(), makeEnvironment());
    expect(existsSync(resolve(TEST_DIR, ".claude", "CLAUDE.md"))).toBe(true);
  });

  it("root and .claude/ CLAUDE.md have the same content", () => {
    generateClaudeMd(TEST_DIR, makeArch(), makeDomain(), makeEnvironment());
    const root = readFileSync(resolve(TEST_DIR, "CLAUDE.md"), "utf-8");
    const dotClaude = readFileSync(resolve(TEST_DIR, ".claude", "CLAUDE.md"), "utf-8");
    expect(root).toBe(dotClaude);
  });

  it("includes tech stack entries", () => {
    generateClaudeMd(TEST_DIR, makeArch(), makeDomain(), makeEnvironment());
    const content = readFileSync(resolve(TEST_DIR, "CLAUDE.md"), "utf-8");
    expect(content).toContain("TypeScript");
    expect(content).toContain("Next.js");
    expect(content).toContain("PostgreSQL");
  });

  it("includes domain classification and specializations", () => {
    generateClaudeMd(TEST_DIR, makeArch(), makeDomain(), makeEnvironment());
    const content = readFileSync(resolve(TEST_DIR, "CLAUDE.md"), "utf-8");
    expect(content).toContain("productivity");
    expect(content).toContain("task management");
  });

  it("includes installed LSP servers but not uninstalled ones", () => {
    generateClaudeMd(TEST_DIR, makeArch(), makeDomain(), makeEnvironment());
    const content = readFileSync(resolve(TEST_DIR, "CLAUDE.md"), "utf-8");
    expect(content).toContain("vtsls");
    expect(content).not.toContain("pylsp");
  });

  it("includes installed MCP servers", () => {
    generateClaudeMd(TEST_DIR, makeArch(), makeDomain(), makeEnvironment());
    const content = readFileSync(resolve(TEST_DIR, "CLAUDE.md"), "utf-8");
    expect(content).toContain("playwright");
    expect(content).toContain("E2E testing");
  });

  it("includes claudeMd conventions from environment", () => {
    generateClaudeMd(TEST_DIR, makeArch(), makeDomain(), makeEnvironment());
    const content = readFileSync(resolve(TEST_DIR, "CLAUDE.md"), "utf-8");
    expect(content).toContain("Prefer const over let");
    expect(content).toContain("No var");
  });

  it("includes file structure from architecture", () => {
    generateClaudeMd(TEST_DIR, makeArch(), makeDomain(), makeEnvironment());
    const content = readFileSync(resolve(TEST_DIR, "CLAUDE.md"), "utf-8");
    expect(content).toContain("src/");
  });

  it("omits domain section when no specializations", () => {
    const domain = makeDomain();
    domain.specializations = [];
    generateClaudeMd(TEST_DIR, makeArch(), domain, makeEnvironment());
    const content = readFileSync(resolve(TEST_DIR, "CLAUDE.md"), "utf-8");
    expect(content).not.toContain("## Domain");
  });

  it("omits tools section when nothing is installed", () => {
    const env = makeEnvironment({
      lspServers: [],
      mcpServers: [],
    });
    generateClaudeMd(TEST_DIR, makeArch(), makeDomain(), env);
    const content = readFileSync(resolve(TEST_DIR, "CLAUDE.md"), "utf-8");
    expect(content).not.toContain("## Available Tools");
  });
});
