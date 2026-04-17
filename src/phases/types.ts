import type { ProjectState, Phase, PhaseCheckpoint } from "../state/project-state.js";
import type { Config } from "../utils/config.js";
import type { RubricResult } from "../evaluation/rubric.js";

export interface PhaseContext {
  memoryContext?: string | undefined;
  /** Rubric gaps from a previous evaluation iteration, injected for retry. */
  rubricFeedback?: string | undefined;
  /**
   * Stable prefix (memory + other reused static context) precomputed once by
   * the orchestrator and reused across rubric-retry iterations. Handlers
   * should pass it into `query(...)` as `options.systemPrompt` so Anthropic's
   * ephemeral cache can hit on repeat iterations.
   */
  cachedSystemPrompt?: string | undefined;
}

export interface PhaseResult {
  success: boolean;
  nextPhase?: Phase;
  state: ProjectState;
  error?: string;
  sessionId?: string;
  costUsd?: number;
  rubricResult?: RubricResult;
  /** Populated when config.dryRun=true — describes what this phase would do. */
  dryRunPlan?: string;
}

export interface PhaseExecutionContext {
  checkpoint?: PhaseCheckpoint;
  sessionId?: string;
  context?: PhaseContext;
  /**
   * AbortSignal sourced from the orchestrator's Interrupter. Phase handlers
   * should forward this into `consumeQuery({ signal })` so SIGINT / budget /
   * redirect interrupts cancel in-flight queries. Optional so tests and
   * direct-invocation callers can omit it.
   */
  signal?: AbortSignal;
}

export type PhaseHandler = (
  state: ProjectState,
  config: Config,
  ctx?: PhaseExecutionContext,
) => Promise<PhaseResult>;
