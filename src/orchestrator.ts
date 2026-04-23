import { resolveAuxiliaryFlags, type Config } from "./utils/config.js";
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
  withStateLock,
} from "./state/project-state.js";
import { OPTIONAL_PHASES } from "./types/phases.js";
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
import { generateDashboard } from "./dashboard/generate.js";
import { MemoryStore } from "./state/memory-store.js";
import { LayeredMemory } from "./memory/layers.js";
import { RunLedger, setActiveLedger, getActiveLedger } from "./state/run-ledger.js";
import { capturePhaseMemories } from "./hooks/memory-capture.js";
import { errMsg } from "./utils/shared.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { getPhaseRubric } from "./evaluation/phase-rubrics.js";
import { gradePhaseOutput } from "./evaluation/grader.js";
import type { RubricResult } from "./evaluation/rubric.js";
import { buildEnvelope, type ExecutionEnvelope } from "./runtime/execution-envelope.js";
import {
  runCodexPreflight,
  UnsupportedTeamRuntimeError,
  isNightlyRun,
} from "./runtime/codex-preflight.js";

export type { PhaseResult, PhaseHandler } from "./phases/types.js";

// --- Interrupter registry (stack) ---
// HIGH-03: replaces the former module-level singleton reference that was
// overwritten by every `runOrchestrator()` start. When two orchestrators were
// in flight the earlier one became unreachable via `getInterrupter()`.
// Now each invocation pushes its own Interrupter onto `interrupterStack` in
// its opening try-setup and pops it in the `finally` block (by instance
// identity, to tolerate out-of-order finish). Per-invocation SIGINT handlers
// (inside runOrchestrator) are unchanged — each listener is closed over its
// own local `interrupter`, so SIGINT fires them all and each run interrupts
// its own Interrupter. No cross-fire.
const interrupterStack: Interrupter[] = [];

/**
 * Returns the most-recently-started orchestrator's Interrupter (top-of-stack).
 * When no orchestrator is running, returns a sentinel idle Interrupter so
 * external callers always get a non-interrupted signal and never an undefined.
 */
export function getInterrupter(): Interrupter {
  const top = interrupterStack[interrupterStack.length - 1];
  return top ?? new Interrupter();
}

