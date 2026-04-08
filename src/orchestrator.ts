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
import type { PhaseResult, PhaseHandler } from "./phases/types.js";

export type { PhaseResult, PhaseHandler } from "./phases/types.js";

const PHASE_HANDLERS: Record<Phase, PhaseHandler> = {
  ideation: runIdeation,
  specification: async (state, _config) => ({
    success: true,
    nextPhase: "architecture",
    state,
  }),
  architecture: runArchitecture,
  "environment-setup": runEnvironmentSetup,
  development: runDevelopment,
  testing: runTesting,
  review: runReview,
  staging: runDeployment,
  "ab-testing": runABTesting,
  analysis: async (state, _config) => ({
    success: true,
    nextPhase: "production",
    state,
  }),
  production: runDeployment,
  monitoring: runMonitoring,
};

const ALL_PHASES: Phase[] = [
  "ideation", "specification", "architecture", "environment-setup",
  "development", "testing", "review", "staging",
  "ab-testing", "analysis", "production", "monitoring",
];

const OPTIONAL_PHASES: Phase[] = [
  "environment-setup",
  "review",
  "ab-testing",
  "monitoring",
];

function buildProgressBar(current: number, total: number): string {
  const pct = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * 10);
  const empty = 10 - filled;
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);
  return `${bar} ${pct}%`;
}

export async function runOrchestrator(
  initialState: ProjectState,
  config: Config,
  _resumeSessionId?: string,
  singlePhase?: Phase
): Promise<void> {
  let state = structuredClone(initialState);

  const { budgetUsd, dryRun, quickMode, confirmSpec } = config;

  // Budget tracking — TODO: wire up real costs from query() when available
  let totalCostUsd = 0;

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
    const phaseIndex = ALL_PHASES.indexOf(phase);
    const totalPhases = ALL_PHASES.length;

    // Progress indicator
    console.log(
      `\n[progress] Phase ${phaseIndex + 1}/${totalPhases}: ${phase} ${buildProgressBar(phaseIndex + 1, totalPhases)}`
    );

    console.log(`[orchestrator] Phase ${iterations}: ${phase}`);

    // Quick mode: skip optional phases
    if (quickMode && OPTIONAL_PHASES.includes(phase)) {
      console.log(`[quick] Skipping optional phase: ${phase}`);
      // Attempt to find a valid next phase by looking at the phase after this one
      const nextIndex = phaseIndex + 1;
      const nextPhase = ALL_PHASES[nextIndex];
      if (nextPhase !== undefined) {
        if (canTransition(phase, nextPhase)) {
          state = transitionPhase(state, nextPhase);
          saveState(config.stateDir, state);
          console.log(`[orchestrator] Transition: ${phase} -> ${nextPhase}`);
          continue;
        }
      }
      // If no valid transition found, just break
      console.log(`[orchestrator] No valid transition from skipped phase: ${phase}. Stopping.`);
      break;
    }

    const handler = PHASE_HANDLERS[phase];
    if (!handler) {
      console.error(`[error] No handler for phase: ${phase}. This is a fatal error.`);
      saveState(config.stateDir, state);
      break;
    }

    // Dry-run mode: log what would happen without executing
    if (dryRun) {
      console.log(`[dry-run] Would run phase: ${phase}`);
    }

    const phaseStart = Date.now();

    let result: PhaseResult | null;
    if (dryRun) {
      // In dry-run mode, simulate a successful result without calling handlers
      result = {
        success: true,
        state,
      };
    } else {
      result = await executePhaseSafe(phase, state, config);
    }

    const elapsed = ((Date.now() - phaseStart) / 1000).toFixed(1);
    console.log(`[progress] ${phase} completed in ${elapsed}s`);

    if (!result) {
      // Fatal error already logged and state saved inside executePhaseSafe
      break;
    }

    // Budget tracking — accumulate cost if reported
    // TODO: wire up real costs from query() return values
    if (result.costUsd) {
      totalCostUsd += result.costUsd;
      console.log(`[budget] Phase cost: $${result.costUsd.toFixed(2)}, total: $${totalCostUsd.toFixed(2)}`);
    }

    if (budgetUsd !== undefined && totalCostUsd > budgetUsd) {
      console.log(`[budget] Budget exceeded ($${totalCostUsd.toFixed(2)}/$${budgetUsd.toFixed(2)}). Stopping.`);
      break;
    }

    state = result.state;
    saveState(config.stateDir, state);

    if (!result.success) {
      console.error(`[error] Phase ${phase} failed after retries: ${result.error}`);
      break;
    }

    // Confirm-spec pause: wait for user confirmation after specification phase
    if (phase === "specification" && confirmSpec) {
      if (state.spec) {
        console.log(`[confirm] Spec summary: ${state.spec.summary}`);
        console.log(
          `[confirm] User stories: ${state.spec.userStories.length}, ` +
          `NFRs: ${state.spec.nonFunctionalRequirements.length}`
        );
      }
      console.log(
        "[confirm] Spec generated. Review above and press Enter to continue, or Ctrl+C to abort."
      );
      await new Promise((resolve) => process.stdin.once("data", resolve));
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

  console.log(`\n[orchestrator] Finished. Final phase: ${state.currentPhase}, total cost: $${totalCostUsd.toFixed(2)}`);
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
