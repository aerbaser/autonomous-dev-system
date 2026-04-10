import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
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
