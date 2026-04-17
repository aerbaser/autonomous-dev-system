import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { resolve, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { Phase, ALL_PHASES, TaskStatus } from "../types/phases.js";
import { errMsg } from "../utils/shared.js";
import type { TaskStateSchema, AgentBlueprintSchema, ProductSpecSchema, UserStorySchema,
  DomainAnalysisSchema, ArchDesignSchema, ArchTaskSchema,
  StackEnvironmentSchema, LspConfigSchema, McpDiscoverySchema,
  PluginDiscoverySchema, OssToolStateSchema, DeploymentStateSchema,
  ABTestStateSchema, PhaseCheckpointSchema, PhaseResultSummarySchema,
  EvolutionEntrySchema} from "../types/llm-schemas.js";
import { ProjectStateSchema } from "../types/llm-schemas.js";

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
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf-8"));
    const parsed = ProjectStateSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      console.warn(
        `[project-state] loadState: schema validation failed for ${statePath}. ` +
          `Issues: ${issues}. Returning null; operator should inspect state.`
      );
      return null;
    }
    return parsed.data;
  } catch (err) {
    console.warn(
      `[project-state] loadState: failed to parse ${statePath}: ${errMsg(err)}. ` +
        `Returning null; operator should inspect state.`
    );
    return null;
  }
}

/**
 * Atomic state write: write to a temp file, fsync, then rename onto state.json.
 * A mid-write crash leaves state.json unchanged (or absent on first write), never
 * half-written. On error, the tmp file is unlinked and the original is rethrown.
 */
export function saveState(stateDir: string, state: ProjectState): void {
  assertSafePath(stateDir);
  const statePath = resolve(stateDir, "state.json");
  const dir = dirname(statePath);
  mkdirSync(dir, { recursive: true });
  const toSave = { ...state, updatedAt: new Date().toISOString() };
  const payload = JSON.stringify(toSave, null, 2);
  const tmpPath = `${statePath}.tmp.${process.pid}.${Date.now()}`;

  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, "w");
    writeSync(fd, payload);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, statePath);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
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

/** Cap on checkpoint history retained per phase (sliding window). */
export const MAX_CHECKPOINTS_PER_PHASE = 3;

function checkpointTime(c: PhaseCheckpoint): number {
  const t = Date.parse(c.timestamp);
  return Number.isFinite(t) ? t : 0;
}

export function saveCheckpoint(
  state: ProjectState,
  checkpoint: PhaseCheckpoint
): ProjectState {
  // Keep the (MAX_CHECKPOINTS_PER_PHASE - 1) most recent checkpoints for this
  // phase, then append the new one so total per phase stays ≤ MAX.
  const sameKeep = state.checkpoints
    .filter((c) => c.phase === checkpoint.phase)
    .sort((a, b) => checkpointTime(b) - checkpointTime(a))
    .slice(0, MAX_CHECKPOINTS_PER_PHASE - 1);
  const others = state.checkpoints.filter((c) => c.phase !== checkpoint.phase);
  return {
    ...state,
    checkpoints: [...others, ...sameKeep, checkpoint],
  };
}

/** Returns all checkpoints for the given phase, newest-first. */
export function getCheckpointHistory(
  state: ProjectState,
  phase: Phase
): PhaseCheckpoint[] {
  return state.checkpoints
    .filter((c) => c.phase === phase)
    .sort((a, b) => checkpointTime(b) - checkpointTime(a));
}

export function getLatestCheckpoint(
  state: ProjectState,
  phase: Phase
): PhaseCheckpoint | null {
  const history = getCheckpointHistory(state, phase);
  return history[0] ?? null;
}

// --- Advisory file lock ---

const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Advisory cross-process file lock for `${stateDir}/.lock`.
 *
 * Acquires via `openSync(lockPath, "wx")` (atomic exclusive-create). If another
 * holder already owns the lock and its mtime is older than 5 min, the lock is
 * considered stale and reclaimed once. The lock file records the current pid
 * to aid debugging.
 *
 * Releases the lock in a finally block so exceptions don't strand the lockfile.
 */
export async function withStateLock<T>(
  stateDir: string,
  fn: () => T | Promise<T>
): Promise<T> {
  assertSafePath(stateDir);
  mkdirSync(stateDir, { recursive: true });
  const lockPath = join(stateDir, ".lock");

  let fd: number | null = null;
  let reclaimed = false;

  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      // EEXIST: check staleness once, else wait briefly and retry.
      if (!reclaimed) {
        try {
          const st = statSync(lockPath);
          const age = Date.now() - st.mtimeMs;
          if (age > LOCK_STALE_MS) {
            try { unlinkSync(lockPath); } catch { /* ignore */ }
            reclaimed = true;
            continue;
          }
        } catch {
          // lock file vanished between EEXIST and stat — just retry.
          continue;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  try {
    writeFileSync(fd, String(process.pid));
  } catch {
    // non-fatal: debug info only.
  }

  try {
    return await fn();
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(lockPath); } catch { /* ignore */ }
  }
}
