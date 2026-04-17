import { z } from "zod";

/**
 * Structured task receipt schema (Phase 6).
 *
 * A TaskReceipt is the single authoritative record that a delegated task
 * actually ran and what its outcome was. The development runner rejects
 * freeform-text "success" signals in the main path — only receipts that pass
 * `TaskReceiptSchema.safeParse` can flip a task to completed.
 *
 * Freeform text is retained only as `freeformNotes` for debug attachments.
 */

export const TaskReceiptStatusSchema = z.enum([
  "success",
  "failed",
  "blocked",
  "partial",
]);

export type TaskReceiptStatus = z.infer<typeof TaskReceiptStatusSchema>;

/** Enum of known failure reason codes. Open-ended via `z.string()` fallback to
 *  remain forward-compatible with emergent reasons. */
export const FailureReasonCodeSchema = z.union([
  z.enum([
    "provider_limit",
    "verification_failed",
    "invalid_structured_output",
    "blocked_filesystem",
    "missing_output",
    "timeout",
    "dependency_unresolved",
    "permission_denied",
    "tool_error",
    "cancelled",
    "other",
  ]),
  z.string(),
]);

export type FailureReasonCode = z.infer<typeof FailureReasonCodeSchema>;

export const VerificationCommandResultSchema = z.object({
  command: z.string(),
  success: z.boolean(),
  stdoutSnippet: z.string().optional(),
  exitCode: z.number().optional(),
});

export type VerificationCommandResult = z.infer<
  typeof VerificationCommandResultSchema
>;

export const TaskReceiptSchema = z.object({
  taskId: z.string().min(1),
  taskTitle: z.string().min(1),
  teamMemberId: z.string().min(1),
  agentRole: z.string().min(1),
  model: z.string().min(1),
  sessionIds: z.array(z.string()),
  branchName: z.string().optional(),
  commitSha: z.string().optional(),
  changedFiles: z.array(z.string()),
  verificationCommands: z.array(VerificationCommandResultSchema),
  status: TaskReceiptStatusSchema,
  failureReasonCode: FailureReasonCodeSchema.optional(),
  /** Freeform text captured for debug only — does NOT influence success. */
  freeformNotes: z.string().optional(),
  startedAt: z.string().min(1),
  completedAt: z.string().min(1),
});

export type TaskReceipt = z.infer<typeof TaskReceiptSchema>;

/** A container batch-level response may use to ship multiple receipts at once. */
export const TaskReceiptEnvelopeSchema = z.object({
  receipts: z.array(TaskReceiptSchema),
});

export type TaskReceiptEnvelope = z.infer<typeof TaskReceiptEnvelopeSchema>;

/** A receipt status counts as "successful completion" iff it is exactly
 *  "success". "partial" and "blocked" are explicitly NOT success, even though
 *  they are not hard failures either. */
export function receiptIsSuccess(receipt: TaskReceipt): boolean {
  return receipt.status === "success";
}
