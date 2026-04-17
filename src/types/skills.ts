import { z } from "zod";

/**
 * Phase A — Skill Crystallization (L3 layered memory).
 *
 * A TaskSignature captures the durable "shape" of a task so that a successful
 * execution can be matched against future similar tasks. Signatures are
 * intentionally coarse — (domain, phase, titleKeywords) — so near-duplicate
 * work gets hit even when wording drifts.
 */
export const TaskSignatureSchema = z.object({
  domain: z.string(),
  phase: z.string(),
  titleKeywords: z.array(z.string()),
});

export type TaskSignature = z.infer<typeof TaskSignatureSchema>;

/**
 * A SkillPlaybook is a distilled, reusable record of a task that previously
 * succeeded. We store the files that were changed and the verification
 * commands that were run so the next similar task can short-circuit planning.
 */
export const SkillPlaybookSchema = z.object({
  id: z.string(),
  signature: TaskSignatureSchema,
  taskTitle: z.string(),
  changedFiles: z.array(z.string()),
  verificationCommands: z.array(z.string()),
  successCount: z.number(),
  useCount: z.number(),
  avgCostUsd: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SkillPlaybook = z.infer<typeof SkillPlaybookSchema>;
