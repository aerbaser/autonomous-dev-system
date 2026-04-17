// Types for the development phase
import type { TaskReceipt } from "../types/task-receipt.js";

export interface DevTask {
  id: string;
  title: string;
  description: string;
  estimatedComplexity: "low" | "medium" | "high";
  dependencies: string[]; // IDs of tasks this depends on
  acceptanceCriteria: string[];
  domain?: string; // agent name or role keyword for matching
  tags?: string[];
}

export interface TaskDecomposition {
  tasks: DevTask[];
}

export interface BatchResult {
  taskResults: TaskResult[];
  costUsd: number;
  sessionId?: string;
}

/**
 * Result of a single task execution.
 *
 * Phase 6: `success` is derived strictly from `receipt.status === "success"`.
 * It MUST NOT be set true from freeform-text heuristics. A task without a
 * valid structured receipt cannot be a success.
 */
export interface TaskResult {
  taskId: string;
  success: boolean;
  output?: string;
  result?: string;
  error?: string;
  /** Authoritative structured receipt. Required for any completed task. */
  receipt?: TaskReceipt;
}
