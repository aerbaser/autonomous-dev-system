import type { Config, RetryPolicy, RoleBudget } from "../utils/config.js";
import type { CanonicalFailureReasonCode } from "../types/failure-codes.js";

/**
 * Failure reason codes used by the governor's retry policy.
 *
 * Aliased to the canonical `CanonicalFailureReasonCode` (see
 * `src/types/failure-codes.ts`) so that governor decisions and run-ledger
 * entries share a single vocabulary. The governor currently only reacts
 * specifically to `provider_limit` and `verification_failed`; all other
 * codes (including `transient`, `timeout`, `unknown`, and the ledger-only
 * codes like `provider_rate_limit`, `invalid_structured_output`,
 * `blocked_filesystem`, `unsupported_team_runtime`) fall through to the
 * default "allow retry" path inside `shouldRetry`.
 */
export type FailureReason = CanonicalFailureReasonCode;

export type GovernorAction =
  | "allow"
  | "stop"
  | "downgrade"
  | "checkpoint";

export interface RetryDecision {
  action: GovernorAction;
  reason: string;
}

export interface StartDecision {
  action: "allow" | "stop";
  reason: string;
}

export interface FailureRecord {
  reason: FailureReason;
  /** Stable signature of the failure for identical-failure detection. */
  signature: string;
}

export interface SpendGovernorOptions {
  /** Total per-run budget ceiling in USD (mirrors `config.budgetUsd`). */
  totalBudgetUsd?: number;
  /** Per-role configuration (spend ceilings, concurrency, retry caps). */
  roles: Record<string, RoleBudget>;
  /** Retry / escalation policy per failure class. */
  retryPolicy: RetryPolicy;
  /** Optional per-phase budgets in USD. */
  phaseBudgetsUsd?: Record<string, number>;
}

export interface StopRecord {
  role?: string;
  phase?: string;
  reason: FailureReason | "budget_exceeded" | "concurrency_cap" | "identical_failure";
  action: GovernorAction;
  message: string;
  at: string;
}

/**
 * Phase 4 — Spend Governance & Quota Protection.
 *
 * Tracks spend per role/phase, enforces concurrency caps, and decides
 * whether to retry, checkpoint, downgrade, or stop after a failure.
 *
 * Call sites: phase/agent boundaries only. Existing retry loops stay
 * in place — the governor only adds a guard that short-circuits them.
 */
export class SpendGovernor {
  private readonly opts: SpendGovernorOptions;
  private readonly spendByRole = new Map<string, number>();
  private readonly spendByPhase = new Map<string, number>();
  private totalSpendUsd = 0;
  private readonly activeByRole = new Map<string, number>();
  private readonly retryCountByClass = new Map<FailureReason, number>();
  private readonly failureHistory: FailureRecord[] = [];
  private readonly stops: StopRecord[] = [];

  constructor(opts: SpendGovernorOptions) {
    this.opts = opts;
  }

  /** Record spend against a role (and optionally a phase). */
  trackSpend(role: string, usd: number, phase?: string): void {
    if (!Number.isFinite(usd) || usd <= 0) return;
    this.totalSpendUsd += usd;
    this.spendByRole.set(role, (this.spendByRole.get(role) ?? 0) + usd);
    if (phase) {
      this.spendByPhase.set(phase, (this.spendByPhase.get(phase) ?? 0) + usd);
    }
  }

  /** Current total run spend in USD. */
  getTotalSpendUsd(): number {
    return this.totalSpendUsd;
  }

  getRoleSpendUsd(role: string): number {
    return this.spendByRole.get(role) ?? 0;
  }

  getPhaseSpendUsd(phase: string): number {
    return this.spendByPhase.get(phase) ?? 0;
  }

  /** Snapshot of stop/downgrade decisions for the run report. */
  getStopRecords(): readonly StopRecord[] {
    return this.stops;
  }

  /**
   * Check whether a new agent can be started for `role` in `phase`.
   * Evaluates: total-budget, role-budget, phase-budget, and concurrency.
   */
  canStartAgent(role: string, phase?: string): StartDecision {
    const { totalBudgetUsd, roles, phaseBudgetsUsd } = this.opts;

    if (totalBudgetUsd !== undefined && this.totalSpendUsd >= totalBudgetUsd) {
      return this.recordStop(role, phase, "budget_exceeded", "stop",
        `Total run budget $${totalBudgetUsd.toFixed(2)} exhausted (spent $${this.totalSpendUsd.toFixed(2)}).`,
        { kind: "start" },
      );
    }

    const roleCfg = roles[role];
    if (roleCfg?.budgetUsd !== undefined) {
      const spent = this.spendByRole.get(role) ?? 0;
      if (spent >= roleCfg.budgetUsd) {
        return this.recordStop(role, phase, "budget_exceeded", "stop",
          `Role "${role}" spend cap $${roleCfg.budgetUsd.toFixed(2)} reached (spent $${spent.toFixed(2)}).`,
          { kind: "start" },
        );
      }
    }

    if (phase && phaseBudgetsUsd?.[phase] !== undefined) {
      const cap = phaseBudgetsUsd[phase];
      const spent = this.spendByPhase.get(phase) ?? 0;
      if (spent >= cap) {
        return this.recordStop(role, phase, "budget_exceeded", "stop",
          `Phase "${phase}" spend cap $${cap.toFixed(2)} reached (spent $${spent.toFixed(2)}).`,
          { kind: "start" },
        );
      }
    }

    if (roleCfg?.maxConcurrency !== undefined) {
      const active = this.activeByRole.get(role) ?? 0;
      if (active >= roleCfg.maxConcurrency) {
        return this.recordStop(role, phase, "concurrency_cap", "stop",
          `Role "${role}" concurrency cap ${roleCfg.maxConcurrency} reached (active ${active}).`,
          { kind: "start" },
        );
      }
    }

    return { action: "allow", reason: "within caps" };
  }

