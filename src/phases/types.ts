import type { ProjectState, Phase, PhaseCheckpoint } from "../state/project-state.js";
import type { Config } from "../utils/config.js";

export interface PhaseResult {
  success: boolean;
  nextPhase?: Phase;
  state: ProjectState;
  error?: string;
  sessionId?: string; // session ID from query() for resume
  costUsd?: number;
}

export type PhaseHandler = (
  state: ProjectState,
  config: Config,
  checkpoint?: PhaseCheckpoint | null,
  sessionId?: string
) => Promise<PhaseResult>;
