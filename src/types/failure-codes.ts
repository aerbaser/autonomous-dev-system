import { z } from "zod";

/**
 * Canonical failure reason codes shared across modules that record or react
 * to agent failures. Defined in one place so `RunLedger` and `SpendGovernor`
 * (and anything else that logs failures) agree on the same vocabulary.
 *
 * This is a strict enum superset of the historical `RunLedger.ReasonCode`
 * and `SpendGovernor.FailureReason` types:
 *   - run-ledger contributed: `provider_limit`, `provider_rate_limit`,
 *     `invalid_structured_output`, `verification_failed`,
 *     `blocked_filesystem`, `unsupported_team_runtime`.
 *   - spend-governor contributed: `transient`, `timeout`, `unknown`.
 *
 * Consumers that need an open-ended code (e.g. `TaskReceipt` where an LLM may
 * volunteer a fresh reason string) should wrap this schema in a `z.union`
 * with `z.string()` instead of forking a separate enum.
 */
export const CanonicalFailureReasonCodeSchema = z.enum([
  "provider_limit",
  "provider_rate_limit",
  "invalid_structured_output",
  "verification_failed",
  "blocked_filesystem",
  "unsupported_team_runtime",
  "transient",
  "timeout",
  "unknown",
]);

export type CanonicalFailureReasonCode = z.infer<
  typeof CanonicalFailureReasonCodeSchema
>;
