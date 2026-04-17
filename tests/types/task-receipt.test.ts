import { describe, it, expect } from "vitest";
import {
  TaskReceiptSchema,
  TaskReceiptEnvelopeSchema,
  receiptIsSuccess,
} from "../../src/types/task-receipt.js";

function makeValidReceipt(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task-001",
    taskTitle: "Create task",
    teamMemberId: "dev-alpha",
    agentRole: "developer",
    model: "claude-sonnet-4-6",
    sessionIds: ["sess-1"],
    changedFiles: ["src/foo.ts"],
    verificationCommands: [
      { command: "npx tsc --noEmit", success: true, exitCode: 0 },
    ],
    status: "success",
    startedAt: "2026-04-17T10:00:00.000Z",
    completedAt: "2026-04-17T10:05:00.000Z",
    ...overrides,
  };
}

describe("TaskReceiptSchema", () => {
  it("accepts a fully populated success receipt", () => {
    const parsed = TaskReceiptSchema.safeParse(makeValidReceipt());
    expect(parsed.success).toBe(true);
  });

  it("rejects a receipt missing required fields (taskId)", () => {
    const { taskId: _unused, ...missing } = makeValidReceipt();
    void _unused;
    const parsed = TaskReceiptSchema.safeParse(missing);
    expect(parsed.success).toBe(false);
  });

  it("rejects a receipt with empty taskTitle", () => {
    const parsed = TaskReceiptSchema.safeParse(
      makeValidReceipt({ taskTitle: "" }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown status values", () => {
    const parsed = TaskReceiptSchema.safeParse(
      makeValidReceipt({ status: "maybe" }),
    );
    expect(parsed.success).toBe(false);
  });

  it("accepts status = 'blocked'", () => {
    const parsed = TaskReceiptSchema.safeParse(
      makeValidReceipt({
        status: "blocked",
        failureReasonCode: "blocked_filesystem",
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("accepts status = 'partial'", () => {
    const parsed = TaskReceiptSchema.safeParse(
      makeValidReceipt({ status: "partial" }),
    );
    expect(parsed.success).toBe(true);
  });

  it("accepts empty changedFiles and verificationCommands arrays", () => {
    const parsed = TaskReceiptSchema.safeParse(
      makeValidReceipt({ changedFiles: [], verificationCommands: [] }),
    );
    expect(parsed.success).toBe(true);
  });

  it("rejects verification command missing 'command' field", () => {
    const parsed = TaskReceiptSchema.safeParse(
      makeValidReceipt({
        verificationCommands: [{ success: true }],
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("freeformNotes is optional", () => {
    const r = makeValidReceipt();
    const parsed = TaskReceiptSchema.safeParse(r);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.freeformNotes).toBeUndefined();
  });

  it("receiptIsSuccess returns true ONLY for status=success", () => {
    const parsed = TaskReceiptSchema.parse(makeValidReceipt());
    expect(receiptIsSuccess(parsed)).toBe(true);

    const blocked = TaskReceiptSchema.parse(
      makeValidReceipt({ status: "blocked" }),
    );
    expect(receiptIsSuccess(blocked)).toBe(false);

    const partial = TaskReceiptSchema.parse(
      makeValidReceipt({ status: "partial" }),
    );
    expect(receiptIsSuccess(partial)).toBe(false);

    const failed = TaskReceiptSchema.parse(
      makeValidReceipt({ status: "failed", failureReasonCode: "timeout" }),
    );
    expect(receiptIsSuccess(failed)).toBe(false);
  });
});

describe("TaskReceiptEnvelopeSchema", () => {
  it("accepts multiple receipts", () => {
    const envelope = {
      receipts: [makeValidReceipt(), makeValidReceipt({ taskId: "task-002", taskTitle: "Delete task" })],
    };
    const parsed = TaskReceiptEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.receipts.length).toBe(2);
  });

  it("rejects envelope with malformed inner receipt", () => {
    const envelope = {
      receipts: [
        makeValidReceipt(),
        { taskId: "x" }, // missing fields
      ],
    };
    const parsed = TaskReceiptEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(false);
  });
});
