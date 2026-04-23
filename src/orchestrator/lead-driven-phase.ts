import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

import type { ProjectState } from "../state/project-state.js";
import type { Config } from "../utils/config.js";
import type { PhaseExecutionContext, PhaseResult } from "../phases/types.js";
import type { PhaseContract } from "./phase-contract.js";
import { renderPhaseContext } from "./phase-context.js";
import { AgentRegistry } from "../agents/registry.js";
import {
  consumeQuery,
  getQueryPermissions,
  getMaxTurns,
  QueryAbortedError,
} from "../utils/sdk-helpers.js";
import { Interrupter } from "../events/interrupter.js";
import { errMsg, extractFirstJson } from "../utils/shared.js";
import { canTransition } from "../state/project-state.js";

/**
 * Structured shape the lead MUST emit. `domain` is the phase-specific
 * payload validated against contract.outputSchema.
 */
interface LeadEnvelope<TDomain> {
  success: boolean;
  nextPhase?: string;
  error?: string;
  domain?: TDomain;
}

export interface RunLeadDrivenPhaseOptions<TResult> {
  contract: PhaseContract<TResult>;
  state: ProjectState;
  config: Config;
  execCtx?: PhaseExecutionContext;
  /**
   * Apply the validated domain result back onto ProjectState. Returned state
   * is what PhaseResult.state will contain. Keeps domain-specific mutations
   * in the handler — the primitive stays phase-agnostic.
   */
  applyResult: (state: ProjectState, result: TResult) => ProjectState;
  /**
   * Optional override for the registry lookup. Production passes a real
   * AgentRegistry(stateDir); tests pass an in-memory stub.
   */
  registry?: AgentRegistry;
}

const DENIED_SPECIALIST_TOOLS: ReadonlySet<string> = new Set(["Agent"]);

/**
 * Defensively strip tools we never permit on a specialist, regardless of
 * what the blueprint declared. Currently: the Agent tool is denied so
 * specialists cannot spawn their own coordinators (invariant copied from
 * development-runner.ts:1042-1044).
 */
export function sanitizeSpecialistTools(tools: readonly string[]): string[] {
  return tools.filter((t) => !DENIED_SPECIALIST_TOOLS.has(t));
}

/**
 * Build the `agents:` map passed to the SDK query. Pulls blueprints by name
 * from the registry, sanitizes their tools, and applies the subagent model.
 */
export function buildSpecialists(
  contract: PhaseContract<unknown>,
  config: Config,
  registry: AgentRegistry,
): Record<string, AgentDefinition> {
  const specialists: Record<string, AgentDefinition> = {};
  for (const name of contract.specialistNames) {
    const def = registry.toAgentDefinition(name, config);
    specialists[name] = {
      ...def,
      tools: sanitizeSpecialistTools(def.tools ?? []),
      model: config.subagentModel,
      maxTurns: getMaxTurns(config, "default"),
    };
  }
  return specialists;
}

/**
 * Render the lead system prompt. Static segments come first to maximize
 * prompt-cache hit rates across backloop retries within the 5-minute TTL.
 */
export function buildLeadPrompt(
  contract: PhaseContract<unknown>,
  state: ProjectState,
): { systemPrompt: string; userPrompt: string } {
  const phaseCtx = contract.contextSelector(state);
  const contextBlock = renderPhaseContext(phaseCtx);

  const allowedBacklooplist = contract.allowedNextPhases.length > 0
    ? contract.allowedNextPhases.join(", ")
    : "(none — this phase cannot backloop)";

  const specialistList = contract.specialistNames.length > 0
    ? contract.specialistNames.map((n) => `  - ${n}`).join("\n")
    : "  (no specialists declared — use built-in tools only)";

  const deliverablesList = contract.deliverables.length > 0
    ? contract.deliverables.map((d) => `  - ${d}`).join("\n")
    : "  (contract specifies no deliverables — you must still return a valid output envelope)";

  const systemPrompt = [
    `You are the lead for the "${contract.phase}" phase of an autonomous development pipeline.`,
    "",
    "## Goal",
    contract.goals,
    "",
    "## Deliverables",
    deliverablesList,
    "",
    "## Available specialists",
    "Invoke via the Agent tool when their expertise adds value. Do NOT spawn specialists for trivial work.",
    specialistList,
    "",
    "## Transition policy",
    contract.allowedNextPhases.length === 1
      ? `On success, the pipeline transitions to "${contract.allowedNextPhases[0]}". You MAY omit \`nextPhase\` — the orchestrator will fill it in. Setting \`nextPhase\` to anything else is a schema violation.`
      : contract.allowedNextPhases.length > 1
        ? `On success, you MUST set \`nextPhase\` to one of: ${allowedBacklooplist}. The orchestrator halts the run if \`nextPhase\` is missing on a multi-target phase. Setting \`nextPhase\` to anything else is a schema violation.`
        : `This phase cannot transition to another phase. Leave \`nextPhase\` unset.`,
    "",
    "## Output contract",
    "Your final message MUST be a single JSON object with this exact top-level shape:",
    "```json",
    "{",
    '  "success": boolean,',
    `  "nextPhase": "${contract.allowedNextPhases[0] ?? "<allowed>"}" | undefined,`,
    '  "error": "string (only when success=false)" | undefined,',
    '  "domain": { /* phase-specific payload — see shape below */ }',
    "}",
    "```",
    "The `domain` field MUST parse against the phase's output schema. If a specialist ships malformed JSON, repair it yourself before embedding — do not pass it through.",
    ...(contract.outputShapeHint
      ? [
          "",
          "### Required shape of the `domain` field",
          "Match this shape EXACTLY — key names, array-vs-object, and types. String-valued fields stay strings; do not silently upgrade them to objects.",
          "```json",
          contract.outputShapeHint.trim(),
          "```",
        ]
      : []),
  ].join("\n");

  const userPrompt = [
    "Drive this phase to completion.",
    "",
    contextBlock,
    "",
    "When finished, emit the final JSON envelope described in your system prompt and nothing else.",
  ].join("\n");

  return { systemPrompt, userPrompt };
}

