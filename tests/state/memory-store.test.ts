import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TOPIC_PATTERN_LENGTH, MemoryStore } from "../../src/state/memory-store.js";

const TEST_STATE_DIR = join(tmpdir(), `ads-test-memory-${process.pid}`);

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
    mkdirSync(TEST_STATE_DIR, { recursive: true });
    store = new MemoryStore(TEST_STATE_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
  });

  describe("write", () => {
    it("creates a new document", async () => {
      const doc = await store.write("test topic", "some content", ["tag1", "tag2"]);

      expect(doc.id).toBeTruthy();
      expect(doc.topic).toBe("test topic");
      expect(doc.content).toBe("some content");
      expect(doc.tags).toEqual(["tag1", "tag2"]);
      expect(doc.version).toBe(1);
      expect(doc.contentHash).toBeTruthy();
      expect(doc.archived).toBe(false);
    });

    it("upserts document with same topic", async () => {
      const doc1 = await store.write("topic A", "content v1", ["tag1"]);
      const doc2 = await store.write("topic A", "content v2", ["tag1", "tag2"]);

      expect(doc2.id).toBe(doc1.id);
      expect(doc2.content).toBe("content v2");
      expect(doc2.version).toBe(2);
      expect(doc2.tags).toEqual(["tag1", "tag2"]);
    });

    it("skips write if content hash unchanged", async () => {
      const doc1 = await store.write("topic", "same content", ["tag"]);
      const doc2 = await store.write("topic", "same content", ["tag"]);

      expect(doc2.version).toBe(1);
      expect(doc2.contentHash).toBe(doc1.contentHash);
    });

    it("creates separate documents for different topics", async () => {
      const doc1 = await store.write("topic A", "content A", ["tag"]);
      const doc2 = await store.write("topic B", "content B", ["tag"]);

      expect(doc1.id).not.toBe(doc2.id);
    });
  });

  describe("read", () => {
    it("reads an existing document by id", async () => {
      const written = await store.write("topic", "content", ["tag"]);
      const doc = await store.read(written.id);

      expect(doc).not.toBeNull();
      expect(doc!.id).toBe(written.id);
      expect(doc!.content).toBe("content");
    });

    it("returns null for non-existent id", async () => {
      const doc = await store.read("non-existent-id");
      expect(doc).toBeNull();
    });

    it("returns null for archived document", async () => {
      const written = await store.write("topic", "content", ["tag"]);
      await store.delete(written.id);
      const doc = await store.read(written.id);
      expect(doc).toBeNull();
    });
  });

  describe("search", () => {
    it("searches by topic", async () => {
      await store.write("TypeScript patterns", "Use generics", ["typescript"]);
      await store.write("Python tricks", "Use list comp", ["python"]);

      const results = await store.search("typescript");
      expect(results).toHaveLength(1);
      expect(results[0]!.topic).toBe("TypeScript patterns");
    });

    it("searches by tag", async () => {
      await store.write("Topic 1", "Content", ["frontend", "react"]);
      await store.write("Topic 2", "Content", ["backend", "node"]);

      const results = await store.search("react");
      expect(results).toHaveLength(1);
      expect(results[0]!.tags).toContain("react");
    });

    it("searches by content", async () => {
      await store.write("Topic", "Use dependency injection for testability", ["testing"]);

      const results = await store.search("dependency injection");
      expect(results).toHaveLength(1);
    });

    it("is case-insensitive", async () => {
      await store.write("UPPERCASE Topic", "content", ["TAG"]);

      const results = await store.search("uppercase");
      expect(results).toHaveLength(1);
    });

    it("filters by tags", async () => {
      await store.write("Topic 1", "Content with react", ["frontend", "react"]);
      await store.write("Topic 2", "Content with react", ["backend"]);

      const results = await store.search("react", { tags: ["frontend"] });
      expect(results).toHaveLength(1);
      expect(results[0]!.tags).toContain("frontend");
    });

    it("respects limit", async () => {
      for (let i = 0; i < 10; i++) {
        await store.write(`Topic ${i}`, "common keyword", ["tag"]);
      }

      const results = await store.search("common", { limit: 3 });
      expect(results).toHaveLength(3);
    });

    it("excludes archived documents", async () => {
      const doc = await store.write("Archived topic", "content", ["tag"]);
      await store.delete(doc.id);

      const results = await store.search("archived");
      expect(results).toHaveLength(0);
    });
  });

  describe("list", () => {
    it("lists all active documents", async () => {
      await store.write("Topic 1", "Content 1", ["tag1"]);
      await store.write("Topic 2", "Content 2", ["tag2"]);

      const docs = await store.list();
      expect(docs).toHaveLength(2);
    });

    it("filters by tags", async () => {
      await store.write("Topic 1", "Content 1", ["frontend"]);
      await store.write("Topic 2", "Content 2", ["backend"]);

      const docs = await store.list({ tags: ["frontend"] });
      expect(docs).toHaveLength(1);
      expect(docs[0]!.tags).toContain("frontend");
    });

    it("filters by topic pattern", async () => {
      await store.write("API Design", "Content", ["tag"]);
      await store.write("DB Schema", "Content", ["tag"]);

      const docs = await store.list({ topicPattern: "API" });
      expect(docs).toHaveLength(1);
      expect(docs[0]!.topic).toBe("API Design");
    });

    it("excludes archived documents", async () => {
      const doc = await store.write("Topic", "Content", ["tag"]);
      await store.write("Topic 2", "Content 2", ["tag"]);
      await store.delete(doc.id);

      const docs = await store.list();
      expect(docs).toHaveLength(1);
    });
  });

  describe("getHistory", () => {
    it("returns creation entry", async () => {
      const doc = await store.write("Topic", "Content", ["tag"]);
      const history = await store.getHistory(doc.id);

      expect(history).toHaveLength(1);
      expect(history[0]!.operation).toBe("created");
      expect(history[0]!.contentHash).toBe(doc.contentHash);
    });

    it("returns update entries", async () => {
      const doc = await store.write("Topic", "Content v1", ["tag"]);
      await store.write("Topic", "Content v2", ["tag"]);
      const history = await store.getHistory(doc.id);

      expect(history).toHaveLength(2);
      expect(history[0]!.operation).toBe("created");
      expect(history[1]!.operation).toBe("updated");
    });

    it("returns delete entry", async () => {
      const doc = await store.write("Topic", "Content", ["tag"]);
      await store.delete(doc.id);
      const history = await store.getHistory(doc.id);

      expect(history).toHaveLength(2);
      expect(history[1]!.operation).toBe("deleted");
    });

    it("returns empty for non-existent id", async () => {
      const history = await store.getHistory("non-existent");
      expect(history).toEqual([]);
    });
  });

  describe("delete", () => {
    it("soft deletes a document", async () => {
      const doc = await store.write("Topic", "Content", ["tag"]);
      const deleted = await store.delete(doc.id);

      expect(deleted).toBe(true);

      const readBack = await store.read(doc.id);
      expect(readBack).toBeNull();
    });

    it("returns false for non-existent id", async () => {
      const deleted = await store.delete("non-existent");
      expect(deleted).toBe(false);
    });

    it("returns false for already deleted document", async () => {
      const doc = await store.write("Topic", "Content", ["tag"]);
      await store.delete(doc.id);
      const deletedAgain = await store.delete(doc.id);
      expect(deletedAgain).toBe(false);
    });
  });

  describe("concurrent write safety", () => {
    it("handles upsert with content hash check", async () => {
      const doc1 = await store.write("Topic", "Version 1", ["tag"]);
      const doc2 = await store.write("Topic", "Version 2", ["tag"]);

      expect(doc2.version).toBe(2);
      expect(doc2.contentHash).not.toBe(doc1.contentHash);

      const current = await store.read(doc2.id);
      expect(current!.content).toBe("Version 2");
    });
  });

  describe("size limits", () => {
    it("rejects oversized documents", async () => {
      const bigStore = new MemoryStore(TEST_STATE_DIR, { maxDocumentSizeKb: 1, maxDocuments: 500 });
      const bigContent = "x".repeat(2 * 1024); // 2KB

      await expect(bigStore.write("Big", bigContent, ["tag"])).rejects.toThrow(
        /exceeds max size/
      );
    });
  });

  describe("document eviction", () => {
    it("evicts oldest documents when over max", async () => {
      const smallStore = new MemoryStore(TEST_STATE_DIR, { maxDocuments: 3, maxDocumentSizeKb: 100 });

      await smallStore.write("Topic 1", "Content 1", ["tag"]);
      await smallStore.write("Topic 2", "Content 2", ["tag"]);
      await smallStore.write("Topic 3", "Content 3", ["tag"]);
      await smallStore.write("Topic 4", "Content 4", ["tag"]);

      const docs = await smallStore.list();
      // Should have at most 3 active documents
      expect(docs.length).toBeLessThanOrEqual(3);
    });
  });
});

