import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import { SessionStoreSchema } from "../types/llm-schemas.js";
import { assertSafePath } from "./project-state.js";

interface SessionEntry {
  phase: string;
  sessionId: string;
  createdAt: string;
  lastUsed: string;
}

interface SessionStore {
  sessions: Record<string, SessionEntry>;
}

const QUERY_TELEMETRY_FILE = "query-sessions.json";

const QueryTelemetryEntrySchema = z.object({
  sessionId: z.string(),
  label: z.string(),
  phase: z.string().optional(),
  agentName: z.string().optional(),
  model: z.string().optional(),
  costUsd: z.number(),
  turns: z.number(),
  success: z.boolean(),
  startedAt: z.string(),
  endedAt: z.string(),
  durationMs: z.number(),
});

const QueryTelemetryStoreSchema = z.object({
  queries: z.record(z.string(), QueryTelemetryEntrySchema),
});

export interface QueryTelemetryEntry {
  sessionId: string;
  label: string;
  phase?: string | undefined;
  agentName?: string | undefined;
  model?: string | undefined;
  costUsd: number;
  turns: number;
  success: boolean;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface QueryTelemetryStore {
  queries: Record<string, QueryTelemetryEntry>;
}

export function loadSessions(stateDir: string): SessionStore {
  assertSafePath(stateDir);
  const path = resolve(stateDir, "sessions.json");
  if (!existsSync(path)) return { sessions: {} };
  try {
    const parsed = SessionStoreSchema.safeParse(JSON.parse(readFileSync(path, "utf-8")));
    return parsed.success ? parsed.data : { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

export function saveSessions(stateDir: string, store: SessionStore): void {
  assertSafePath(stateDir);
  const path = resolve(stateDir, "sessions.json");
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2));
}

export function loadQueryTelemetry(stateDir: string): QueryTelemetryStore {
  assertSafePath(stateDir);
  const path = resolve(stateDir, QUERY_TELEMETRY_FILE);
  if (!existsSync(path)) return { queries: {} };
  try {
    const parsed = QueryTelemetryStoreSchema.safeParse(JSON.parse(readFileSync(path, "utf-8")));
    return parsed.success ? parsed.data : { queries: {} };
  } catch {
    return { queries: {} };
  }
}

export function saveQueryTelemetry(stateDir: string, store: QueryTelemetryStore): void {
  assertSafePath(stateDir);
  const path = resolve(stateDir, QUERY_TELEMETRY_FILE);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2));
}

export function upsertQueryTelemetry(
  stateDir: string,
  entry: QueryTelemetryEntry,
): QueryTelemetryStore {
  const store = loadQueryTelemetry(stateDir);
  const next: QueryTelemetryStore = {
    queries: {
      ...store.queries,
      [entry.sessionId]: entry,
    },
  };
  saveQueryTelemetry(stateDir, next);
  return next;
}

export function resolveQueryTelemetryStateDir(): string | null {
  const envDir = process.env["AUTONOMOUS_DEV_STATE_DIR"] ?? process.env["ADS_STATE_DIR"];
  if (envDir && envDir.trim()) {
    const resolved = resolve(envDir);
    try {
      assertSafePath(resolved);
      return resolved;
    } catch {
      return null;
    }
  }

  const cwdCandidate = resolve(process.cwd(), ".autonomous-dev");
  if (existsSync(cwdCandidate)) {
    return cwdCandidate;
  }

  return null;
}

export function recordQueryTelemetry(
  entry: Omit<QueryTelemetryEntry, "startedAt" | "endedAt"> & {
    startedAt?: string;
    endedAt?: string;
  },
): QueryTelemetryStore | null {
  const stateDir = resolveQueryTelemetryStateDir();
  if (!stateDir) return null;

  const now = new Date().toISOString();
  return upsertQueryTelemetry(stateDir, {
    ...entry,
    startedAt: entry.startedAt ?? now,
    endedAt: entry.endedAt ?? now,
  });
}

export function setSession(
  store: SessionStore,
  phase: string,
  sessionId: string
): SessionStore {
  return {
    sessions: {
      ...store.sessions,
      [phase]: {
        phase,
        sessionId,
        createdAt: store.sessions[phase]?.createdAt ?? new Date().toISOString(),
        lastUsed: new Date().toISOString(),
      },
    },
  };
}

export function getSessionId(store: SessionStore, phase: string): string | undefined {
  return store.sessions[phase]?.sessionId;
}

/**
 * Remove sessions older than maxAgeMs (default: 24 hours).
 */
export function cleanStaleSessions(
  store: SessionStore,
  maxAgeMs: number = 24 * 60 * 60 * 1000
): SessionStore {
  const now = Date.now();
  const cleaned: Record<string, SessionEntry> = {};

  for (const [key, entry] of Object.entries(store.sessions)) {
    const lastUsed = new Date(entry.lastUsed).getTime();
    if (now - lastUsed < maxAgeMs) {
      cleaned[key] = entry;
    }
  }

  return { sessions: cleaned };
}
