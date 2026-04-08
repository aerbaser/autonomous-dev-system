import type { Config } from "./utils/config.js";
import {
  type ProjectState,
  type Phase,
  type PhaseCheckpoint,
  saveState,
  saveCheckpoint,
  getLatestCheckpoint,
  transitionPhase,
  canTransition,
} from "./state/project-state.js";
import {
  loadSessions,
  saveSessions,
  setSession,
  getSessionId,
  cleanStaleSessions,
} from "./state/session-store.js";
import { withRetry, isRetryableError } from "./utils/retry.js";
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
  sessionId?: string; // session ID from query() for resume
  costUsd?: number;
}

type PhaseHandler = (
  state: ProjectState,
  config: Config,
  checkpoint?: PhaseCheckpoint | null,
  sessionId?: string
) => Promise<PhaseResult>;

const PHASE_HANDLERS = {
  ideation: runIdeation,
  specification: async (state, config) => runIdeation(state, config),
  architecture: runArchitecture,
  "environment-setup": runEnvironmentSetup,
  development: runDevelopment,
  testing: runTesting,
  review: runReview,
  staging: runDeployment,
  "ab-testing": runABTesting,
  analysis: async (state, config) => runABTesting(state, config),
  production: runDeployment,
  monitoring: runMonitoring,
} satisfies Record<Phase, PhaseHandler>;

export async function runOrchestrator(
  initialState: ProjectState,
  config: Config,
  _resumeSessionId?: string,
  singlePhase?: Phase
): Promise<void> {
  let state = { ...initialState };

  // Clean up stale sessions on startup
  let sessionStore = loadSessions(config.stateDir);
  sessionStore = cleanStaleSessions(sessionStore);
  saveSessions(config.stateDir, sessionStore);

  if (singlePhase) {
    console.log(`[orchestrator] Running single phase: ${singlePhase}`);
    await executePhaseSafe(singlePhase, state, config);
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
      console.error(`[error] No handler for phase: ${phase}. This is a fatal error.`);
      saveState(config.stateDir, state);
      break;
    }

    const result = await executePhaseSafe(phase, state, config);
    if (!result) {
      // Fatal error already logged and state saved inside executePhaseSafe
      break;
    }

    state = result.state;
    saveState(config.stateDir, state);

    if (!result.success) {
      console.error(`[error] Phase ${phase} failed after retries: ${result.error}`);
      break;
    }

    if (result.nextPhase && canTransition(phase, result.nextPhase)) {
      state = transitionPhase(state, result.nextPhase);
      saveState(config.stateDir, state);
      console.log(`[orchestrator] Transition: ${phase} -> ${result.nextPhase}`);
    } else if (phase === "monitoring") {
      console.log("[orchestrator] In monitoring loop. Waiting for next trigger...");
      break;
    } else {
      console.log(`[orchestrator] Phase ${phase} completed. No transition specified.`);
      break;
    }
  }

  if (iterations >= MAX_ITERATIONS) {
    console.warn(`[orchestrator] Reached max iterations (${MAX_ITERATIONS}). Stopping.`);
  }

  console.log(`\n[orchestrator] Finished. Final phase: ${state.currentPhase}`);
}

/**
 * Execute a phase with retry logic, checkpoint management, and session tracking.
 * Returns null on fatal (non-retryable) errors.
 */
async function executePhaseSafe(
  phase: Phase,
  state: ProjectState,
  config: Config
): Promise<PhaseResult | null> {
  const handler = PHASE_HANDLERS[phase];
  if (!handler) {
    console.error(`[error] No handler for phase: ${phase}`);
    saveState(config.stateDir, state);
    return null;
  }

  // Load checkpoint and session for this phase
  const checkpoint = getLatestCheckpoint(state, phase);
  let sessionStore = loadSessions(config.stateDir);
  const sessionId = getSessionId(sessionStore, phase);

  if (checkpoint) {
    console.log(
      `[orchestrator] Resuming phase "${phase}" from checkpoint ` +
        `(${checkpoint.completedTasks.length} completed, ${checkpoint.pendingTasks.length} pending)`
    );
  }
  if (sessionId) {
    console.log(`[orchestrator] Resuming session ${sessionId} for phase "${phase}"`);
  }

  try {
    const result = await withRetry(
      async () => {
        // Save state before each attempt (crash safety)
        saveState(config.stateDir, state);

        const phaseResult = await handler(state, config, checkpoint, sessionId);

        // Store session ID if the phase returned one
        if (phaseResult.sessionId) {
          sessionStore = setSession(sessionStore, phase, phaseResult.sessionId);
          saveSessions(config.stateDir, sessionStore);
        }

        // Save checkpoint with current progress
        const phaseCheckpoint: PhaseCheckpoint = {
          phase,
          completedTasks: phaseResult.state.tasks
            .filter((t) => t.status === "completed")
            .map((t) => t.id),
          pendingTasks: phaseResult.state.tasks
            .filter((t) => t.status === "pending" || t.status === "in_progress")
            .map((t) => t.id),
          timestamp: new Date().toISOString(),
          metadata: {
            costUsd: phaseResult.costUsd,
            success: phaseResult.success,
          },
        };
        phaseResult.state = saveCheckpoint(phaseResult.state, phaseCheckpoint);

        if (!phaseResult.success) {
          // Throw so withRetry can decide whether to retry
          throw new Error(phaseResult.error ?? `Phase ${phase} failed`);
        }

        return phaseResult;
      },
      { maxRetries: 3 },
      (attempt, error, delayMs) => {
        console.warn(
          `[orchestrator] Phase "${phase}" failed (attempt ${attempt}/3): ${error.message}. ` +
            `Retrying in ${Math.round(delayMs / 1000)}s...`
        );
        // Save state before retry in case of crash
        saveState(config.stateDir, state);
      }
    );

    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const retryable = isRetryableError(error);

    if (retryable) {
      console.error(
        `[error] Phase "${phase}" failed after all retries: ${error.message}`
      );
    } else {
      console.error(
        `[error] Phase "${phase}" hit a fatal error (not retryable): ${error.message}`
      );
    }

    // Save state with error details
    saveState(config.stateDir, state);

    return {
      success: false,
      state,
      error: error.message,
    };
  }
}
