import { readFileSync, readdirSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { ALL_PHASES } from "../state/project-state.js";
import { renderDashboard } from "./template.js";

const execFileAsync = promisify(execFile);

export interface PhaseEvent {
  type: string;
  timestamp: string;
  seq: number;
  data: Record<string, unknown>;
}

export interface PhaseStats {
  phase: string;
  status: "completed" | "current" | "pending";
  startedAt?: string | undefined;
  endedAt?: string | undefined;
  costUsd?: number | undefined;
  durationMs?: number | undefined;
  success?: boolean | undefined;
}

export interface AgentInfo {
  name: string;
  role: string;
  domain?: string | undefined;
  systemPromptExcerpt: string;
}

export interface EvolutionRow {
  id: string;
  target: string;
  type: string;
  scoreBefore: number;
  scoreAfter: number;
  accepted: boolean;
  timestamp: string;
}

export interface DashboardData {
  projectId: string;
  idea: string;
  currentPhase: string;
  totalCostUsd: number;
  createdAt: string;
  phases: PhaseStats[];
  events: PhaseEvent[];
  agents: AgentInfo[];
  evolution: EvolutionRow[];
  generatedAt: string;
  stateExists: boolean;
}

function readEvents(stateDir: string): PhaseEvent[] {
  const eventsDir = path.join(stateDir, "events");
  const events: PhaseEvent[] = [];
  try {
    const files = readdirSync(eventsDir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const raw = readFileSync(path.join(eventsDir, file), "utf8");
      for (const line of raw.split("\n").filter(Boolean)) {
        try {
          events.push(JSON.parse(line) as PhaseEvent);
        } catch {
          // skip malformed lines
        }
      }
    }
  } catch {
    // events dir may not exist yet
  }
  return events.sort((a, b) => a.seq - b.seq);
}

function buildPhaseStats(events: PhaseEvent[], currentPhase: string): PhaseStats[] {
  const startMap = new Map<string, PhaseEvent>();
  const endMap = new Map<string, PhaseEvent>();
  for (const ev of events) {
    const ph = ev.data["phase"];
    if (typeof ph !== "string") continue;
    if (ev.type === "orchestrator.phase.start") startMap.set(ph, ev);
    else if (ev.type === "orchestrator.phase.end") endMap.set(ph, ev);
  }

  return ALL_PHASES.map((phase): PhaseStats => {
    const endEv = endMap.get(phase);
    const startEv = startMap.get(phase);
    if (endEv) {
      return {
        phase,
        status: "completed",
        startedAt: startEv?.timestamp,
        endedAt: endEv.timestamp,
        costUsd:
          typeof endEv.data["costUsd"] === "number"
            ? (endEv.data["costUsd"] as number)
            : undefined,
        durationMs:
          typeof endEv.data["durationMs"] === "number"
            ? (endEv.data["durationMs"] as number)
            : undefined,
        success:
          typeof endEv.data["success"] === "boolean"
            ? (endEv.data["success"] as boolean)
            : undefined,
      };
    }
    if (phase === currentPhase) {
      return { phase, status: "current", startedAt: startEv?.timestamp };
    }
    return { phase, status: "pending" };
  });
}

function readAgents(stateDir: string): AgentInfo[] {
  try {
    const raw = readFileSync(path.join(stateDir, "agents", "index.json"), "utf8");
    const index = JSON.parse(raw) as {
      blueprints: Record<
        string,
        { name: string; role?: string; domain?: string; systemPrompt: string }
      >;
    };
    return Object.values(index.blueprints ?? {}).map((bp) => ({
      name: bp.name,
      role: bp.role ?? bp.name,
      domain: bp.domain,
      systemPromptExcerpt: bp.systemPrompt.slice(0, 200),
    }));
  } catch {
    return [];
  }
}

function readEvolution(state: Record<string, unknown>): EvolutionRow[] {
  const raw = state["evolution"];
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => {
    const entry = (e ?? {}) as Record<string, unknown>;
    return {
      id: String(entry["id"] ?? ""),
      target: String(entry["target"] ?? ""),
      type: String(entry["type"] ?? ""),
      scoreBefore:
        typeof entry["scoreBefore"] === "number" ? (entry["scoreBefore"] as number) : 0,
      scoreAfter:
        typeof entry["scoreAfter"] === "number" ? (entry["scoreAfter"] as number) : 0,
      accepted: Boolean(entry["accepted"]),
      timestamp: String(entry["timestamp"] ?? ""),
    };
  });
}

export function collectDashboardData(stateDir: string): DashboardData {
  const statePath = path.join(stateDir, "state.json");
  const stateExists = existsSync(statePath);

  if (!stateExists) {
    return {
      projectId: "—",
      idea: "No project found in " + stateDir,
      currentPhase: "ideation",
      totalCostUsd: 0,
      createdAt: new Date().toISOString(),
      phases: ALL_PHASES.map((phase) => ({ phase, status: "pending" as const })),
      events: [],
      agents: [],
      evolution: [],
      generatedAt: new Date().toISOString(),
      stateExists: false,
    };
  }

  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
  } catch {
    // use empty state
  }

  const events = readEvents(stateDir);
  const currentPhase = typeof state["currentPhase"] === "string" ? state["currentPhase"] : "ideation";
  const phases = buildPhaseStats(events, currentPhase);

  return {
    projectId: typeof state["id"] === "string" ? state["id"] : "—",
    idea: typeof state["idea"] === "string" ? state["idea"] : "—",
    currentPhase,
    totalCostUsd:
      typeof state["totalCostUsd"] === "number" ? (state["totalCostUsd"] as number) : 0,
    createdAt: typeof state["createdAt"] === "string" ? state["createdAt"] : "",
    phases,
    events,
    agents: readAgents(stateDir),
    evolution: readEvolution(state),
    generatedAt: new Date().toISOString(),
    stateExists: true,
  };
}

export async function generateDashboard(stateDir: string, outputPath: string): Promise<void> {
  const data = collectDashboardData(stateDir);
  const html = renderDashboard(data);
  writeFileSync(outputPath, html, "utf8");
}

export async function openInBrowser(filePath: string): Promise<void> {
  await execFileAsync("open", [filePath]).catch(() => {
    // non-macOS or open unavailable — ignore
  });
}
