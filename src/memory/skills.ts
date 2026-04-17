import { randomUUID } from "node:crypto";
import type { MemoryStore } from "../state/memory-store.js";
import {
  SkillPlaybookSchema,
  type SkillPlaybook,
  type TaskSignature,
} from "../types/skills.js";
import type { TaskReceipt } from "../types/task-receipt.js";

// Common English stopwords stripped before keyword matching. Keeping the list
// short and static — we're ranking topical overlap, not doing full NLP.
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "for",
  "with",
  "and",
  "or",
  "of",
]);

const KEYWORD_MIN_LENGTH = 3;

/**
 * Extract a coarse signature from a task title. Title is lowercased, tokenized
 * on non-alphanumerics, stopwords are dropped, and tokens shorter than
 * KEYWORD_MIN_LENGTH are filtered out. The domain and phase are passed in by
 * the caller — they come from the runner's context, not from the title.
 */
export function extractSignature(
  taskTitle: string,
  domain: string,
  phase: string,
): TaskSignature {
  const tokens = taskTitle
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= KEYWORD_MIN_LENGTH && !STOPWORDS.has(t));

  return {
    domain,
    phase,
    titleKeywords: tokens,
  };
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "untitled";
}

function signaturesEqual(a: TaskSignature, b: TaskSignature): boolean {
  if (a.domain !== b.domain || a.phase !== b.phase) return false;
  if (a.titleKeywords.length !== b.titleKeywords.length) return false;
  const aSorted = [...a.titleKeywords].sort();
  const bSorted = [...b.titleKeywords].sort();
  return aSorted.every((kw, i) => kw === bSorted[i]);
}

function overlapScore(a: TaskSignature, b: TaskSignature): number {
  if (a.titleKeywords.length === 0 || b.titleKeywords.length === 0) return 0;
  const setA = new Set(a.titleKeywords);
  let shared = 0;
  for (const kw of b.titleKeywords) {
    if (setA.has(kw)) shared++;
  }
  return shared;
}

/**
 * SkillStore persists `SkillPlaybook` entries on top of the generic
 * `MemoryStore`. Playbooks are serialized as JSON into the content field; the
 * topic convention is `skill:<slug>` and tags always include `"skill"`, the
 * domain, the phase, and every title keyword — which lets a cheap
 * tag-filtered `list()` return all candidates before we rank by overlap.
 */
export class SkillStore {
  constructor(private readonly memory: MemoryStore) {}

  private parsePlaybook(content: string): SkillPlaybook | null {
    try {
      const raw: unknown = JSON.parse(content);
      const parsed = SkillPlaybookSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private buildTags(signature: TaskSignature): string[] {
    return ["skill", signature.domain, signature.phase, ...signature.titleKeywords];
  }

  /**
   * Distill a successful task receipt into a reusable playbook. If a skill
   * with the exact same signature already exists we update it in place
   * (incrementing successCount and useCount) instead of creating a duplicate.
   */
  async crystallize(
    receipt: TaskReceipt,
    ctx: { domain: string; phase: string; costUsd?: number },
  ): Promise<SkillPlaybook> {
    const signature = extractSignature(receipt.taskTitle, ctx.domain, ctx.phase);
    const verificationCommands = receipt.verificationCommands.map((v) => v.command);

    // Look for an existing playbook with the same signature. We filter by the
    // "skill" tag + domain + phase to keep the scan cheap, then compare
    // signatures in full.
    const existing = await this.memory.list({
      tags: ["skill", signature.domain, signature.phase],
    });

    for (const doc of existing) {
      const parsed = this.parsePlaybook(doc.content);
      if (!parsed) continue;
      if (!signaturesEqual(parsed.signature, signature)) continue;

      const now = new Date().toISOString();
      const updated: SkillPlaybook = {
        ...parsed,
        taskTitle: receipt.taskTitle,
        changedFiles: receipt.changedFiles,
        verificationCommands,
        successCount: parsed.successCount + 1,
        useCount: parsed.useCount + 1,
        avgCostUsd:
          ctx.costUsd !== undefined
            ? average(parsed.avgCostUsd, parsed.successCount, ctx.costUsd)
            : parsed.avgCostUsd,
        updatedAt: now,
      };
      await this.memory.write(doc.topic, JSON.stringify(updated), this.buildTags(signature));
      return updated;
    }

    const now = new Date().toISOString();
    const playbook: SkillPlaybook = {
      id: randomUUID(),
      signature,
      taskTitle: receipt.taskTitle,
      changedFiles: receipt.changedFiles,
      verificationCommands,
      successCount: 1,
      useCount: 0,
      ...(ctx.costUsd !== undefined ? { avgCostUsd: ctx.costUsd } : {}),
      createdAt: now,
      updatedAt: now,
    };

    const topic = `skill:${slugify(receipt.taskTitle)}:${playbook.id.slice(0, 8)}`;
    await this.memory.write(topic, JSON.stringify(playbook), this.buildTags(signature));
    return playbook;
  }

  /**
   * Return the top `limit` playbooks that match the given signature, ranked by
   * descending title-keyword overlap. Domain+phase are required to match
   * exactly — we're not doing cross-domain retrieval.
   */
  async findMatching(signature: TaskSignature, limit = 3): Promise<SkillPlaybook[]> {
    const docs = await this.memory.list({
      tags: ["skill", signature.domain, signature.phase],
    });

    const scored: Array<{ playbook: SkillPlaybook; score: number }> = [];
    for (const doc of docs) {
      const parsed = this.parsePlaybook(doc.content);
      if (!parsed) continue;
      if (parsed.signature.domain !== signature.domain) continue;
      if (parsed.signature.phase !== signature.phase) continue;
      const score = overlapScore(parsed.signature, signature);
      if (score === 0) continue;
      scored.push({ playbook: parsed, score });
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tie-break: prefer higher successCount, then more recent updatedAt.
      if (b.playbook.successCount !== a.playbook.successCount) {
        return b.playbook.successCount - a.playbook.successCount;
      }
      return b.playbook.updatedAt.localeCompare(a.playbook.updatedAt);
    });

    return scored.slice(0, limit).map((s) => s.playbook);
  }

  /**
   * Record that a skill was injected into a prompt. This does NOT bump the
   * success count — only crystallize() does. Use this when surfacing a
   * playbook to a task so `useCount` reflects actual reuse.
   */
  async recordUse(playbookId: string): Promise<void> {
    const docs = await this.memory.list({ tags: ["skill"] });
    for (const doc of docs) {
      const parsed = this.parsePlaybook(doc.content);
      if (!parsed) continue;
      if (parsed.id !== playbookId) continue;

      const updated: SkillPlaybook = {
        ...parsed,
        useCount: parsed.useCount + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.memory.write(
        doc.topic,
        JSON.stringify(updated),
        this.buildTags(parsed.signature),
      );
      return;
    }
  }
}

function average(prev: number | undefined, prevCount: number, next: number): number {
  if (prev === undefined || prevCount <= 0) return next;
  return (prev * prevCount + next) / (prevCount + 1);
}
