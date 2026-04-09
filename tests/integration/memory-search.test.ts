/**
 * Integration tests for MemoryStore.search using real file I/O.
 * No mocking — these tests exercise the full storage and retrieval path.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/state/memory-store.js";

const TEST_DIR = join(tmpdir(), `ads-int-memory-search-${process.pid}`);

describe("MemoryStore integration — real file I/O", () => {
  let store: MemoryStore;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = new MemoryStore(TEST_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("finds documents that match the query string (case-insensitive)", async () => {
    await store.write("TypeScript conventions", "Use strict mode and avoid any", ["typescript"]);
    await store.write("React patterns", "Prefer functional components with hooks", ["react"]);
    await store.write("Testing strategy", "Write unit tests for all utils", ["testing"]);

    const results = await store.search("TypeScript");

    expect(results).toHaveLength(1);
    expect(results[0]!.topic).toBe("TypeScript conventions");
  });

  it("search is case-insensitive", async () => {
    await store.write("API Design", "REST endpoints should use noun-based routes", ["api"]);

    const results = await store.search("rest endpoints");

    expect(results).toHaveLength(1);
    expect(results[0]!.topic).toBe("API Design");
  });

  it("returns multiple results when multiple documents match", async () => {
    await store.write("Backend conventions", "Use TypeScript for backend services", ["backend"]);
    await store.write("Frontend conventions", "Use TypeScript with React on frontend", ["frontend"]);
    await store.write("Database notes", "Use PostgreSQL for production", ["db"]);

    const results = await store.search("TypeScript");

    expect(results).toHaveLength(2);
    const topics = results.map((r) => r.topic).sort();
    expect(topics).toContain("Backend conventions");
    expect(topics).toContain("Frontend conventions");
  });

  it("returns empty array when no documents match", async () => {
    await store.write("Architecture notes", "Use microservices with Docker", ["arch"]);

    const results = await store.search("blockchain");

    expect(results).toEqual([]);
  });

  it("excludes deleted documents from search results", async () => {
    const doc = await store.write("Old approach", "We used Angular before", ["frontend"]);
    await store.delete(doc.id);

    const results = await store.search("Angular");

    expect(results).toEqual([]);
  });

  it("respects the limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await store.write(`Note ${i}`, `All documents contain the word pattern`, ["tag"]);
    }

    const results = await store.search("pattern", { limit: 3 });

    expect(results).toHaveLength(3);
  });

  it("persists documents across MemoryStore instances (real file I/O)", async () => {
    // Write with one store instance
    await store.write("Session data", "Context from previous run about deployment", ["session"]);

    // Read with a fresh instance (same dir)
    const freshStore = new MemoryStore(TEST_DIR);
    const results = await freshStore.search("deployment");

    expect(results).toHaveLength(1);
    expect(results[0]!.topic).toBe("Session data");
  });

  it("updates existing document and search finds new content", async () => {
    await store.write("Architecture", "Initial design using REST", ["arch"]);
    await store.write("Architecture", "Updated design using GraphQL instead of REST", ["arch"]);

    const results = await store.search("GraphQL");

    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain("GraphQL");
    expect(results[0]!.version).toBe(2);
  });
});