  /** Mark an agent as started (increments concurrency counter). */
  markAgentStarted(role: string): void {
    this.activeByRole.set(role, (this.activeByRole.get(role) ?? 0) + 1);
  }

  /** Mark an agent as finished (decrements concurrency counter). */
  markAgentFinished(role: string): void {
    const cur = this.activeByRole.get(role) ?? 0;
    this.activeByRole.set(role, Math.max(0, cur - 1));
  }

  /**
   * Decide whether to retry after a failure.
   *
   * Returns `stop` once attempts cross role or class caps, or when
   * identical-failure-abort trips. `provider_limit` returns whatever
   * `retryPolicy.provider_limit` mandates (checkpoint/downgrade/stop)
   * rather than a blind retry — so development doesn't restart from zero.
   */
  shouldRetry(
    reason: FailureReason,
    attempts: number,
    ctx: { role?: string; phase?: string; signature?: string } = {},
  ): RetryDecision {
    const { role, phase, signature } = ctx;

    // Identical-failure cheap abort.
    if (signature && this.opts.retryPolicy.identical_failure_abort) {
      const sameCount = this.failureHistory.filter(
        (f) => f.signature === signature && f.reason === reason,
      ).length;
      this.failureHistory.push({ reason, signature });
      if (sameCount >= 1) {
        return this.recordStop(role, phase, "identical_failure", "stop",
          `Identical failure signature repeated (reason=${reason}); aborting to avoid burn.`,
          { kind: "retry" },
        );
      }
    } else if (signature) {
      this.failureHistory.push({ reason, signature });
    }

    // Role-level retry cap.
    if (role !== undefined) {
      const roleCfg = this.opts.roles[role];
      if (roleCfg?.maxRetries !== undefined && attempts >= roleCfg.maxRetries) {
        return this.recordStop(role, phase, reason, "stop",
          `Role "${role}" max retries (${roleCfg.maxRetries}) exceeded for ${reason}.`,
          { kind: "retry" },
        );
      }
    }

    // Class-specific escalation.
    if (reason === "provider_limit") {
      const action = this.escalate("provider_limit");
      const msg = `Provider limit hit — policy=${this.opts.retryPolicy.provider_limit}; action=${action}`;
      if (action !== "allow") {
        this.recordStop(role, phase, reason, action, msg, { kind: "retry" });
      }
      return { action, reason: msg };
    }

    if (reason === "verification_failed") {
      const cap = this.opts.retryPolicy.verification_failed.maxAttempts;
      if (attempts >= cap) {
        return this.recordStop(role, phase, reason, "stop",
          `verification_failed max attempts (${cap}) exceeded.`,
          { kind: "retry" },
        );
      }
    }

    // Class-level attempt counter as a global safety net.
    this.retryCountByClass.set(reason, (this.retryCountByClass.get(reason) ?? 0) + 1);

    return { action: "allow", reason: `retry ${reason} (attempt ${attempts + 1})` };
  }

  /**
   * Map a failure class to the configured escalation action.
   * Only `provider_limit` currently has a per-class escalation knob;
   * other classes fall back to "allow" (retry path remains open).
   */
  escalate(reason: FailureReason): GovernorAction {
    if (reason === "provider_limit") {
      const policy = this.opts.retryPolicy.provider_limit;
      if (policy === "checkpoint") return "checkpoint";
      if (policy === "downgrade") return "downgrade";
      return "stop";
    }
    return "allow";
  }

  private recordStop(
    role: string | undefined,
    phase: string | undefined,
    reason: StopRecord["reason"],
    action: GovernorAction,
    message: string,
    _ctx: { kind: "start" | "retry" },
  ): StartDecision & RetryDecision {
    const rec: StopRecord = {
      reason,
      action,
      message,
      at: new Date().toISOString(),
      ...(role !== undefined ? { role } : {}),
      ...(phase !== undefined ? { phase } : {}),
    };
    this.stops.push(rec);
    return { action: action === "allow" ? "allow" : action, reason: message } as StartDecision & RetryDecision;
  }
}

/**
 * Convenience factory: build a governor from a loaded `Config`.
 * Keeps the governor's construction tied to the single source of truth.
 */
export function createSpendGovernor(
  config: Pick<Config, "budgetUsd" | "roles" | "retryPolicy">,
  phaseBudgetsUsd?: Record<string, number>,
): SpendGovernor {
  return new SpendGovernor({
    ...(config.budgetUsd !== undefined ? { totalBudgetUsd: config.budgetUsd } : {}),
    roles: config.roles,
    retryPolicy: config.retryPolicy,
    ...(phaseBudgetsUsd !== undefined ? { phaseBudgetsUsd } : {}),
  });
}

/**
 * Stable failure signature builder — hashing is overkill here; the
 * governor only needs a deterministic equality key.
 */
export function failureSignature(
  reason: FailureReason,
  detail: string,
): string {
  const trimmed = detail.trim().slice(0, 240);
  return `${reason}::${trimmed}`;
}
