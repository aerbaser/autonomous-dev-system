import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadSessions,
  saveSessions,
  setSession,
  getSessionId,
  cleanStaleSessions,
} from "../../src/state/session-store.js";

// Must be inside project root to satisfy assertSafePath
const TEST_STATE_DIR = join(process.cwd(), `.test-session-${process.pid}`);

describe("SessionStore", () => {
  beforeEach(() => {
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
    mkdirSync(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
  });

  describe("loadSessions", () => {
    it("returns empty store when file does not exist", () => {
      const store = loadSessions(TEST_STATE_DIR);
      expect(store).toEqual({ sessions: {} });
    });

    it("returns empty store when file contains malformed JSON", () => {
      writeFileSync(join(TEST_STATE_DIR, "sessions.json"), '{"sessions":');
      expect(loadSessions(TEST_STATE_DIR)).toEqual({ sessions: {} });
    });

    it("loads persisted sessions", () => {
      const store = setSession({ sessions: {} }, "development", "session-abc");
      saveSessions(TEST_STATE_DIR, store);

      const loaded = loadSessions(TEST_STATE_DIR);
      expect(loaded.sessions["development"]).toBeDefined();
      expect(loaded.sessions["development"]!.sessionId).toBe("session-abc");
    });

    it("returns empty store when file contains invalid JSON schema", () => {
      writeFileSync(join(TEST_STATE_DIR, "sessions.json"), '{"invalid": true}');
      const store = loadSessions(TEST_STATE_DIR);
      expect(store).toEqual({ sessions: {} });
    });
  });

  describe("saveSessions / loadSessions roundtrip", () => {
    it("persists and restores sessions correctly", () => {
      let store = { sessions: {} };
      store = setSession(store, "testing", "sid-001");
      store = setSession(store, "development", "sid-002");

      saveSessions(TEST_STATE_DIR, store);
      const loaded = loadSessions(TEST_STATE_DIR);

      expect(Object.keys(loaded.sessions)).toHaveLength(2);
      expect(loaded.sessions["testing"]!.sessionId).toBe("sid-001");
      expect(loaded.sessions["development"]!.sessionId).toBe("sid-002");
    });

    it("creates stateDir subdirectory if it does not exist", () => {
      const nestedDir = join(TEST_STATE_DIR, "nested", "path");
      const store = setSession({ sessions: {} }, "ideation", "s-1");
      expect(() => saveSessions(nestedDir, store)).not.toThrow();
      if (existsSync(nestedDir)) rmSync(nestedDir, { recursive: true });
    });
  });

  describe("setSession", () => {
    it("adds a new session entry", () => {
      const store = setSession({ sessions: {} }, "development", "sid-1");
      expect(store.sessions["development"]).toBeDefined();
      expect(store.sessions["development"]!.sessionId).toBe("sid-1");
      expect(store.sessions["development"]!.phase).toBe("development");
    });

    it("updates sessionId for existing phase", () => {
      let store = setSession({ sessions: {} }, "development", "old-sid");
      store = setSession(store, "development", "new-sid");

      expect(store.sessions["development"]!.sessionId).toBe("new-sid");
    });

    it("preserves createdAt when updating existing session", () => {
      let store = setSession({ sessions: {} }, "development", "old-sid");
      const firstCreatedAt = store.sessions["development"]!.createdAt;

      store = setSession(store, "development", "new-sid");
      expect(store.sessions["development"]!.createdAt).toBe(firstCreatedAt);
    });

    it("updates lastUsed on each call", async () => {
      let store = setSession({ sessions: {} }, "development", "sid-1");
      const firstLastUsed = store.sessions["development"]!.lastUsed;

      await new Promise((r) => setTimeout(r, 2));
      store = setSession(store, "development", "sid-2");
      const secondLastUsed = store.sessions["development"]!.lastUsed;

      expect(new Date(secondLastUsed) >= new Date(firstLastUsed)).toBe(true);
    });

    it("does not mutate the original store", () => {
      const original = { sessions: {} };
      const updated = setSession(original, "testing", "s-1");
      expect(original.sessions).toEqual({});
      expect(updated).not.toBe(original);
    });
  });

  describe("getSessionId", () => {
    it("returns the session ID for a known phase", () => {
      const store = setSession({ sessions: {} }, "development", "my-session");
      expect(getSessionId(store, "development")).toBe("my-session");
    });

    it("returns undefined for unknown phase", () => {
      const store = { sessions: {} };
      expect(getSessionId(store, "unknown-phase")).toBeUndefined();
    });
  });

  describe("cleanStaleSessions", () => {
    it("removes sessions older than maxAgeMs", () => {
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const store = {
        sessions: {
          "old-phase": {
            phase: "old-phase",
            sessionId: "old-sid",
            createdAt: oldDate,
            lastUsed: oldDate,
          },
        },
      };

      const cleaned = cleanStaleSessions(store as any, 24 * 60 * 60 * 1000);
      expect(Object.keys(cleaned.sessions)).toHaveLength(0);
    });

    it("keeps sessions younger than maxAgeMs", () => {
      const recentDate = new Date(Date.now() - 1000).toISOString();
      const store = {
        sessions: {
          "fresh-phase": {
            phase: "fresh-phase",
            sessionId: "fresh-sid",
            createdAt: recentDate,
            lastUsed: recentDate,
          },
        },
      };

      const cleaned = cleanStaleSessions(store as any, 24 * 60 * 60 * 1000);
      expect(Object.keys(cleaned.sessions)).toHaveLength(1);
      expect(cleaned.sessions["fresh-phase"]!.sessionId).toBe("fresh-sid");
    });

    it("uses 24h default when maxAgeMs not specified", () => {
      const recentDate = new Date(Date.now() - 60 * 1000).toISOString();
      const store = {
        sessions: {
          "ideation": {
            phase: "ideation",
            sessionId: "sid",
            createdAt: recentDate,
            lastUsed: recentDate,
          },
        },
      };

      const cleaned = cleanStaleSessions(store as any);
      expect(Object.keys(cleaned.sessions)).toHaveLength(1);
    });

    it("drops sessions with invalid timestamps instead of keeping corrupt state", () => {
      const store = {
        sessions: {
          broken: {
            phase: "broken",
            sessionId: "sid",
            createdAt: "not-a-date",
            lastUsed: "also-not-a-date",
          },
        },
      };

      const cleaned = cleanStaleSessions(store as any);
      expect(cleaned.sessions).toEqual({});
    });
  });
});
