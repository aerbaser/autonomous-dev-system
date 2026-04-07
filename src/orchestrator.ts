import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./utils/config.js";
import {
  type ProjectState,
  type Phase,
  saveState,
  transitionPhase,
  canTransition,
} from "./state/project-state.js";
import { runIdeation } from "./phases/ideation.js";
import { runArchitecture } from "./phases/architecture.js";
import { runEnvironmentSetup } from "./phases/environment-setup.js";
import { runDevelopment } from "./phases/development.js";
import { runTesting } from "./phases/testing.js";
import { runReview } from "./phases/review.js";
import { runDeployment } from "./phases/deployment.js";
import { runABTesting } from "./phases/ab-testing.js";
import { runMonitoring } from "./phases/monitoring.js";

export interface PhaseResult {
  success: boolean;
  nextPhase?: Phase;
  state: ProjectState;
  error?: string;
}

type PhaseHandler = (state: ProjectState, config: Config) => Promise<PhaseResult>;

const PHASE_HANDLERS: Record<Phase, PhaseHandler> = {
  ideation: runIdeation,
  specification: async (state, config) => runIdeation(state, config), // ideation covers spec
  architecture: runArchitecture,
  "environment-setup": runEnvironmentSetup,
  development: runDevelopment,
  testing: runTesting,
  review: runReview,
  staging: runDeployment,
  "ab-testing": runABTesting,
  analysis: runABTesting, // analysis is part of AB testing
  production: runDeployment,
  monitoring: runMonitoring,
};

export async function runOrchestrator(
  initialState: ProjectState,
  config: Config,
  resumeSessionId?: string,
  singlePhase?: Phase
): Promise<void> {
  let state = { ...initialState };

  if (singlePhase) {
    console.log(`[orchestrator] Running single phase: ${singlePhase}`);
    const handler = PHASE_HANDLERS[singlePhase];
    if (!handler) {
      console.error(`[error] Unknown phase: ${singlePhase}`);
      return;
    }
    const result = await handler(state, config);
    saveState(config.stateDir, result.state);
    if (!result.success) {
      console.error(`[error] Phase ${singlePhase} failed: ${result.error}`);
    }
    return;
  }

  // Main orchestration loop
  const MAX_ITERATIONS = 100;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const phase = state.currentPhase;
    console.log(`\n[orchestrator] Phase ${iterations}: ${phase}`);

    const handler = PHASE_HANDLERS[phase];
    if (!handler) {
      console.error(`[error] No handler for phase: ${phase}`);
      break;
    }

    try {
      const result = await handler(state, config);
      state = result.state;
      saveState(config.stateDir, state);

      if (!result.success) {
        console.error(`[error] Phase ${phase} failed: ${result.error}`);
        // Retry logic: stay in same phase with error context
        continue;
      }

      if (result.nextPhase && canTransition(phase, result.nextPhase)) {
        state = transitionPhase(state, result.nextPhase);
        saveState(config.stateDir, state);
        console.log(`[orchestrator] Transition: ${phase} → ${result.nextPhase}`);
      } else if (phase === "monitoring") {
        // Monitoring is the terminal loop — it decides when to loop back
        console.log("[orchestrator] In monitoring loop. Waiting for next trigger...");
        break;
      } else {
        console.log(`[orchestrator] Phase ${phase} completed. No transition specified.`);
        break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[error] Unhandled error in phase ${phase}: ${message}`);
      saveState(config.stateDir, state);
      break;
    }
  }

  console.log(`\n[orchestrator] Finished. Final phase: ${state.currentPhase}`);
}
