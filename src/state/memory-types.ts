import { z } from "zod";

export const MemoryDocumentSchema = z.object({
  id: z.string(),
  topic: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int().nonnegative(),
  contentHash: z.string(),
  archived: z.boolean().default(false),
});

export type MemoryDocument = z.infer<typeof MemoryDocumentSchema>;

export const MemoryIndexEntrySchema = z.object({
  topic: z.string(),
  tags: z.array(z.string()),
  contentHash: z.string(),
  updatedAt: z.string(),
  archived: z.boolean().default(false),
});

export const MemoryIndexSchema = z.object({
  documents: z.record(z.string(), MemoryIndexEntrySchema),
});

export type MemoryIndex = z.infer<typeof MemoryIndexSchema>;

export const MemoryHistoryEntrySchema = z.object({
  timestamp: z.string(),
  operation: z.enum(["created", "updated", "deleted"]),
  contentHash: z.string(),
  contentPreview: z.string(),
});

export type MemoryHistoryEntry = z.infer<typeof MemoryHistoryEntrySchema>;

export const MemoryLearningSchema = z.object({
  topic: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
});

export const MemoryLearningsArraySchema = z.array(MemoryLearningSchema);
