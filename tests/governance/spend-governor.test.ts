import { describe, it, expect } from "vitest";
import {
  SpendGovernor,
  createSpendGovernor,
  failureSignature,
} from "../../src/governance/spend-governor.js";
import type { RetryPolicy } from "../../src/utils/config.js";

function defaultRetryPolicy(over: Partial<RetryPolicy> = {}): RetryPolicy {
  return {
    provider_limit: "checkpoint",
    verification_failed: { maxAttempts: 2 },
    identical_failure_abort: true,
    ...over,
  };
}

describe("SpendGovernor — spend caps", () => {
  it("allows agent start when under caps", () => {
    const g = new SpendGovernor({
      totalBudgetUsd: 10,
      roles: { developer: { budgetUsd: 5 } },
      retryPolicy: defaultRetryPolicy(),
    });
    expect(g.canStartAgent("developer").action).toBe("allow");
  });

  it("stops when total run budget is exhausted", () => {
    const g = new SpendGovernor({
      totalBudgetUsd: 1,
      roles: {},
      retryPolicy: defaultRetryPolicy(),
    });
    g.trackSpend("developer", 1.5);
    const d = g.canStartAgent("developer");
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/budget/i);
    expect(g.getStopRecords()).toHaveLength(1);
    expect(g.getStopRecords()[0]?.reason).toBe("budget_exceeded");
  });

  it("stops when per-role budget is exhausted", () => {
    const g = new SpendGovernor({
      roles: { qa: { budgetUsd: 0.5 } },
      retryPolicy: defaultRetryPolicy(),
    });
    g.trackSpend("qa", 0.75);
    expect(g.canStartAgent("qa").action).toBe("stop");
    // other roles are unaffected
    expect(g.canStartAgent("developer").action).toBe("allow");
  });

  it("stops when per-phase budget is exhausted", () => {
    const g = new SpendGovernor({
      roles: {},
      retryPolicy: defaultRetryPolicy(),
      phaseBudgetsUsd: { development: 1 },
    });
    g.trackSpend("developer", 1.25, "development");
    expect(g.canStartAgent("developer", "development").action).toBe("stop");
    expect(g.canStartAgent("developer", "testing").action).toBe("allow");
  });
});

describe("SpendGovernor — concurrency caps", () => {
  it("enforces max concurrent children for a role", () => {
    const g = new SpendGovernor({
      roles: { developer: { maxConcurrency: 2 } },
      retryPolicy: defaultRetryPolicy(),
    });
    expect(g.canStartAgent("developer").action).toBe("allow");
    g.markAgentStarted("developer");
    g.markAgentStarted("developer");
    expect(g.canStartAgent("developer").action).toBe("stop");
    g.markAgentFinished("developer");
    expect(g.canStartAgent("developer").action).toBe("allow");
  });
});

describe("SpendGovernor — retry policy", () => {
  it("returns checkpoint for provider_limit by default", () => {
    const g = new SpendGovernor({
      roles: {},
      retryPolicy: defaultRetryPolicy(),
    });
    const d = g.shouldRetry("provider_limit", 0, { role: "developer", phase: "development" });
    expect(d.action).toBe("checkpoint");
    // Records stop action for the run report
    expect(g.getStopRecords().some((s) => s.reason === "provider_limit")).toBe(true);
  });

  it("honors provider_limit=stop policy", () => {
    const g = new SpendGovernor({
      roles: {},
      retryPolicy: defaultRetryPolicy({ provider_limit: "stop" }),
    });
    expect(g.shouldRetry("provider_limit", 0).action).toBe("stop");
  });

  it("honors provider_limit=downgrade policy", () => {
    const g = new SpendGovernor({
      roles: {},
      retryPolicy: defaultRetryPolicy({ provider_limit: "downgrade" }),
    });
    expect(g.shouldRetry("provider_limit", 0).action).toBe("downgrade");
  });

  it("stops verification_failed after max attempts", () => {
    const g = new SpendGovernor({
      roles: {},
      retryPolicy: defaultRetryPolicy({
        verification_failed: { maxAttempts: 2 },
      }),
    });
    expect(g.shouldRetry("verification_failed", 0).action).toBe("allow");
    expect(g.shouldRetry("verification_failed", 1).action).toBe("allow");
    expect(g.shouldRetry("verification_failed", 2).action).toBe("stop");
  });

  it("stops when per-role maxRetries exceeded", () => {
    const g = new SpendGovernor({
      roles: { developer: { maxRetries: 1 } },
      retryPolicy: defaultRetryPolicy(),
    });
    expect(g.shouldRetry("transient", 0, { role: "developer" }).action).toBe("allow");
    expect(g.shouldRetry("transient", 1, { role: "developer" }).action).toBe("stop");
  });
});

