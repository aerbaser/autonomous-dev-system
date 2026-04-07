import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

interface SessionEntry {
  agentRole: string;
  sessionId: string;
  createdAt: string;
  lastUsed: string;
}

interface SessionStore {
  sessions: Record<string, SessionEntry>;
}

export function loadSessions(stateDir: string): SessionStore {
  const path = resolve(stateDir, "sessions.json");
  if (!existsSync(path)) return { sessions: {} };
  return JSON.parse(readFileSync(path, "utf-8")) as SessionStore;
}

export function saveSessions(stateDir: string, store: SessionStore): void {
  const path = resolve(stateDir, "sessions.json");
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2));
}

export function setSession(
  store: SessionStore,
  agentRole: string,
  sessionId: string
): SessionStore {
  return {
    sessions: {
      ...store.sessions,
      [agentRole]: {
        agentRole,
        sessionId,
        createdAt: store.sessions[agentRole]?.createdAt ?? new Date().toISOString(),
        lastUsed: new Date().toISOString(),
      },
    },
  };
}

export function getSessionId(store: SessionStore, agentRole: string): string | undefined {
  return store.sessions[agentRole]?.sessionId;
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

/**
 * Remove a specific session by agent role.
 */
export function removeSession(store: SessionStore, agentRole: string): SessionStore {
  const { [agentRole]: _removed, ...remaining } = store.sessions;
  return { sessions: remaining };
}
