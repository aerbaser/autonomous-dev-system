import type { ProjectState, Phase, PhaseCheckpoint } from "../state/project-state.js";
import type { Config } from "../utils/config.js";
import type { RubricResult } from "../evaluation/rubric.js";
import type { EventBus } from "../events/event-bus.js";

export interface PhaseContext {
  memoryContext?: string | undefined;
  /** Rubric gaps from a previous evaluation iteration, injected for retry. */
  rubricFeedback?: string | undefined;
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
  eventBus?: EventBus;
}

export type PhaseHandler = (
  state: ProjectState,
  config: Config,
  ctx?: PhaseExecutionContext,
) => Promise<PhaseResult>;
