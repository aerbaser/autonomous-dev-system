import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertSafePath } from "./project-state.js";
import {
  MemoryDocumentSchema,
  MemoryIndexSchema,
  MemoryHistoryEntrySchema,
  type MemoryDocument,
  type MemoryIndex,
  type MemoryHistoryEntry,
} from "./memory-types.js";

export interface MemoryStoreConfig {
  maxDocuments: number;
  maxDocumentSizeKb: number;
}

const DEFAULT_CONFIG: MemoryStoreConfig = {
  maxDocuments: 500,
  maxDocumentSizeKb: 100,
};

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function contentPreview(content: string, maxLen = 200): string {
  return content.length <= maxLen ? content : content.slice(0, maxLen) + "...";
}

export class MemoryStore {
  private readonly memoryDir: string;
  private readonly historyDir: string;
  private readonly indexPath: string;
  private readonly config: MemoryStoreConfig;

  constructor(stateDir: string, config?: Partial<MemoryStoreConfig>) {
    assertSafePath(stateDir);
    this.memoryDir = resolve(stateDir, "memory");
    this.historyDir = resolve(stateDir, "memory", "history");
    this.indexPath = resolve(stateDir, "memory", "_index.json");
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private async ensureDirs(): Promise<void> {
    if (!existsSync(this.memoryDir)) {
      await mkdir(this.memoryDir, { recursive: true });
    }
    if (!existsSync(this.historyDir)) {
      await mkdir(this.historyDir, { recursive: true });
    }
  }

  private async loadIndex(): Promise<MemoryIndex> {
    try {
      const raw = await readFile(this.indexPath, "utf-8");
      const parsed = MemoryIndexSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : { documents: {} };
    } catch {
      return { documents: {} };
    }
  }

  private async saveIndex(index: MemoryIndex): Promise<void> {
    await this.ensureDirs();
    await writeFile(this.indexPath, JSON.stringify(index, null, 2));
  }

  private docPath(id: string): string {
    return join(this.memoryDir, `${id}.json`);
  }

  private historyPath(id: string): string {
    return join(this.historyDir, `${id}.jsonl`);
  }

  private async appendHistory(id: string, entry: MemoryHistoryEntry): Promise<void> {
    await this.ensureDirs();
    const line = JSON.stringify(entry) + "\n";
    await appendFile(this.historyPath(id), line, "utf-8");
  }

  private async evictOldest(index: MemoryIndex): Promise<MemoryIndex> {
    const activeEntries = Object.entries(index.documents)
      .filter(([, v]) => !v.archived)
      .sort(([, a], [, b]) => a.updatedAt.localeCompare(b.updatedAt));

    const activeCount = activeEntries.length;
    if (activeCount <= this.config.maxDocuments) return index;

    const toEvict = activeCount - this.config.maxDocuments;
    const updated = { ...index, documents: { ...index.documents } };

    for (let i = 0; i < toEvict; i++) {
      const [id] = activeEntries[i]!;
      updated.documents[id] = { ...updated.documents[id]!, archived: true };

      // Soft-delete the document on disk
      try {
        const doc = await this.readDoc(id);
        if (doc) {
          await writeFile(this.docPath(id), JSON.stringify({ ...doc, archived: true }, null, 2));
          await this.appendHistory(id, {
            timestamp: new Date().toISOString(),
            operation: "deleted",
            contentHash: doc.contentHash,
            contentPreview: contentPreview(doc.content),
          });
        }
      } catch {
        // Best-effort eviction
      }
    }

    return updated;
  }

  private async readDoc(id: string): Promise<MemoryDocument | null> {
    try {
      const raw = await readFile(this.docPath(id), "utf-8");
      const parsed = MemoryDocumentSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async write(topic: string, content: string, tags: string[]): Promise<MemoryDocument> {
    const sizeKb = Buffer.byteLength(content, "utf-8") / 1024;
    if (sizeKb > this.config.maxDocumentSizeKb) {
      throw new Error(
        `Document content exceeds max size: ${sizeKb.toFixed(1)}KB > ${this.config.maxDocumentSizeKb}KB`
      );
    }

    await this.ensureDirs();
    let index = await this.loadIndex();

    // Check for existing document with same topic (upsert)
    const existingEntry = Object.entries(index.documents).find(
      ([, v]) => v.topic === topic && !v.archived
    );

    const now = new Date().toISOString();
    const hash = contentHash(content);

    if (existingEntry) {
      const [id, meta] = existingEntry;
      // Skip write if content hasn't changed
      if (meta.contentHash === hash) {
        const doc = await this.readDoc(id);
        if (doc) return doc;
      }

      const existing = await this.readDoc(id);
      const version = existing ? existing.version + 1 : 1;

      const doc: MemoryDocument = {
        id,
        topic,
        content,
        tags,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        version,
        contentHash: hash,
        archived: false,
      };

      await writeFile(this.docPath(id), JSON.stringify(doc, null, 2));

      index.documents[id] = { topic, tags, contentHash: hash, updatedAt: now, archived: false };
      await this.saveIndex(index);

      await this.appendHistory(id, {
        timestamp: now,
        operation: "updated",
        contentHash: hash,
        contentPreview: contentPreview(content),
      });

      return doc;
    }

    // New document
    const id = randomUUID();
    const doc: MemoryDocument = {
      id,
      topic,
      content,
      tags,
      createdAt: now,
      updatedAt: now,
      version: 1,
      contentHash: hash,
      archived: false,
    };

    await writeFile(this.docPath(id), JSON.stringify(doc, null, 2));

    index.documents[id] = { topic, tags, contentHash: hash, updatedAt: now, archived: false };

    // Evict oldest if over limit
    index = await this.evictOldest(index);

    await this.saveIndex(index);

    await this.appendHistory(id, {
      timestamp: now,
      operation: "created",
      contentHash: hash,
      contentPreview: contentPreview(content),
    });

    return doc;
  }

  async read(id: string): Promise<MemoryDocument | null> {
    const doc = await this.readDoc(id);
    if (!doc || doc.archived) return null;
    return doc;
  }

  async search(
    query: string,
    options?: { tags?: string[]; limit?: number }
  ): Promise<MemoryDocument[]> {
    const index = await this.loadIndex();
    const lowerQuery = query.toLowerCase();
    const limit = options?.limit ?? 20;
    const filterTags = options?.tags?.map((t) => t.toLowerCase());

    // Split into index-matched (topic/tag hit) vs content candidates (need disk read)
    const indexMatched: string[] = [];
    const contentCandidates: string[] = [];

    for (const [id, meta] of Object.entries(index.documents)) {
      if (meta.archived) continue;

      if (filterTags && filterTags.length > 0) {
        const docTags = meta.tags.map((t) => t.toLowerCase());
        if (!filterTags.some((ft) => docTags.includes(ft))) continue;
      }

      const topicMatch = meta.topic.toLowerCase().includes(lowerQuery);
      const tagMatch = meta.tags.some((t) => t.toLowerCase().includes(lowerQuery));

      if (topicMatch || tagMatch) {
        indexMatched.push(id);
      } else {
        contentCandidates.push(id);
      }
    }

    const results: MemoryDocument[] = [];

    // Index-matched docs are guaranteed to match — no re-check needed
    for (const id of indexMatched) {
      if (results.length >= limit) break;
      const doc = await this.readDoc(id);
      if (doc && !doc.archived) results.push(doc);
    }

    // Content search only when still under limit
    for (const id of contentCandidates) {
      if (results.length >= limit) break;
      const doc = await this.readDoc(id);
      if (!doc || doc.archived) continue;
      if (doc.content.toLowerCase().includes(lowerQuery)) {
        results.push(doc);
      }
    }

    return results;
  }

  async list(filter?: { tags?: string[]; topicPattern?: string }): Promise<MemoryDocument[]> {
    const index = await this.loadIndex();
    const results: MemoryDocument[] = [];

    const filterTags = filter?.tags?.map((t) => t.toLowerCase());
    const topicFilter = filter?.topicPattern?.toLowerCase() ?? null;

    for (const [id, meta] of Object.entries(index.documents)) {
      if (meta.archived) continue;

      if (filterTags && filterTags.length > 0) {
        const docTags = meta.tags.map((t) => t.toLowerCase());
        if (!filterTags.some((ft) => docTags.includes(ft))) continue;
      }

      if (topicFilter && !meta.topic.toLowerCase().includes(topicFilter)) continue;

      const doc = await this.readDoc(id);
      if (doc && !doc.archived) results.push(doc);
    }

    return results;
  }

  async getHistory(id: string): Promise<MemoryHistoryEntry[]> {
    try {
      const raw = await readFile(this.historyPath(id), "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      const entries: MemoryHistoryEntry[] = [];

      for (const line of lines) {
        const parsed = MemoryHistoryEntrySchema.safeParse(JSON.parse(line));
        if (parsed.success) entries.push(parsed.data);
      }

      return entries;
    } catch {
      return [];
    }
  }

  async delete(id: string): Promise<boolean> {
    const index = await this.loadIndex();
    const meta = index.documents[id];
    if (!meta || meta.archived) return false;

    const doc = await this.readDoc(id);
    if (!doc) return false;

    // Soft delete: mark as archived
    const archived: MemoryDocument = { ...doc, archived: true, updatedAt: new Date().toISOString() };
    await writeFile(this.docPath(id), JSON.stringify(archived, null, 2));

    index.documents[id] = { ...meta, archived: true, updatedAt: archived.updatedAt };
    await this.saveIndex(index);

    await this.appendHistory(id, {
      timestamp: archived.updatedAt,
      operation: "deleted",
      contentHash: doc.contentHash,
      contentPreview: contentPreview(doc.content),
    });

    return true;
  }
}