describe("SpendGovernor — identical failure abort", () => {
  it("aborts after the second identical failure signature", () => {
    const g = new SpendGovernor({
      roles: {},
      retryPolicy: defaultRetryPolicy({ identical_failure_abort: true }),
    });
    const sig = failureSignature("transient", "ECONNRESET on api.anthropic.com");
    expect(
      g.shouldRetry("transient", 0, { signature: sig }).action,
    ).toBe("allow");
    const second = g.shouldRetry("transient", 1, { signature: sig });
    expect(second.action).toBe("stop");
    expect(second.reason).toMatch(/identical/i);
    expect(
      g.getStopRecords().some((s) => s.reason === "identical_failure"),
    ).toBe(true);
  });

  it("does not abort when identical_failure_abort is disabled", () => {
    const g = new SpendGovernor({
      roles: {},
      retryPolicy: defaultRetryPolicy({ identical_failure_abort: false }),
    });
    const sig = failureSignature("transient", "same");
    expect(g.shouldRetry("transient", 0, { signature: sig }).action).toBe("allow");
    expect(g.shouldRetry("transient", 1, { signature: sig }).action).toBe("allow");
  });

  it("different signatures do not trip the abort", () => {
    const g = new SpendGovernor({
      roles: {},
      retryPolicy: defaultRetryPolicy(),
    });
    expect(
      g.shouldRetry("transient", 0, { signature: failureSignature("transient", "a") })
        .action,
    ).toBe("allow");
    expect(
      g.shouldRetry("transient", 1, { signature: failureSignature("transient", "b") })
        .action,
    ).toBe("allow");
  });
});

describe("SpendGovernor — factory & reporting", () => {
  it("createSpendGovernor wires config budgets/roles/policy", () => {
    const g = createSpendGovernor(
      {
        budgetUsd: 2,
        roles: { developer: { budgetUsd: 1 } },
        retryPolicy: defaultRetryPolicy(),
      },
      { development: 0.5 },
    );
    g.trackSpend("developer", 0.6, "development");
    expect(g.canStartAgent("developer", "development").action).toBe("stop");
    expect(g.getTotalSpendUsd()).toBeCloseTo(0.6, 5);
    expect(g.getRoleSpendUsd("developer")).toBeCloseTo(0.6, 5);
    expect(g.getPhaseSpendUsd("development")).toBeCloseTo(0.6, 5);
  });

  it("run report captures which policy stopped execution", () => {
    const g = new SpendGovernor({
      roles: { developer: { budgetUsd: 0.1 } },
      retryPolicy: defaultRetryPolicy({ provider_limit: "stop" }),
    });
    g.trackSpend("developer", 1);
    g.canStartAgent("developer"); // budget_exceeded
    g.shouldRetry("provider_limit", 0, { role: "developer" }); // provider_limit stop
    const stops = g.getStopRecords();
    expect(stops.map((s) => s.reason)).toEqual([
      "budget_exceeded",
      "provider_limit",
    ]);
    expect(stops[0]?.action).toBe("stop");
    expect(stops[1]?.action).toBe("stop");
    for (const s of stops) {
      expect(typeof s.message).toBe("string");
      expect(typeof s.at).toBe("string");
    }
  });
});
