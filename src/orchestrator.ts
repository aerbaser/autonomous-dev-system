import type { Config } from "./utils/config.js";
import { progress } from "./utils/progress.js";
import {
  type ProjectState,
  type Phase,
  type PhaseCheckpoint,
  ALL_PHASES,
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
import { runSpecification } from "./phases/specification.js";
import { runArchitecture } from "./phases/architecture.js";
import { runEnvironmentSetup } from "./phases/environment-setup.js";
import { runDevelopment } from "./phases/development.js";
import { runTesting } from "./phases/testing.js";
import { runReview } from "./phases/review.js";
import { runDeployment } from "./phases/deployment.js";
import { runABTesting } from "./phases/ab-testing.js";
import { runAnalysis } from "./phases/analysis.js";
import { runMonitoring } from "./phases/monitoring.js";
import type { PhaseResult, PhaseHandler, PhaseContext, PhaseExecutionContext } from "./phases/types.js";
import { EventBus } from "./events/event-bus.js";
import { EventLogger } from "./events/event-logger.js";
import { Interrupter } from "./events/interrupter.js";
import { MemoryStore } from "./state/memory-store.js";
import { capturePhaseMemories } from "./hooks/memory-capture.js";
import { errMsg } from "./utils/shared.js";
import { randomUUID } from "node:crypto";
import { getPhaseRubric } from "./evaluation/phase-rubrics.js";
import { gradePhaseOutput } from "./evaluation/grader.js";
import type { RubricResult } from "./evaluation/rubric.js";

export type { PhaseResult, PhaseHandler } from "./phases/types.js";

// --- Interrupter (scoped per runOrchestrator invocation) ---
// Module-level reference allows external callers (e.g. SIGINT handler) to reach
// the most-recently-started orchestrator's interrupter. Concurrent orchestrators
// each get their own Interrupter instance — getInterrupter() returns the latest one.
let _activeInterrupter = new Interrupter();

export function getInterrupter(): Interrupter {
  return _activeInterrupter;
}

const PHASE_HANDLERS: Record<Phase, PhaseHandler> = {
  ideation: runIdeation,
  specification: runSpecification,
  architecture: runArchitecture,
  "environment-setup": runEnvironmentSetup,
  development: runDevelopment,
  testing: runTesting,
  review: runReview,
  staging: runDeployment,
  "ab-testing": runABTesting,
  analysis: runAnalysis,
  production: runDeployment,
  monitoring: runMonitoring,
};

const OPTIONAL_PHASES: Phase[] = [
  "review",
  "ab-testing",
  "monitoring",
];

/** Static execution plan shown when --dry-run is active. */
const PHASE_DRY_RUN_PLANS: Record<Phase, { description: string; agents: number; turns: number; tools: string[] }> = {
  ideation: {
    description: "Analyze the idea, run domain classification, generate product spec with user stories, acceptance criteria, competitive analysis, target audience, MVP scope and tech stack recommendation.",
    agents: 2,
    turns: 8,
    tools: ["WebSearch", "WebFetch"],
  },
  specification: {
    description: "Expand the ideation spec into implementation-ready detail: refined Given/When/Then acceptance criteria, concrete NFR thresholds, explicit out-of-scope, integration boundaries.",
    agents: 1,
    turns: 6,
    tools: [],
  },
  architecture: {
    description: "Design full system architecture: tech stack selection, component breakdown, API contracts, database schema, file structure, task decomposition with acceptance criteria and dependency graph.",
    agents: 3,
    turns: 10,
    tools: ["WebSearch", "WebFetch"],
  },
  "environment-setup": {
    description: "Detect and configure LSP, MCP servers, plugins, and development environment for the chosen tech stack.",
    agents: 2,
    turns: 6,
    tools: ["Bash", "Read", "Write"],
  },
  development: {
    description: "Implement all tasks in dependency order using parallel agent batches. Each task gets its own agent with domain-specific context.",
    agents: 8,
    turns: 30,
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch"],
  },
  testing: {
    description: "Run unit, integration, and e2e test suites; analyze coverage; detect regressions; produce a test report.",
    agents: 3,
    turns: 12,
    tools: ["Bash", "Read", "Glob", "Grep"],
  },
  review: {
    description: "Code review for quality, security (OWASP), performance, and adherence to architecture spec.",
    agents: 2,
    turns: 8,
    tools: ["Read", "Glob", "Grep", "WebSearch"],
  },
  staging: {
    description: "Build, containerize, and deploy to staging environment; run smoke tests against staging URL.",
    agents: 2,
    turns: 8,
    tools: ["Bash", "Read", "Write", "WebFetch"],
  },
  "ab-testing": {
    description: "Design A/B test variants, configure feature flags, deploy both variants, collect metrics.",
    agents: 2,
    turns: 6,
    tools: ["WebSearch", "WebFetch", "Bash"],
  },
  analysis: {
    description: "Analyze A/B test results, determine winner, generate business insights report.",
    agents: 1,
    turns: 4,
    tools: ["WebFetch"],
  },
  production: {
    description: "Deploy winning variant to production with zero-downtime strategy; run health checks.",
    agents: 2,
    turns: 8,
    tools: ["Bash", "WebFetch"],
  },
  monitoring: {
    description: "Monitor production metrics, error rates, latency; trigger development cycle if regressions detected.",
    agents: 1,
    turns: 4,
    tools: ["WebFetch", "Bash"],
  },
};

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
  resumeSessionId?: string,
  singlePhase?: Phase
): Promise<void> {
  // Each invocation gets its own Interrupter so concurrent runs don't interfere.
  const interrupter = new Interrupter();
  _activeInterrupter = interrupter;

  const sigintHandler = () => {
    interrupter.interrupt("SIGINT");
  };
  process.on("SIGINT", sigintHandler);

  let state = structuredClone(initialState);

  const { budgetUsd, dryRun, quickMode, confirmSpec } = config;

  // Event architecture
  const eventBus = new EventBus();
  const runId = randomUUID();
  const eventLogger = new EventLogger(config.stateDir, runId);
  const unsubLogger = eventBus.onAll((record) => {
    eventLogger.log(record).catch((err) => {
      console.error(`[event-logger] Failed to write event: ${err}`);
    });
  });

  // Memory store (persistent cross-session knowledge)
  const memoryStore = config.memory?.enabled
    ? new MemoryStore(config.stateDir, {
        maxDocuments: config.memory.maxDocuments,
        maxDocumentSizeKb: config.memory.maxDocumentSizeKb,
      })
    : null;

  let totalCostUsd = 0;

  // Clean up stale sessions on startup
  let sessionStore = loadSessions(config.stateDir);
  sessionStore = cleanStaleSessions(sessionStore);
  saveSessions(config.stateDir, sessionStore);

  try {

  // Validate resume session ID if provided
  if (resumeSessionId) {
    const existingSession = getSessionId(sessionStore, state.currentPhase);
    if (existingSession) {
      console.log(`[orchestrator] Using resume session: ${existingSession}`);
    } else {
      console.warn(`[orchestrator] Resume session requested but no stored session found for phase "${state.currentPhase}". Proceeding without session.`);
    }
  }

  if (singlePhase) {
    console.log(`[orchestrator] Running single phase: ${singlePhase}`);
    const singlePhaseResult = await executePhaseSafe(singlePhase, state, config, eventBus);
    if (singlePhaseResult) {
      saveState(config.stateDir, singlePhaseResult.state);
    }
    unsubLogger();
    await eventLogger.close();
    return;
  }

  // Main orchestration loop
  const MAX_ITERATIONS = 100;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    if (interrupter.isInterrupted()) {
      const reason = interrupter.getReason() ?? "unknown";
      eventBus.emit("orchestrator.interrupt", {
        phase: state.currentPhase,
        reason,
        redirectTo: interrupter.getRedirectPhase(),
      });
      progress.emit("shutdown", { phase: state.currentPhase });
      console.log(`[shutdown] Graceful shutdown (${reason}). State saved at phase: ${state.currentPhase}`);
      saveState(config.stateDir, state);
      break;
    }

    iterations++;
    const phase = state.currentPhase;
    const phaseIndex = ALL_PHASES.indexOf(phase);
    const totalPhases = ALL_PHASES.length;

    // Progress indicator
    console.log(
      `\n[progress] Phase ${phaseIndex + 1}/${totalPhases}: ${phase} ${buildProgressBar(phaseIndex + 1, totalPhases)}`
    );

    progress.emit("phase:start", { phase, index: phaseIndex, total: totalPhases });
    eventBus.emit("orchestrator.phase.start", { phase });
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
      const plan = PHASE_DRY_RUN_PLANS[phase];
      console.log(`\n[dry-run] ── Phase: ${phase} ──────────────────────────────`);
      console.log(`[dry-run]   What:   ${plan.description}`);
      if (plan.agents > 0) {
        console.log(`[dry-run]   Agents: ~${plan.agents}  |  Max turns: ~${plan.turns}`);
        console.log(`[dry-run]   Tools:  ${plan.tools.join(", ")}`);
      }
    }

    // Inject knowledge from previous sessions
    let memoryContext: string | undefined;
    if (memoryStore) {
      try {
        const memories = await memoryStore.search(phase, { limit: 5 });
        eventBus.emit("memory.recall", {
          phase,
          key: phase,
          found: memories.length > 0,
        });
        if (memories.length > 0) {
          memoryContext = "## Knowledge from previous sessions\n" +
            memories.map((m) => `- **${m.topic}**: ${m.content}`).join("\n");
          console.log(`[memory] Injected ${memories.length} memory document(s) for phase "${phase}"`);
        }
      } catch (err) {
        console.warn(`[memory] Failed to search memories for phase "${phase}": ${errMsg(err)}`);
      }
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
      result = await executePhaseSafe(phase, state, config, eventBus, memoryContext);
    }

    const elapsedMs = Date.now() - phaseStart;
    const elapsed = (elapsedMs / 1000).toFixed(1);
    const phaseSuccess = result?.success ?? false;
    progress.emit("phase:end", { phase, success: phaseSuccess, elapsed: elapsedMs });
    eventBus.emit("orchestrator.phase.end", {
      phase,
      success: phaseSuccess,
      costUsd: result?.costUsd,
      durationMs: elapsedMs,
    });
    console.log(`[progress] ${phase} completed in ${elapsed}s`);

    if (!result) {
      // Fatal error already logged and state saved inside executePhaseSafe
      break;
    }

    if (result.costUsd) {
      totalCostUsd += result.costUsd;
      console.log(`[budget] Phase cost: $${result.costUsd.toFixed(4)}, total: $${totalCostUsd.toFixed(4)}`);
    }

    // Persist running cost total into state so it survives checkpoints/resume
    state = { ...result.state, totalCostUsd };

    // Track completed phases and their results
    state = {
      ...state,
      completedPhases: [...(state.completedPhases ?? []), phase],
      phaseResults: {
        ...(state.phaseResults ?? {}),
        [phase]: {
          success: result.success,
          ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
          timestamp: new Date().toISOString(),
        },
      },
    };

    if (budgetUsd !== undefined && totalCostUsd > budgetUsd) {
      console.log(`[budget] Budget exceeded ($${totalCostUsd.toFixed(4)}/$${budgetUsd.toFixed(4)}). Stopping.`);
      saveState(config.stateDir, state);
      break;
    }

    // Capture learnings from this phase
    if (memoryStore && result.success) {
      try {
        await capturePhaseMemories(result, phase, memoryStore, config, eventBus);
      } catch (err) {
        console.warn(`[memory] Failed to capture memories for phase "${phase}": ${errMsg(err)}`);
      }
    }

    // Write rubric feedback to memory store for future sessions
    if (memoryStore && result.rubricResult) {
      try {
        await memoryStore.write(
          `rubric-feedback-${phase}`,
          result.rubricResult.summary,
          [phase, "rubric", result.rubricResult.verdict],
        );
        eventBus.emit("memory.capture", {
          phase,
          key: `rubric-feedback-${phase}`,
          summary: result.rubricResult.summary.slice(0, 100),
        });
      } catch (err) {
        console.warn(`[memory] Failed to save rubric feedback for phase "${phase}": ${errMsg(err)}`);
      }
    }

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
      if (process.stdin.isTTY) {
        console.log(
          "[confirm] Spec generated. Review above and press Enter to continue, or Ctrl+C to abort."
        );
        await new Promise((resolve) => process.stdin.once("data", resolve));
      } else {
        console.log("[confirm] Non-interactive stdin detected; continuing without pause.");
      }
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

  // Clean up event logger
  unsubLogger();
  await eventLogger.close();
  console.log(`[event-logger] Run events saved: ${eventLogger.getLogPath()}`);

  } finally {
    process.removeListener("SIGINT", sigintHandler);
  }
}

