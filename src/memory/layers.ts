import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { MemoryStore } from "../state/memory-store.js";
import { SkillStore } from "./skills.js";

// --- Schemas (L0 + L4) ---

export const MetaRuleSchema = z.object({
  id: z.string(),
  rule: z.string(),
});

export type MetaRule = z.infer<typeof MetaRuleSchema>;

export const MetaRulesFileSchema = z.object({
  version: z.number(),
  rules: z.array(MetaRuleSchema),
});

export const SessionArchiveEntrySchema = z.object({
  runId: z.string(),
  phases: z.array(z.string()),
  totalCostUsd: z.number(),
  completedAt: z.string(),
  notes: z.string().optional(),
});

export type SessionArchiveEntry = z.infer<typeof SessionArchiveEntrySchema>;

// --- Layer interfaces ---

export interface L0Layer {
  getRules(): Promise<MetaRule[]>;
}

export interface L1Layer {
  queryIndex(keyword: string): Promise<string[]>;
}

export interface L2Layer {
  upsertFact(key: string, value: string): Promise<void>;
  getFact(key: string): Promise<string | null>;
  listFacts(): Promise<Array<{ key: string; value: string }>>;
}

export interface L4Layer {
  archiveSession(summary: {
    runId: string;
    phases: string[];
    totalCostUsd: number;
    completedAt: string;
    notes?: string;
  }): Promise<void>;
  listArchive(limit?: number): Promise<SessionArchiveEntry[]>;
}

// --- Facade ---

const FACT_TOPIC_PREFIX = "fact:";
const FACT_TAG = "global-fact";

/**
 * LayeredMemory implements the L0-L4 memory hierarchy on top of the existing
 * `MemoryStore` and the filesystem:
 *
 *   L0 — read-only meta-rules shipped with the codebase (seed) or copied into
 *        the state dir. These are the "always-apply" invariants.
 *   L1 — index over the MemoryStore; cheap topic/tag keyword lookup.
 *   L2 — global facts. Small key-value store on top of MemoryStore using the
 *        reserved `fact:` topic prefix and the `global-fact` tag.
 *   L3 — SkillStore (playbooks crystallized from successful receipts).
 *   L4 — append-only JSONL session archive at
 *        `{stateDir}/memory/session-archive.jsonl`. Keeps one line per run so
 *        failure modes stay recoverable (a corrupt line does not kill later
 *        lines).
 */
export class LayeredMemory {
  readonly l0: L0Layer;
  readonly l1: L1Layer;
  readonly l2: L2Layer;
  readonly l3: SkillStore;
  readonly l4: L4Layer;

  private readonly archivePath: string;

  constructor(memoryStore: MemoryStore, stateDir: string, skillStore?: SkillStore) {
    this.archivePath = resolve(stateDir, "memory", "session-archive.jsonl");
    const stateRulesPath = resolve(stateDir, "memory", "meta-rules.json");

    this.l0 = {
      async getRules(): Promise<MetaRule[]> {
        const path = existsSync(stateRulesPath) ? stateRulesPath : bundledMetaRulesPath();
        try {
          const raw = await readFile(path, "utf-8");
          const parsed = MetaRulesFileSchema.safeParse(JSON.parse(raw));
          return parsed.success ? parsed.data.rules : [];
        } catch {
          return [];
        }
      },
    };

    this.l1 = {
      async queryIndex(keyword: string): Promise<string[]> {
        // Use memoryStore.list with no tag filter, then filter by topic /
        // tag substring locally — cheap and avoids leaking content reads.
        const docs = await memoryStore.list();
        const needle = keyword.toLowerCase();
        const out = new Set<string>();
        for (const doc of docs) {
          if (doc.topic.toLowerCase().includes(needle)) {
            out.add(doc.topic);
            continue;
          }
          if (doc.tags.some((t) => t.toLowerCase().includes(needle))) {
            out.add(doc.topic);
          }
        }
        return [...out];
      },
    };

    this.l2 = {
      async upsertFact(key: string, value: string): Promise<void> {
        await memoryStore.write(`${FACT_TOPIC_PREFIX}${key}`, value, [FACT_TAG]);
      },
      async getFact(key: string): Promise<string | null> {
        const docs = await memoryStore.list({ tags: [FACT_TAG] });
        const match = docs.find((d) => d.topic === `${FACT_TOPIC_PREFIX}${key}`);
        return match ? match.content : null;
      },
      async listFacts(): Promise<Array<{ key: string; value: string }>> {
        const docs = await memoryStore.list({ tags: [FACT_TAG] });
        return docs
          .filter((d) => d.topic.startsWith(FACT_TOPIC_PREFIX))
          .map((d) => ({
            key: d.topic.slice(FACT_TOPIC_PREFIX.length),
            value: d.content,
          }));
      },
    };

    this.l3 = skillStore ?? new SkillStore(memoryStore);

    const archivePath = this.archivePath;
    this.l4 = {
      async archiveSession(summary): Promise<void> {
        const entry: SessionArchiveEntry = {
          runId: summary.runId,
          phases: summary.phases,
          totalCostUsd: summary.totalCostUsd,
          completedAt: summary.completedAt,
          ...(summary.notes !== undefined ? { notes: summary.notes } : {}),
        };
        await mkdir(dirname(archivePath), { recursive: true });
        await appendFile(archivePath, JSON.stringify(entry) + "\n", "utf-8");
      },
      async listArchive(limit?: number): Promise<SessionArchiveEntry[]> {
        if (!existsSync(archivePath)) return [];
        const raw = await readFile(archivePath, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        const entries: SessionArchiveEntry[] = [];
        for (const line of lines) {
          try {
            const parsed = SessionArchiveEntrySchema.safeParse(JSON.parse(line));
            if (parsed.success) entries.push(parsed.data);
          } catch {
            // Skip malformed line — append-only log must tolerate partial writes.
          }
        }
        if (limit !== undefined && limit > 0 && entries.length > limit) {
          return entries.slice(entries.length - limit);
        }
        return entries;
      },
    };
  }

  /** L0 meta-rules are read-only — writes throw. */
  writeRule(_rule: MetaRule): never {
    throw new Error("L0 meta-rules are read-only");
  }
}

function bundledMetaRulesPath(): string {
  // `src/memory/meta-rules.json` ships alongside the compiled module. We
  // resolve via import.meta.url so both tsx (source) and built runs pick the
  // same file.
  const here = fileURLToPath(import.meta.url);
  return resolve(dirname(here), "meta-rules.json");
}

// Re-export writeFile for potential L4 extension points (callers may want to
// persist sidecar summaries alongside the JSONL archive). Keeping it local
// avoids churning existing import sites.
export { writeFile };
