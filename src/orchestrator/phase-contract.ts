import type { z } from "zod";
import type { ProjectState, Phase } from "../state/project-state.js";

/**
 * Sliced view of ProjectState passed to a lead-driven phase. Each phase's
 * contextSelector decides which slices are relevant. Full ProjectState is
 * intentionally NOT allowed — it would blow context windows by phase 8+.
 */
export interface PhaseContext {
  /** Human-readable summary lines the lead reads first. */
  summary: string[];
  /** Structured slices the lead may cite verbatim. Values MUST be JSON-serializable. */
  slices: Record<string, unknown>;
}

/**
 * Declarative contract for a lead-driven phase. Moves per-phase wiring
 * (goals, specialists, output schema, backloop policy) out of ad-hoc prompt
 * engineering into a typed boundary the primitive can reason about.
 */
export interface PhaseContract<TResult = unknown> {
  /** Phase this contract applies to. */
  phase: Phase;
  /**
   * Narrative goal injected into the lead prompt. Should answer: what does
   * "done" look like for this phase.
   */
  goals: string;
  /** Checklist of artifacts that must end up in state. */
  deliverables: string[];
  /**
   * Backloop targets the lead may legally request. MUST be a subset of
   * VALID_TRANSITIONS[phase] in src/state/project-state.ts. The orchestrator
   * re-validates via canTransition() as belt-and-suspenders.
   */
  allowedNextPhases: readonly Phase[];
  /**
   * Zod schema validating the lead's structured output. The lead's final
   * JSON MUST parse against this; failure triggers the repair-query fallback.
   */
  outputSchema: z.ZodSchema<TResult>;
  /**
   * Optional JSON shape hint inlined into the lead prompt after the
   * auto-generated envelope spec. Zod schemas are runtime objects that
   * can't be rendered back into a readable JSON example — the contract
   * author provides one explicitly. Without a hint, the lead has to
   * guess nested shapes from the deliverables prose and often gets
   * key names / array-vs-object wrong.
   *
   * Render verbatim — include placeholder values, comments as strings,
   * and "..." continuations to communicate intent.
   */
  outputShapeHint?: string;
  /**
   * Blueprint names pulled from AgentRegistry at query time. Order matters —
   * the lead sees them in this order in the <available-specialists> block.
   */
  specialistNames: readonly string[];
  /**
   * Projects ProjectState down to the slice relevant for this phase. MUST
   * return something JSON-serializable and bounded in size.
   */
  contextSelector: (state: ProjectState) => PhaseContext;
  /**
   * Per-phase spend ceiling in USD. When exceeded, the phase-level Interrupter
   * aborts with reason="budget" without killing the run-level Interrupter.
   * Optional — defaults to config.budgetUsd or Number.POSITIVE_INFINITY.
   */
  costCapUsd?: number;
  /**
   * Livelock guard. Caps how many times this phase may trigger a backloop to
   * the named target. Enforced by the orchestrator against state.backloopCounts.
   * Example: { development: 3 } means testing may ask to re-run development
   * at most 3 times before its backloop is denied.
   */
  maxBackloopsFromHere?: Partial<Record<Phase, number>>;
}