/**
 * Execute a phase with retry logic, checkpoint management, and session tracking.
 * Returns null on fatal (non-retryable) errors.
 */
async function executePhaseSafe(
  phase: Phase,
  state: ProjectState,
  config: Config,
  eventBus?: EventBus,
  memoryContext?: string,
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

        const context: PhaseContext | undefined = memoryContext ? { memoryContext } : undefined;
        const execCtx: PhaseExecutionContext = {
          ...(checkpoint ? { checkpoint } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(context ? { context } : {}),
        };
        const phaseResult = await handler(state, config, execCtx);

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
      }
    );

    // Rubric evaluation: if enabled and phase has a rubric, grade the result.
    // Uses result.state (post-phase) and injects gap feedback into PhaseContext
    // for each retry so the handler can address gaps on the next iteration.
    if (config.rubrics?.enabled && result.success) {
      const rubric = getPhaseRubric(phase);
      if (rubric) {
        console.log(`[rubric] Evaluating phase "${phase}" against rubric "${rubric.name}"`);
        const maxIter = config.rubrics?.maxIterations ?? 3;
        const baseCtx: PhaseContext = memoryContext ? { memoryContext } : {};
        let currentState = result.state; // post-phase state, not pre-phase
        let rubricFeedback: string | undefined;
        let lastRubricResult: RubricResult | null = null;
        let rubricCost = result.costUsd ?? 0;

        for (let iter = 1; iter <= maxIter; iter++) {
          eventBus?.emit("evaluation.rubric.start", { phase, rubricName: rubric.name, iteration: iter });

          // Build context: base memory + rubric feedback injected for retries
          const ctx: PhaseContext = rubricFeedback
            ? { ...baseCtx, rubricFeedback }
            : baseCtx;

          // First iteration reuses the already-executed result (no double execution).
          // Subsequent iterations re-run the handler with updated state + feedback.
          const iterExecCtx: PhaseExecutionContext = {
            ...(checkpoint ? { checkpoint } : {}),
            ...(sessionId ? { sessionId } : {}),
            context: ctx,
          };
          const iterResult =
            iter === 1 ? result : await handler(currentState, config, iterExecCtx);

          currentState = iterResult.state;
          if (iter > 1 && iterResult.costUsd) rubricCost += iterResult.costUsd;

          if (!iterResult.success) {
            const failRubric: RubricResult = {
              rubricName: rubric.name,
              scores: [],
              verdict: "failed",
              overallScore: 0,
              summary: `Phase handler failed: ${iterResult.error ?? "unknown error"}`,
              iteration: iter,
            };
            eventBus?.emit("evaluation.rubric.end", {
              phase, rubricName: rubric.name, result: "failed", iteration: iter,
            });
            return { ...iterResult, costUsd: rubricCost, rubricResult: failRubric };
          }

          const graderModel = config.rubrics?.graderModel;
          const { rubricResult, costUsd: graderCost } = await gradePhaseOutput(
            rubric,
            iterResult,
            currentState,
            {
              ...(graderModel ? { model: graderModel } : {}),
              ...(eventBus ? { eventBus } : {}),
              config,
              phase,
            },
          );
          rubricCost += graderCost;
          rubricResult.iteration = iter;
          lastRubricResult = rubricResult;

          console.log(
            `[rubric] Iteration ${iter}/${maxIter}: verdict=${rubricResult.verdict}, ` +
            `score=${rubricResult.overallScore.toFixed(2)}`
          );
          eventBus?.emit("evaluation.rubric.end", {
            phase, rubricName: rubric.name, result: rubricResult.verdict, iteration: iter,
          });

          if (rubricResult.verdict === "satisfied" || rubricResult.verdict === "failed") {
            return { ...iterResult, costUsd: rubricCost, rubricResult };
          }

          // needs_revision: inject gap feedback into context for the next iteration
          if (iter < maxIter) {
            rubricFeedback =
              "## Rubric Feedback — Items to Address\n" +
              rubricResult.scores
                .filter((s) => !s.passed)
                .map((s) => `- ${s.criterionName}: ${s.feedback}`)
                .join("\n");
            console.log(`[rubric] Feedback for next iteration:\n${rubricFeedback}`);
          }
        }

        // Exhausted iterations without reaching satisfied/failed
        if (!lastRubricResult) throw new Error("rubric loop: no rubric result after iterations");
        return {
          ...result,
          costUsd: rubricCost,
          rubricResult: lastRubricResult,
        };
      }
    }

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