describe("SEC-06 topicPattern bounded input", () => {
  // Use a separate temp dir so this block does not race with the outer
  // describe's beforeEach/afterEach lifecycle.
  const SEC06_STATE_DIR = join(tmpdir(), `ads-test-memory-sec06-${process.pid}`);
  let store: MemoryStore;

  beforeEach(() => {
    if (existsSync(SEC06_STATE_DIR)) rmSync(SEC06_STATE_DIR, { recursive: true });
    mkdirSync(SEC06_STATE_DIR, { recursive: true });
    store = new MemoryStore(SEC06_STATE_DIR);
  });

  afterEach(() => {
    if (existsSync(SEC06_STATE_DIR)) rmSync(SEC06_STATE_DIR, { recursive: true });
  });

  it("pins MAX_TOPIC_PATTERN_LENGTH to 256 (silent loosening must show up as a diff)", () => {
    expect(MAX_TOPIC_PATTERN_LENGTH).toBe(256);
  });

  it("accepts a 256-char topicPattern (boundary value)", async () => {
    await store.write("alpha", "content-a", ["t1"]);
    const pattern = "x".repeat(256);
    const results = await store.list({ topicPattern: pattern });
    // 'x'*256 will not match topic 'alpha' — empty result is correct, the point
    // is that the call did not throw at the boundary.
    expect(Array.isArray(results)).toBe(true);
  });

  it("throws when topicPattern exceeds 256 chars", async () => {
    const pattern = "x".repeat(257);
    await expect(store.list({ topicPattern: pattern })).rejects.toThrow(
      /MAX_TOPIC_PATTERN_LENGTH/
    );
  });

  it("normal-length topicPattern still matches (regression)", async () => {
    await store.write("phase-development", "content", ["phase"]);
    await store.write("phase-testing", "content", ["phase"]);
    const results = await store.list({ topicPattern: "phase" });
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("returns within wall-clock ceiling for a benign 256-char pattern across many docs", async () => {
    // Seed 50 documents (well below the 500 cap) with varied topics.
    for (let i = 0; i < 50; i++) {
      await store.write(`topic-${i}`, `content-${i}`, ["t"]);
    }
    const pattern = "topic-".padEnd(256, "x"); // benign, won't match anything but exercises the walk
    const t0 = Date.now();
    const results = await store.list({ topicPattern: pattern });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500); // generous; on a healthy box this is <50ms
    expect(Array.isArray(results)).toBe(true);
  });
});