/**
 * Parse and validate the lead's final envelope. Enforces:
 * - Envelope shape (success is boolean, etc.)
 * - nextPhase ∈ contract.allowedNextPhases (when present)
 * - domain payload validates against contract.outputSchema (when success=true)
 */
export function parseLeadEnvelope<TResult>(
  contract: PhaseContract<TResult>,
  raw: string,
): { envelope: LeadEnvelope<TResult>; domain?: TResult; error?: string } {
  const extracted = extractFirstJson(raw);
  if (!extracted) {
    return { envelope: { success: false }, error: "Lead emitted no parseable JSON envelope" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch (err) {
    return { envelope: { success: false }, error: `Envelope JSON parse error: ${errMsg(err)}` };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { envelope: { success: false }, error: "Envelope is not a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;
  const envelope: LeadEnvelope<TResult> = {
    success: obj["success"] === true,
  };
  if (typeof obj["nextPhase"] === "string") envelope.nextPhase = obj["nextPhase"];
  if (typeof obj["error"] === "string") envelope.error = obj["error"];

  if (envelope.nextPhase && !contract.allowedNextPhases.includes(envelope.nextPhase as never)) {
    return {
      envelope,
      error:
        `Lead requested nextPhase="${envelope.nextPhase}" which is not in ` +
        `allowedNextPhases=[${contract.allowedNextPhases.join(", ")}]`,
    };
  }

  if (!envelope.success) {
    return { envelope };
  }

  const domainParse = contract.outputSchema.safeParse(obj["domain"]);
  if (!domainParse.success) {
    const issues = domainParse.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      envelope,
      error: `Lead's domain payload failed schema validation: ${issues}`,
    };
  }

  return { envelope, domain: domainParse.data };
}

/**
 * Per-phase cost-cap enforcer. Wraps a run-level signal with a phase-level
 * Interrupter that aborts when costUsd > contract.costCapUsd. Exposes the
 * composed signal via `signal`. Call `updateCost(costSoFar)` as cost
 * accumulates; call `dispose()` in finally.
 *
 * Nests correctly inside the run-level Interrupter — aborting the
 * phase-level one does NOT cross-fire into the run-level signal.
 */
export class PhaseBudgetGuard {
  private readonly phaseInterrupter: Interrupter;
  private readonly composedController: AbortController;
  private readonly runUnlisten?: () => void;
  private phaseUnlisten?: () => void;
  private disposed = false;

  constructor(
    private readonly cap: number,
    runSignal?: AbortSignal,
  ) {
    this.phaseInterrupter = new Interrupter();
    this.composedController = new AbortController();

    // Phase abort → composed abort.
    const onPhaseAbort = () => {
      if (!this.composedController.signal.aborted) {
        this.composedController.abort(this.phaseInterrupter.getReason() ?? "phase-abort");
      }
    };
    this.phaseInterrupter.signal.addEventListener("abort", onPhaseAbort, { once: true });
    this.phaseUnlisten = () => this.phaseInterrupter.signal.removeEventListener("abort", onPhaseAbort);

    // Run abort → composed abort (but NOT vice versa).
    if (runSignal) {
      if (runSignal.aborted) {
        this.composedController.abort(runSignal.reason ?? "run-abort");
      } else {
        const onRunAbort = () => {
          if (!this.composedController.signal.aborted) {
            this.composedController.abort(runSignal.reason ?? "run-abort");
          }
        };
        runSignal.addEventListener("abort", onRunAbort, { once: true });
        this.runUnlisten = () => runSignal.removeEventListener("abort", onRunAbort);
      }
    }
  }

  get signal(): AbortSignal {
    return this.composedController.signal;
  }

  updateCost(costUsd: number): void {
    if (this.disposed) return;
    if (costUsd > this.cap && !this.phaseInterrupter.isInterrupted()) {
      this.phaseInterrupter.interrupt("budget");
    }
  }

  isBudgetExceeded(): boolean {
    return this.phaseInterrupter.isInterrupted() && this.phaseInterrupter.getReason() === "budget";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.runUnlisten?.();
    this.phaseUnlisten?.();
  }
}

/**
 * Run a lead-driven phase: build specialists, render lead prompts, execute
 * the SDK query through consumeQuery (so SIGINT + telemetry propagate),
 * parse the envelope, apply the domain result to state.
 *
 * This is the v1.1 super-lead primitive. Handlers become thin wrappers:
 *   return runLeadDrivenPhase({ contract, state, config, execCtx, applyResult });
 */
export async function runLeadDrivenPhase<TResult>(
  opts: RunLeadDrivenPhaseOptions<TResult>,
): Promise<PhaseResult> {
  const { contract, state, config, execCtx, applyResult } = opts;
  const registry = opts.registry ?? new AgentRegistry(config.stateDir);

  const specialists = buildSpecialists(contract, config, registry);
  const { systemPrompt, userPrompt } = buildLeadPrompt(contract, state);

  const cap = contract.costCapUsd ?? config.budgetUsd ?? Number.POSITIVE_INFINITY;
  const guard = new PhaseBudgetGuard(cap, execCtx?.signal);

  try {
    const queryStream = query({
      prompt: userPrompt,
      options: {
        systemPrompt,
        allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"],
        agents: specialists,
        model: config.model,
        maxTurns: getMaxTurns(config, "default"),
        ...getQueryPermissions(config),
      },
    });

    const queryResult = await consumeQuery(queryStream, {
      label: `lead:${contract.phase}`,
      phase: contract.phase,
      agentName: `lead-${contract.phase}`,
      model: config.model,
      signal: guard.signal,
      ...(execCtx?.eventBus ? { eventBus: execCtx.eventBus } : {}),
      onMessage: () => {
        // Kept deliberately empty — telemetry routes through eventBus.
      },
    });

    guard.updateCost(queryResult.cost);

    const { envelope, domain, error } = parseLeadEnvelope(contract, queryResult.result);

    if (error) {
      return {
        success: false,
        state,
        error,
        sessionId: queryResult.sessionId,
        costUsd: queryResult.cost,
      };
    }

    if (!envelope.success || domain === undefined) {
      return {
        success: false,
        state,
        error: envelope.error ?? "Lead reported success=false without an error message",
        sessionId: queryResult.sessionId,
        costUsd: queryResult.cost,
        ...(envelope.nextPhase && canTransition(state.currentPhase, envelope.nextPhase as never)
          ? { nextPhase: envelope.nextPhase as never }
          : {}),
      };
    }

    const nextState = applyResult(state, domain);
    const result: PhaseResult = {
      success: true,
      state: nextState,
      sessionId: queryResult.sessionId,
      costUsd: queryResult.cost,
    };
    if (envelope.nextPhase) {
      result.nextPhase = envelope.nextPhase as never;
    } else if (contract.allowedNextPhases.length === 1) {
      // v1.1 safety net: when a contract has exactly ONE legal next phase
      // and the lead omitted nextPhase, auto-fill it. The single legal
      // target is unambiguous; forcing the lead to restate it is noise
      // and the orchestrator halts the run on missing transitions.
      // Phases with multiple legal targets still require an explicit pick.
      const only = contract.allowedNextPhases[0];
      if (only) result.nextPhase = only as never;
    }
    return result;
  } catch (err) {
    const aborted = err instanceof QueryAbortedError;
    const budgetAbort = aborted && guard.isBudgetExceeded();
    return {
      success: false,
      state,
      error: budgetAbort
        ? `Phase "${contract.phase}" exceeded cost cap ${cap.toFixed(2)} USD`
        : `Lead-driven phase failed: ${errMsg(err)}`,
      costUsd: 0,
    };
  } finally {
    guard.dispose();
  }
}
