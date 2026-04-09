import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Phase, ALL_PHASES, TaskStatus } from "../types/phases.js";
import {
  ProjectStateSchema, TaskStateSchema, AgentBlueprintSchema,
  McpServerConfigSchema, ProductSpecSchema, UserStorySchema,
  DomainAnalysisSchema, ArchDesignSchema, ArchTaskSchema,
  StackEnvironmentSchema, LspConfigSchema, McpDiscoverySchema,
  PluginDiscoverySchema, OssToolStateSchema, DeploymentStateSchema,
  ABTestStateSchema, PhaseCheckpointSchema, PhaseResultSummarySchema,
  EvolutionEntrySchema,
} from "../types/llm-schemas.js";

export { Phase, ALL_PHASES, TaskStatus };

/**
 * Prevents path traversal from relative stateDir values in config files
 * (e.g. stateDir: "../../etc"). Absolute paths are trusted — they're
 * explicitly chosen by the user or test environment.
 */
export function assertSafePath(stateDir: string): void {
  if (!isAbsolute(stateDir)) {
    const resolved = resolve(stateDir);
    const base = process.cwd();
    if (!resolved.startsWith(base + "/") && resolved !== base) {
      throw new Error(`Path traversal detected: "${stateDir}" resolves outside project root`);
    }
  }
}

// --- Core types (derived from Zod schemas) ---

export type Task = z.infer<typeof TaskStateSchema>;
export type AgentBlueprint = z.infer<typeof AgentBlueprintSchema>;
// Manual interface: Zod .optional() adds `| undefined` which conflicts
// with SDK's exactOptionalPropertyTypes expectations
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
export type ProductSpec = z.infer<typeof ProductSpecSchema>;
export type UserStory = z.infer<typeof UserStorySchema>;
export type DomainAnalysis = z.infer<typeof DomainAnalysisSchema>;
export type ArchDesign = z.infer<typeof ArchDesignSchema>;
export type ArchTask = z.infer<typeof ArchTaskSchema>;
export type StackEnvironment = z.infer<typeof StackEnvironmentSchema>;
export type LspConfig = z.infer<typeof LspConfigSchema>;
export type McpDiscovery = z.infer<typeof McpDiscoverySchema>;
export type PluginDiscovery = z.infer<typeof PluginDiscoverySchema>;
export type OssTool = z.infer<typeof OssToolStateSchema>;
export type Deployment = z.infer<typeof DeploymentStateSchema>;
export type ABTest = z.infer<typeof ABTestStateSchema>;
export type PhaseCheckpoint = z.infer<typeof PhaseCheckpointSchema>;
export type PhaseResultSummary = z.infer<typeof PhaseResultSummarySchema>;
export type EvolutionEntry = z.infer<typeof EvolutionEntrySchema>;
export type ProjectState = z.infer<typeof ProjectStateSchema>;

export type ArchComponent = ArchDesign["components"][number];
export type TargetAudience = NonNullable<ProductSpec["targetAudience"]>;
export type Competitor = NonNullable<ProductSpec["competitiveAnalysis"]>["directCompetitors"][number];
export type CompetitiveAnalysis = NonNullable<ProductSpec["competitiveAnalysis"]>;
export type MvpScope = NonNullable<ProductSpec["mvpScope"]>;
export type TechStackRecommendation = NonNullable<ProductSpec["techStackRecommendation"]>;

// --- Phase transitions ---

const VALID_TRANSITIONS = {
  ideation: ["specification"],
  specification: ["architecture"],
  architecture: ["environment-setup"],
  "environment-setup": ["development"],
  development: ["testing"],
  testing: ["development", "review"],
  review: ["development", "staging"],
  staging: ["ab-testing"],
  "ab-testing": ["analysis"],
  analysis: ["development", "production"],
  production: ["monitoring"],
  monitoring: ["development"],
} as const satisfies Record<Phase, readonly Phase[]>;

export function canTransition(from: Phase, to: Phase): boolean {
  const targets: readonly Phase[] = VALID_TRANSITIONS[from];
  return targets.includes(to);
}

// --- Persistence ---

export function createInitialState(idea: string): ProjectState {
  return {
    id: randomUUID(),
    idea,
    currentPhase: "ideation",
    spec: null,
    architecture: null,
    environment: null,
    agents: [],
    tasks: [],
    completedPhases: [],
    phaseResults: {},
    deployments: [],
    abTests: [],
    evolution: [],
    checkpoints: [],
    baselineScore: 0,
    totalCostUsd: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function loadState(stateDir: string): ProjectState | null {
  assertSafePath(stateDir);
  const statePath = resolve(stateDir, "state.json");
  if (!existsSync(statePath)) return null;
  const parsed = ProjectStateSchema.safeParse(JSON.parse(readFileSync(statePath, "utf-8")));
  return parsed.success ? parsed.data : null;
}

export function saveState(stateDir: string, state: ProjectState): void {
  assertSafePath(stateDir);
  const statePath = resolve(stateDir, "state.json");
  const dir = dirname(statePath);
  mkdirSync(dir, { recursive: true });
  const toSave = { ...state, updatedAt: new Date().toISOString() };
  writeFileSync(statePath, JSON.stringify(toSave, null, 2));
}

export function transitionPhase(state: ProjectState, to: Phase): ProjectState {
  if (!canTransition(state.currentPhase, to)) {
    throw new Error(
      `Invalid phase transition: ${state.currentPhase} → ${to}. ` +
        `Valid transitions: ${VALID_TRANSITIONS[state.currentPhase]?.join(", ")}`
    );
  }
  return { ...state, currentPhase: to };
}

export function addTask(state: ProjectState, task: Omit<Task, "id" | "createdAt" | "status">): ProjectState {
  const newTask: Task = {
    ...task,
    id: randomUUID(),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  return { ...state, tasks: [...state.tasks, newTask] };
}

export function updateTask(
  state: ProjectState,
  taskId: string,
  update: Partial<Pick<Task, "status" | "result" | "error" | "completedAt" | "assignedAgent">>
): ProjectState {
  return {
    ...state,
    tasks: state.tasks.map((t) =>
      t.id === taskId ? { ...t, ...update } : t
    ),
  };
}

export function saveCheckpoint(
  state: ProjectState,
  checkpoint: PhaseCheckpoint
): ProjectState {
  // Replace existing checkpoint for the same phase, or append
  const existing = state.checkpoints.findIndex((c) => c.phase === checkpoint.phase);
  const updated = [...state.checkpoints];
  if (existing >= 0) {
    updated[existing] = checkpoint;
  } else {
    updated.push(checkpoint);
  }
  return { ...state, checkpoints: updated };
}

export function getLatestCheckpoint(
  state: ProjectState,
  phase: Phase
): PhaseCheckpoint | null {
  const match = state.checkpoints.find((c) => c.phase === phase);
  return match ?? null;
}
