import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";

// --- Core types ---

export type Phase =
  | "ideation"
  | "specification"
  | "architecture"
  | "environment-setup"
  | "development"
  | "testing"
  | "review"
  | "staging"
  | "ab-testing"
  | "analysis"
  | "production"
  | "monitoring";

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignedAgent?: string;
  parentTaskId?: string;
  createdAt: string;
  completedAt?: string;
  result?: string;
  error?: string;
}

export interface AgentBlueprint {
  name: string;
  role: string;
  systemPrompt: string;
  tools: string[];
  mcpServers?: Record<string, McpServerConfig>;
  model?: "opus" | "sonnet" | "haiku";
  evaluationCriteria: string[];
  version: number;
  score?: number;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ProductSpec {
  summary: string;
  userStories: UserStory[];
  nonFunctionalRequirements: string[];
  domain: DomainAnalysis;
}

export interface UserStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: "must" | "should" | "could" | "wont";
}

export interface DomainAnalysis {
  classification: string;
  specializations: string[];
  requiredRoles: string[];
  requiredMcpServers: string[];
  techStack: string[];
}

export interface ArchDesign {
  techStack: Record<string, string>;
  components: string[];
  apiContracts: string;
  databaseSchema: string;
  fileStructure: string;
}

export interface StackEnvironment {
  lspServers: LspConfig[];
  mcpServers: McpDiscovery[];
  plugins: PluginDiscovery[];
  openSourceTools: OssTool[];
  claudeMd: string;
}

export interface LspConfig {
  language: string;
  server: string;
  installCommand: string;
  installed: boolean;
}

export interface McpDiscovery {
  name: string;
  source: string;
  config: McpServerConfig;
  installed: boolean;
  reason: string;
}

export interface PluginDiscovery {
  name: string;
  source: string;
  scope: "project" | "user";
  installed: boolean;
  reason: string;
}

export interface OssTool {
  name: string;
  repo: string;
  type: "agent" | "skill" | "hook" | "mcp-server" | "pattern";
  integrationPlan: string;
  integrated: boolean;
}

export interface Deployment {
  id: string;
  environment: "staging" | "production";
  url?: string;
  timestamp: string;
  status: "deploying" | "deployed" | "failed" | "rolled-back";
}

export interface ABTest {
  id: string;
  name: string;
  hypothesis: string;
  variants: string[];
  featureFlagKey: string;
  status: "setup" | "running" | "analyzing" | "completed";
  result?: {
    winner: string;
    pValue: number;
    metrics: Record<string, number>;
  };
}

export interface PhaseCheckpoint {
  phase: Phase;
  completedTasks: string[];  // task IDs that finished
  pendingTasks: string[];    // task IDs still to do
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface EvolutionEntry {
  id: string;
  target: string;
  type: "agent_prompt" | "tool_config" | "phase_logic" | "quality_threshold" | "environment_setup";
  diff: string;
  scoreBefore: number;
  scoreAfter: number;
  accepted: boolean;
  timestamp: string;
}

export interface ProjectState {
  id: string;
  idea: string;
  currentPhase: Phase;
  spec: ProductSpec | null;
  architecture: ArchDesign | null;
  environment: StackEnvironment | null;
  agents: AgentBlueprint[];
  tasks: Task[];
  deployments: Deployment[];
  abTests: ABTest[];
  evolution: EvolutionEntry[];
  checkpoints: PhaseCheckpoint[];
  sessionIds: Record<string, string>;
  baselineScore: number;
  createdAt: string;
  updatedAt: string;
}

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
    deployments: [],
    abTests: [],
    evolution: [],
    checkpoints: [],
    sessionIds: {},
    baselineScore: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function loadState(stateDir: string): ProjectState | null {
  const statePath = resolve(stateDir, "state.json");
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
}

export function saveState(stateDir: string, state: ProjectState): void {
  const statePath = resolve(stateDir, "state.json");
  const dir = dirname(statePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(statePath, JSON.stringify(state, null, 2));
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
