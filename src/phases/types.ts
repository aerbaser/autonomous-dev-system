import type { Config } from "../utils/config.js";
import type { ProjectState, Phase, PhaseCheckpoint } from "../state/project-state.js";

export interface PhaseResult {
  success: boolean;
  nextPhase?: Phase;
  state: ProjectState;
  error?: string;
  sessionId?: string;
  costUsd?: number;
}

export type PhaseHandler = (
  state: ProjectState,
  config: Config,
  checkpoint?: PhaseCheckpoint | null,
  sessionId?: string
) => Promise<PhaseResult>;