// Exported for tests that need to inspect the stack depth. Not part of the
// stable public API — consumers should not rely on this.
export function _getInterrupterStackDepthForTest(): number {
  return interrupterStack.length;
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

function appendUniquePhase(phases: Phase[], phase: Phase): Phase[] {
  return phases.includes(phase) ? phases : [...phases, phase];
}

function recordPhaseResult(
  previousState: ProjectState,
  nextState: ProjectState,
  phase: Phase,
  result: PhaseResult,
  totalCostUsd: number,
): ProjectState {
  const phaseResult = {
    success: result.success,
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    timestamp: new Date().toISOString(),
  };

  // v1.1 super-lead: append to phaseAttempts history (all attempts
  // forensically preserved) while phaseResults keeps the "latest attempt"
  // shape unchanged so existing callsites keep working.
  const priorAttempts =
    previousState.phaseAttempts?.[phase] ?? nextState.phaseAttempts?.[phase] ?? [];

  return {
    ...previousState,
    ...nextState,
    totalCostUsd,
    phaseResults: {
      ...(previousState.phaseResults ?? {}),
      ...(nextState.phaseResults ?? {}),
      [phase]: phaseResult,
    },
    phaseAttempts: {
      ...(previousState.phaseAttempts ?? {}),
      ...(nextState.phaseAttempts ?? {}),
      [phase]: [...priorAttempts, phaseResult],
    },
    completedPhases: result.success
      ? appendUniquePhase(previousState.completedPhases ?? [], phase)
      : (previousState.completedPhases ?? []),
  };
}

/**
 * v1.1 super-lead: increment the per-transition-pair counter tracked in
 * state.backloopCounts. Used by the livelock guard in lead-driven phases —
 * the orchestrator denies a backloop when the counter for (from→to) has
 * already reached contract.maxBackloopsFromHere[to].
 */
export function incrementBackloopCount(
  state: ProjectState,
  from: Phase,
  to: Phase,
): ProjectState {
  const key = `${from}->${to}`;
  const current = state.backloopCounts?.[key] ?? 0;
  return {
    ...state,
    backloopCounts: {
      ...(state.backloopCounts ?? {}),
      [key]: current + 1,
    },
  };
}

/**
 * v1.1 super-lead: check whether a (from→to) backloop is still allowed
 * under the caller-supplied cap. `cap === undefined` means "no guard"
 * (unlimited). Used by the orchestrator before honoring `result.nextPhase`.
 */
export function isBackloopUnderCap(
  state: ProjectState,
  from: Phase,
  to: Phase,
  cap: number | undefined,
): boolean {
  if (cap === undefined) return true;
  const key = `${from}->${to}`;
  const current = state.backloopCounts?.[key] ?? 0;
  return current < cap;
}

export async function runOrchestrator(
  initialState: ProjectState,
  config: Config,
  resumeSessionId?: string,
  singlePhase?: Phase
): Promise<void> {
  // HIGH-03: Each invocation gets its own Interrupter AND pushes it onto the
  // module-level `interrupterStack` so `getInterrupter()` resolves to the
  // correct instance for concurrent runs (LIFO). The per-invocation SIGINT
  // handler below is closed over the local `interrupter`, so SIGINT cannot
  // cross-fire between concurrent orchestrators.
  const interrupter = new Interrupter();
  interrupterStack.push(interrupter);

  const sigintHandler = () => {
    interrupter.interrupt("SIGINT");
  };
  process.on("SIGINT", sigintHandler);

  let state = structuredClone(initialState);

  // Phase 2 (narrowed): when Codex-backed subagents are enabled, force the
  // outer orchestration model to Opus. Opus is the designated team lead for
  // Codex-backed coding teams; running a weaker coordinator over GPT-class
  // members reliably burns turns on routing instead of work. We mutate the
  // local config object in place — the caller's reference continues to point
  // at the same object so any follow-up commands pick up the same model.
  const OPUS_MODEL = "claude-opus-4-6" as const;
  if (config.codexSubagents?.enabled && config.model !== OPUS_MODEL) {
    console.warn(
      `[orchestrator] codexSubagents.enabled=true: forcing outer model ` +
      `from "${config.model}" to "${OPUS_MODEL}" (Opus is the team lead for ` +
      `Codex-backed runs).`,
    );
    config.model = OPUS_MODEL;
  }

  // Phase 10: live-run self-improvement guard. Inline prompt evolution is only
  // supposed to run in the `optimize` / `nightly` subcommands. If we're inside
  // a live run and self-improvement is enabled, warn — the orchestrator never
  // calls the optimizer directly, but operators should know the flag is a
  // no-op here so they don't rely on it mutating prompts mid-run.
  if (config.selfImprove?.enabled && !isNightlyRun()) {
    console.warn(
      "[orchestrator] Self-improvement is enabled but this is a live run. " +
      "Inline prompt mutation is disabled — use `nightly` / `optimize` " +
      "commands for offline optimization.",
    );
  }

  const { budgetUsd, dryRun, quickMode, confirmSpec } = config;

  // Event architecture
  const eventBus = new EventBus();
  const runId = randomUUID();
  const eventLogger = new EventLogger(config.stateDir, runId);
  const dashboardPath = resolve(config.stateDir, "dashboard.html");
  const unsubLogger = eventBus.onAll((record) => {
    eventLogger.log(record).catch((err) => {
      console.error(`[event-logger] Failed to write event: ${err}`);
    });
  });

  // Run ledger — observational topology + spend forensics (Phase 1). Bridges
  // AgentQueryStart/End into per-session records so post-run analysis doesn't
  // need to re-parse the event log.
  const ledger = new RunLedger(runId);
  setActiveLedger(ledger);
  const unsubLedger = ledger.attachEventBus(eventBus);

  // Memory store (persistent cross-session knowledge)
  const memoryStore = config.memory?.enabled
    ? new MemoryStore(config.stateDir, {
        maxDocuments: config.memory.maxDocuments,
        maxDocumentSizeKb: config.memory.maxDocumentSizeKb,
      })
    : null;

  let totalCostUsd = 0;

  const flushRunArtifacts = async (): Promise<void> => {
    try {
      saveState(config.stateDir, state);
    } catch (err) {
      console.error(`[orchestrator] Failed to save final state: ${errMsg(err)}`);
    }

    try {
      unsubLogger();
    } catch {
      // ignore unsubscribe failures during shutdown
    }

    try {
      await eventLogger.close();
    } catch (err) {
      console.error(`[event-logger] Failed to close event log: ${errMsg(err)}`);
    }

    try {
      const summaryPath = await eventLogger.persistRunSummary();
      console.log(`[event-logger] Run summary saved: ${summaryPath}`);
    } catch (err) {
      console.error(`[event-logger] Failed to persist run summary: ${errMsg(err)}`);
    }

    try {
      await generateDashboard(config.stateDir, dashboardPath);
      console.log(`[dashboard] Generated ${dashboardPath}`);
    } catch (err) {
      console.error(`[dashboard] Failed to generate dashboard: ${errMsg(err)}`);
    }

    // Phase B — L4 session archive. Append one JSONL line per run so offline
    // analysis can replay run outcomes without re-reading per-phase event
    // logs. Best-effort: archive failures must not mask the actual run result.
    try {
      if (memoryStore && config.memory?.layers?.enabled !== false) {
        const layered = new LayeredMemory(memoryStore, config.stateDir);
        const phases = Object.keys(state.phaseResults ?? {});
        await layered.l4.archiveSession({
          runId,
          phases,
          totalCostUsd,
          completedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error(`[memory-l4] Failed to archive session: ${errMsg(err)}`);
    }
  };

  // Clean up stale sessions on startup
  let sessionStore = loadSessions(config.stateDir);
  sessionStore = cleanStaleSessions(sessionStore);
  saveSessions(config.stateDir, sessionStore);

  // Build the execution envelope once per run — validated project root,
  // current branch, package manager, and verification whitelist are shared
  // across every phase so delegated agents don't spend tokens self-correcting
  // paths or environment assumptions. On failure we log and proceed without
  // an envelope (dry-run or fresh scaffolds shouldn't hard-fail here).
  let envelope: ExecutionEnvelope | undefined;
  try {
    envelope = await buildEnvelope(config.projectDir);
    console.log(
      `[orchestrator] Envelope: root=${envelope.projectRoot}, ` +
      `branch=${envelope.branch ?? "(none)"}, ` +
      `pm=${envelope.environment.packageManager}`,
    );
  } catch (err) {
    console.warn(
      `[orchestrator] Failed to build execution envelope: ${errMsg(err)}. ` +
      `Phases will run without validated runtime context.`,
    );
  }

  try {

  // Phase 2 (narrowed): Codex preflight. If Codex-backed subagents are
  // enabled, probe the binary before the run starts. On failure we record a
  // ledger session tagged `unsupported_team_runtime` so the run report shows
  // the real cause, then throw — we refuse to silently "fall back" to the
  // proxy prompt with a non-functional Codex backend. Skipped in dry-run so
  // a plan preview doesn't require a working Codex install.
  if (config.codexSubagents?.enabled && !dryRun) {
    try {
      const preflight = await runCodexPreflight();
      console.log(`[orchestrator] Codex preflight OK: ${preflight.version}`);
    } catch (err) {
      const message =
        err instanceof UnsupportedTeamRuntimeError
          ? err.message
          : `unsupported_team_runtime: ${errMsg(err)}`;
      const preflightSession = ledger.startSession({
        phase: state.currentPhase,
        role: "codex-preflight",
        sessionType: "coordinator",
        model: "codex",
      });
      ledger.recordFailure(
        preflightSession.sessionId,
        "unsupported_team_runtime",
        message,
      );
      ledger.endSession(preflightSession.sessionId, { success: false });
      console.error(`[orchestrator] ${message}`);
      throw err instanceof Error ? err : new Error(message);
    }
  }

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
    eventBus.emit("session.state", { phase: singlePhase, state: "running" });
    const singlePhaseResult = await executePhaseSafe(singlePhase, state, config, eventBus, undefined, interrupter, envelope);
    if (singlePhaseResult) {
      if (singlePhaseResult.costUsd !== undefined) {
        totalCostUsd += singlePhaseResult.costUsd;
      }
      state = recordPhaseResult(state, singlePhaseResult.state, singlePhase, singlePhaseResult, totalCostUsd);
      await withStateLock(config.stateDir, () =>
        saveState(config.stateDir, state)
      );
    }
    return;
  }

  // Main orchestration loop
  const MAX_ITERATIONS = 100;
  // v1.1 super-lead: global livelock cap for any (from→to) backloop pair.
  // Per-phase PhaseContract.maxBackloopsFromHere can tighten this further;
  // this is the orchestrator-level safety net.
  const GLOBAL_MAX_BACKLOOPS = 5;
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
      await withStateLock(config.stateDir, () => saveState(config.stateDir, state));
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
    eventBus.emit("session.state", { phase, state: "running" });
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
          await withStateLock(config.stateDir, () => saveState(config.stateDir, state));
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
      await withStateLock(config.stateDir, () => saveState(config.stateDir, state));
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
      result = await executePhaseSafe(phase, state, config, eventBus, memoryContext, interrupter, envelope);
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
    eventBus.emit("session.state", { phase, state: phaseSuccess ? "idle" : "terminated" });
    console.log(`[progress] ${phase} completed in ${elapsed}s`);

    if (!result) {
      // Fatal error already logged and state saved inside executePhaseSafe
      break;
    }

    if (result.costUsd !== undefined) {
      totalCostUsd += result.costUsd;
      console.log(`[budget] Phase cost: $${result.costUsd.toFixed(4)}, total: $${totalCostUsd.toFixed(4)}`);
    }

    // Persist running cost total and phase outcome into state so it survives checkpoints/resume.
    state = recordPhaseResult(state, result.state, phase, result, totalCostUsd);

    if (budgetUsd !== undefined && totalCostUsd > budgetUsd) {
      console.log(`[budget] Budget exceeded ($${totalCostUsd.toFixed(4)}/$${budgetUsd.toFixed(4)}). Stopping.`);
      await withStateLock(config.stateDir, () => saveState(config.stateDir, state));
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
      // v1.1 super-lead: track backloop frequency per (from→to) pair.
      // A backloop here means the completed-phases list already contains
      // the target — i.e. we are re-entering a phase we've been in before.
      const isBackloop = (state.completedPhases ?? []).includes(result.nextPhase);
      const backloopKey = `${phase}->${result.nextPhase}`;
      const currentCount = state.backloopCounts?.[backloopKey] ?? 0;

      // Global livelock guard: refuse to take a backloop when the
      // (from→to) pair has already fired GLOBAL_MAX_BACKLOOPS times.
      // Per-contract caps (PhaseContract.maxBackloopsFromHere) can tighten
      // this further; this is the orchestrator-level safety net.
      if (isBackloop && currentCount >= GLOBAL_MAX_BACKLOOPS) {
        console.warn(
          `[orchestrator] backloop_livelock_guard: ${backloopKey} already ran ${currentCount} times — ` +
            `denying further backloop, stopping the run.`,
        );
        // Persist final state before bailing so the livelock is visible in state.json.
        await withStateLock(config.stateDir, () => saveState(config.stateDir, state));
        break;
      }

      state = transitionPhase(state, result.nextPhase);
      if (isBackloop) {
        state = incrementBackloopCount(state, phase, result.nextPhase);
      }
      await withStateLock(config.stateDir, () => saveState(config.stateDir, state));
      console.log(
        `[orchestrator] Transition: ${phase} -> ${result.nextPhase}` +
          (isBackloop
            ? ` (backloop count: ${state.backloopCounts?.[backloopKey] ?? 0})`
            : ""),
      );
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

  } finally {
    process.removeListener("SIGINT", sigintHandler);
    // HIGH-03: remove THIS run's interrupter from the stack by identity
    // (not by index) to tolerate out-of-order completion of concurrent runs.
    const idx = interrupterStack.indexOf(interrupter);
    if (idx !== -1) interrupterStack.splice(idx, 1);
    try {
      unsubLedger();
    } catch {
      // ignore
    }
    try {
      const ledgerPath = ledger.persist(config.stateDir);
      console.log(`[run-ledger] Saved: ${ledgerPath}`);
    } catch (err) {
      console.warn(`[run-ledger] Failed to persist ledger: ${errMsg(err)}`);
    }
    ledger.dispose();
    setActiveLedger(null);
    await flushRunArtifacts();
    console.log(`[event-logger] Run events saved: ${eventLogger.getLogPath()}`);
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
  interrupter?: Interrupter,
  envelope?: ExecutionEnvelope,
): Promise<PhaseResult | null> {
  const handler = PHASE_HANDLERS[phase];
  if (!handler) {
    console.error(`[error] No handler for phase: ${phase}`);
    await withStateLock(config.stateDir, () => saveState(config.stateDir, state));
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
        await withStateLock(config.stateDir, () => saveState(config.stateDir, state));

        const context: PhaseContext | undefined = memoryContext
          ? { memoryContext, cachedSystemPrompt: memoryContext }
          : undefined;
        const execCtx: PhaseExecutionContext = {
          ...(checkpoint ? { checkpoint } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(context ? { context } : {}),
          ...(eventBus ? { eventBus } : {}),
          ...(interrupter ? { signal: interrupter.signal } : {}),
          ...(envelope ? { envelope } : {}),
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
    //
    // Phase 8: the auxiliary-profile gate short-circuits this block entirely
    // for `minimal` runs. `debug` / `nightly` profiles, or an explicit
    // `config.rubrics.enabled === true` override (set by `--enable-rubrics`),
    // re-enable grading.
    const auxFlags = resolveAuxiliaryFlags(config);
    const rubricEnabled = auxFlags.rubric || config.rubrics?.enabled === true;
    if (rubricEnabled && result.success) {
      const rubric = getPhaseRubric(phase);
      if (rubric) {
        console.log(`[rubric] Evaluating phase "${phase}" against rubric "${rubric.name}"`);
        const maxIter = config.rubrics?.maxIterations ?? 3;
        // Compute the stable reused prefix ONCE. Each iteration re-runs the
        // handler with a reference-equal `cachedSystemPrompt`, so the SDK's
        // ephemeral cache can hit on retry iterations (memoryContext is
        // typically a few KB of knowledge-base excerpts, already carries a
        // `## Knowledge from previous sessions` heading).
        const cachedSystemPrompt = memoryContext;
        const baseCtx: PhaseContext = {
          ...(memoryContext ? { memoryContext } : {}),
          ...(cachedSystemPrompt ? { cachedSystemPrompt } : {}),
        };
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
            ...(eventBus ? { eventBus } : {}),
            ...(interrupter ? { signal: interrupter.signal } : {}),
            ...(envelope ? { envelope } : {}),
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
              ...(interrupter ? { signal: interrupter.signal } : {}),
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

          if (rubricResult.verdict === "satisfied") {
            return { ...iterResult, costUsd: rubricCost, rubricResult };
          }
          if (rubricResult.verdict === "failed") {
            // HIGH-01: escalate failed rubric verdict to RunLedger with the
            // canonical `verification_failed` reason code. Best-effort — a
            // ledger error must not mask the actual phase outcome being
            // returned to the caller.
            try {
              const activeLedger = getActiveLedger();
              if (activeLedger) {
                const graderModel =
                  config.rubrics?.graderModel ?? config.subagentModel;
                const session = activeLedger.startSession({
                  phase,
                  role: "rubric-grader",
                  sessionType: "rubric",
                  ...(graderModel ? { model: graderModel } : {}),
                });
                const failureMessage =
                  rubricResult.summary && rubricResult.summary.trim().length > 0
                    ? rubricResult.summary
                    : `Rubric "${rubric.name}" failed at iteration ${iter} with overall score ${rubricResult.overallScore.toFixed(2)}`;
                activeLedger.recordFailure(
                  session.sessionId,
                  "verification_failed",
                  failureMessage,
                );
                activeLedger.endSession(session.sessionId, { success: false });
                console.log(
                  `[ledger] verification_failed recorded for phase "${phase}" (rubric "${rubric.name}", score ${rubricResult.overallScore.toFixed(2)})`,
                );
              }
            } catch (err) {
              console.warn(
                `[ledger] Failed to record verification_failed escalation for phase "${phase}": ${errMsg(err)}`,
              );
            }
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
    await withStateLock(config.stateDir, () => saveState(config.stateDir, state));

    return {
      success: false,
      state,
      error: error.message,
    };
  }
}
