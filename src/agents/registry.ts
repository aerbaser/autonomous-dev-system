import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentBlueprint } from "../state/project-state.js";
import { getBaseBlueprints } from "./base-blueprints.js";

export interface AgentPerformance {
  benchmarkId: string;
  score: number;
  timestamp: string;
  details?: Record<string, unknown>;
}

interface RegistryData {
  blueprints: Record<string, AgentBlueprint>;
  performanceHistory: Record<string, AgentPerformance[]>;
}

export class AgentRegistry {
  private data: RegistryData;
  private persistDir: string;

  constructor(stateDir: string) {
    this.persistDir = resolve(stateDir, "agents");
    this.data = this.load();
  }

  private load(): RegistryData {
    const indexPath = resolve(this.persistDir, "index.json");
    if (existsSync(indexPath)) {
      return JSON.parse(readFileSync(indexPath, "utf-8")) as RegistryData;
    }

    // Initialize with base blueprints
    const blueprints: Record<string, AgentBlueprint> = {};
    for (const bp of getBaseBlueprints()) {
      blueprints[bp.name] = bp;
    }
    return { blueprints, performanceHistory: {} };
  }

  save(): void {
    if (!existsSync(this.persistDir)) {
      mkdirSync(this.persistDir, { recursive: true });
    }
    writeFileSync(
      resolve(this.persistDir, "index.json"),
      JSON.stringify(this.data, null, 2)
    );

    // Also persist each blueprint as a versioned .md for Agent SDK subagent definitions
    for (const bp of Object.values(this.data.blueprints)) {
      this.persistBlueprintAsMarkdown(bp);
    }
  }

  private persistBlueprintAsMarkdown(bp: AgentBlueprint): void {
    const filename = `${bp.name}.v${bp.version}.md`;
    const mdPath = resolve(this.persistDir, filename);

    const modelMap = {
      opus: "claude-opus-4-6",
      sonnet: "claude-sonnet-4-6",
      haiku: "claude-haiku-4-5-20251001",
    } as const satisfies Record<string, string>;

    const frontmatter = [
      "---",
      `name: ${bp.name}`,
      `description: ${bp.role}`,
    ];
    if (bp.model) frontmatter.push(`model: ${modelMap[bp.model] ?? bp.model}`);
    if (bp.tools.length) frontmatter.push(`tools: ${bp.tools.join(", ")}`);
    frontmatter.push("---");

    const content = `${frontmatter.join("\n")}\n\n${bp.systemPrompt}\n`;
    writeFileSync(mdPath, content);
  }

  register(blueprint: AgentBlueprint): void {
    this.data.blueprints[blueprint.name] = blueprint;
  }

  get(name: string): AgentBlueprint | undefined {
    return this.data.blueprints[name];
  }

  getAll(): AgentBlueprint[] {
    return Object.values(this.data.blueprints);
  }

  getByRole(role: string): AgentBlueprint | undefined {
    return Object.values(this.data.blueprints).find(
      (bp) => bp.role.toLowerCase() === role.toLowerCase()
    );
  }

  recordPerformance(agentName: string, perf: AgentPerformance): void {
    if (!this.data.performanceHistory[agentName]) {
      this.data.performanceHistory[agentName] = [];
    }
    this.data.performanceHistory[agentName].push(perf);
  }

  getPerformanceHistory(agentName: string): AgentPerformance[] {
    return this.data.performanceHistory[agentName] ?? [];
  }

  getAverageScore(agentName: string): number {
    const history = this.getPerformanceHistory(agentName);
    if (history.length === 0) return 0;
    const sum = history.reduce((acc, p) => acc + p.score, 0);
    return sum / history.length;
  }

  /** Update a blueprint with a new version (for self-improvement mutations) */
  evolve(name: string, updates: Partial<AgentBlueprint>): AgentBlueprint {
    const current = this.data.blueprints[name];
    if (!current) throw new Error(`Agent not found: ${name}`);

    const evolved: AgentBlueprint = {
      ...current,
      ...updates,
      version: current.version + 1,
    };
    this.data.blueprints[name] = evolved;
    return evolved;
  }

  /** Convert a blueprint to Agent SDK AgentDefinition format */
  toAgentDefinition(name: string): {
    description: string;
    prompt: string;
    tools: string[];
  } {
    const bp = this.data.blueprints[name];
    if (!bp) throw new Error(`Agent not found: ${name}`);

    return {
      description: `${bp.role}: ${bp.name}`,
      prompt: bp.systemPrompt,
      tools: bp.tools,
    };
  }
}
