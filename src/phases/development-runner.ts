import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDefinition, OutputFormat } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type {
  ProjectState,
  PhaseCheckpoint,
  McpServerConfig,
  Task,
  UserStory,
} from "../state/project-state.js";
import type { PhaseResult, PhaseExecutionContext } from "./types.js";
import type {
  DevTask,
  BatchResult,
  TaskResult,
} from "./development-types.js";
import { AgentRegistry } from "../agents/registry.js";
import { buildRunnableAgentDefinition } from "../agents/codex-proxy.js";
import { buildAgentTeam, getAgentDefinitions } from "../agents/factory.js";
import { getMcpServerConfigs } from "../environment/mcp-manager.js";
import { qualityGateHook } from "../hooks/quality-gate.js";
import { auditLoggerHook } from "../hooks/audit-logger.js";
import {
  addTask,
  updateTask,
  saveCheckpoint as saveCheckpointState,
  saveState,
} from "../state/project-state.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const execFileAsync = promisify(execFile);
import {
  TaskReceiptSchema,
  TaskReceiptEnvelopeSchema,
} from "../types/llm-schemas.js";
import type { TaskReceipt } from "../types/task-receipt.js";
import { getQueryPermissions, getMaxTurns } from "../utils/sdk-helpers.js";
import { isApiRetry, wrapUserInput, extractFirstJson, errMsg } from "../utils/shared.js";
import { TaskDecompositionSchema } from "../types/llm-schemas.js";
import { getBaseAgentNames } from "../agents/base-blueprints.js";
import { progress } from "../utils/progress.js";
import {
  type ExecutionEnvelope,
  renderEnvelopeBlock,
} from "../runtime/execution-envelope.js";

// --- Main entry point ---

export async function runDevelopment(
  state: ProjectState,
  config: Config,
  ctx?: PhaseExecutionContext,
): Promise<PhaseResult> {
  if (!state.spec || !state.architecture) {
    return { success: false, state, error: "Spec and architecture required" };
  }

  console.log("[development] Starting development phase");

  // Step 1: Decompose user stories into implementation tasks
  let updatedState = { ...state };
  const existingTaskTitles = new Set(state.tasks.map((t) => t.title));
  const pendingStories = state.spec.userStories.filter(
    (us) => !existingTaskTitles.has(us.title)
  );

  let devTasks: DevTask[];
  const archTasks = state.architecture?.taskDecomposition?.tasks;

  if (archTasks && archTasks.length > 0 && existingTaskTitles.size === 0) {
    // Use tasks produced by architecture phase — avoids redundant decomposition
    console.log(`[development] Using ${archTasks.length} tasks from architecture phase`);
    devTasks = archTasks.map((at): DevTask => ({
      id: at.id,
      title: at.title,
      description: at.description,
      estimatedComplexity: at.estimatedComplexity,
      dependencies: at.dependencies,
      acceptanceCriteria: at.acceptanceCriteria,
    }));
    for (const dt of devTasks) {
      updatedState = addTask(updatedState, {
        title: dt.title,
        description: `${dt.description}\n\nAcceptance Criteria:\n${dt.acceptanceCriteria.map((ac) => `- ${ac}`).join("\n")}`,
      });
    }
    // Persist tasks immediately so interruption doesn't lose them
    saveState(config.stateDir, updatedState);
  } else if (pendingStories.length > 0) {
    console.log(`[development] Decomposing ${pendingStories.length} user stories into tasks...`);
    devTasks = await decomposeUserStories(pendingStories, state, config);
    console.log(`[development] Created ${devTasks.length} implementation tasks`);

    // Register tasks in project state
    for (const dt of devTasks) {
      updatedState = addTask(updatedState, {
        title: dt.title,
        description: dt.description,
      });
    }
    // Persist tasks immediately so interruption doesn't lose them
    saveState(config.stateDir, updatedState);
  } else {
    console.log("[development] No new stories to decompose. Using existing tasks.");
    devTasks = updatedState.tasks
      .filter((t) => t.status === "pending" || t.status === "in_progress")
      .map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        estimatedComplexity: "medium" as const,
        dependencies: [],
        acceptanceCriteria: [],
      }));
  }

  // Step 2: Filter out tasks completed in a previous checkpoint
  const completedIds = new Set(ctx?.checkpoint?.completedTasks ?? []);
  const pendingTasks = updatedState.tasks.filter(
    (t) => t.status === "pending" && !completedIds.has(t.id)
  );

  if (pendingTasks.length === 0) {
    console.log("[development] All tasks already completed");
    return { success: true, nextPhase: "testing", state: updatedState };
  }

  console.log(`[development] ${pendingTasks.length} tasks to implement`);

  // Step 3: Group tasks into execution batches (respecting dependencies)
  const taskBatches = groupIntoBatches(pendingTasks, devTasks);

  // Step 4: Execute each batch
  // Ensure domain agents are built and registered before loading the registry.
  // buildAgentTeam is idempotent: it skips generation if agents already exist.
  await buildAgentTeam(updatedState, config);
  const registry = new AgentRegistry(config.stateDir);
  const baseAgentDefs = getAgentDefinitions(registry, config);
  const mcpServers = state.environment
    ? getMcpServerConfigs(state.environment.mcpServers)
    : {};

  let totalCost = 0;
  const batchSessionIds: string[] = [];

  for (let batchIdx = 0; batchIdx < taskBatches.length; batchIdx++) {
    const batch = taskBatches[batchIdx]!;
    progress.emit("batch:start", { index: batchIdx, total: taskBatches.length, taskCount: batch.length });
    console.log(
      `[development] Batch ${batchIdx + 1}/${taskBatches.length}: ` +
        `${batch.length} task(s) — ${batch.map((t) => t.title).join(", ")}`
    );

    const batchAgentDefs = buildBatchAgents(
      batch,
      updatedState,
      baseAgentDefs,
      config,
      registry,
      ctx?.envelope
    );

    const batchResult = await executeBatch(
      batch,
      batchAgentDefs,
      updatedState,
      config,
      mcpServers
    );

    totalCost += batchResult.costUsd;
    if (batchResult.sessionId) batchSessionIds.push(batchResult.sessionId);

    progress.emit("batch:end", { index: batchIdx, success: batchResult.taskResults.every((r) => r.success) });

    // Update task statuses and save state after each individual task result.
    // Phase 6: a task is only "completed" when backed by a receipt whose
    // status is exactly "success". Blocked/partial/failed receipts persist
    // as "failed" — they can never be mistaken for completed work.
    for (const taskResult of batchResult.taskResults) {
      const receiptStatus = taskResult.receipt?.status;
      const isComplete = taskResult.success && receiptStatus === "success";
      updatedState = updateTask(updatedState, taskResult.taskId, {
        status: isComplete ? "completed" : "failed",
        ...(taskResult.result !== undefined ? { result: taskResult.result } : {}),
        ...(taskResult.error !== undefined ? { error: taskResult.error } : {}),
        ...(isComplete ? { completedAt: new Date().toISOString() } : {}),
      });
      // Persist after each task so interruption loses at most one task
      saveState(config.stateDir, updatedState);
      if (taskResult.receipt) {
        persistReceipt(config.stateDir, "development", taskResult.receipt);
      }
    }

    // Save checkpoint after each batch
    const batchCheckpoint: PhaseCheckpoint = {
      phase: "development",
      completedTasks: updatedState.tasks
        .filter((t) => t.status === "completed")
        .map((t) => t.id),
      pendingTasks: updatedState.tasks
        .filter((t) => t.status === "pending" || t.status === "in_progress")
        .map((t) => t.id),
      timestamp: new Date().toISOString(),
      metadata: { batchIndex: batchIdx, totalCost, sessionIds: batchSessionIds },
    };
    updatedState = saveCheckpointState(updatedState, batchCheckpoint);
    saveState(config.stateDir, updatedState);

    console.log(
      `[development] Batch ${batchIdx + 1} complete. ` +
        `Cost so far: $${totalCost.toFixed(4)}`
    );

    // Step 5: Quality gate after each batch
    const qualityOk = await runQualityChecks();
    if (!qualityOk) {
      console.warn("[development] Quality checks failed after batch. Attempting auto-fix...");
      const fixResult = await autoFixQualityIssues(
        updatedState,
        config,
        baseAgentDefs,
        mcpServers
      );
      totalCost += fixResult.costUsd;
      if (!fixResult.fixed) {
        console.error("[development] Auto-fix failed. Continuing to next batch.");
      }
    }
  }

  // Step 6: Final quality check
  const finalQuality = await runQualityChecks();

  const failedTasks = updatedState.tasks.filter((t) => t.status === "failed");
  const success = failedTasks.length === 0 && finalQuality;

  console.log(
    `[development] Implementation ${success ? "complete" : "finished with issues"}. ` +
      `Total cost: $${totalCost.toFixed(4)}`
  );

  if (failedTasks.length > 0) {
    console.warn(
      `[development] ${failedTasks.length} task(s) failed: ` +
        failedTasks.map((t) => t.title).join(", ")
    );
  }

  return {
    success,
    ...(success ? { nextPhase: "testing" as const } : {}),
    state: updatedState,
    ...(batchSessionIds.length > 0 ? { sessionId: batchSessionIds[batchSessionIds.length - 1]! } : {}),
    costUsd: totalCost,
    ...(!success ? { error: `${failedTasks.length} task(s) failed` } : {}),
  };
}

// --- Task Decomposition ---

async function decomposeUserStories(
  stories: UserStory[],
  state: ProjectState,
  config: Config
): Promise<DevTask[]> {
  const prompt = `You are a technical lead decomposing user stories into implementation tasks.

${wrapUserInput("architecture", JSON.stringify(state.architecture, null, 2))}

User Stories to decompose:
${stories
  .map(
    (s, i) =>
      `${i + 1}. [${s.id}] ${s.title} (${s.priority})
   ${s.description}
   Acceptance Criteria: ${s.acceptanceCriteria.join("; ")}`
  )
  .join("\n\n")}

Break these into concrete implementation tasks. Each task should be:
- Small enough for one developer to complete (1-4 hours of work)
- Self-contained with clear inputs/outputs
- Include all acceptance criteria from the parent story
- If the task requires specialized domain expertise, set "domain" to the agent name (e.g. "payments-specialist", "ml-engineer") — omit for generic dev tasks

Output a JSON object with a "tasks" array.`;

  const taskSchema = {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique task ID like task-001" },
              title: { type: "string" },
              description: { type: "string" },
              estimatedComplexity: {
                type: "string",
                enum: ["low", "medium", "high"],
              },
              dependencies: {
                type: "array",
                items: { type: "string" },
                description: "IDs of tasks this depends on",
              },
              acceptanceCriteria: {
                type: "array",
                items: { type: "string" },
              },
              domain: {
                type: "string",
                description: "Agent name for domain-specific tasks (e.g. 'payments-specialist'). Omit for generic tasks.",
              },
              tags: {
                type: "array",
                items: { type: "string" },
                description: "Optional domain keywords",
              },
            },
            required: [
              "id",
              "title",
              "description",
              "estimatedComplexity",
              "dependencies",
              "acceptanceCriteria",
            ],
          },
        },
      },
      required: ["tasks"],
    },
  } satisfies OutputFormat;

  let structuredOutput: unknown = null;

  for await (const message of query({
    prompt,
    options: {
      model: config.subagentModel,
      outputFormat: taskSchema,
      maxTurns: getMaxTurns(config, "decomposition"),
      ...getQueryPermissions(config),
    },
  })) {
    if (message.type === "result" && message.subtype === "success") {
      structuredOutput = message.structured_output;
      if (!structuredOutput && message.result) {
        try {
          structuredOutput = JSON.parse(message.result);
        } catch {
          // Will fall through to default tasks
        }
      }
    }
  }

  if (structuredOutput) {
    const parsed = TaskDecompositionSchema.safeParse(structuredOutput);
    if (parsed.success && parsed.data.tasks.length > 0) {
      return parsed.data.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        estimatedComplexity: t.estimatedComplexity,
        dependencies: t.dependencies,
        acceptanceCriteria: t.acceptanceCriteria,
      }));
    }
  }

  // Fallback: one task per story
  console.warn("[development] Task decomposition returned no results. Using one task per story.");
  return stories.map((s, i) => ({
    id: `task-${String(i + 1).padStart(3, "0")}`,
    title: s.title,
    description: `${s.description}\n\nAcceptance Criteria:\n${s.acceptanceCriteria.map((ac) => `- ${ac}`).join("\n")}`,
    estimatedComplexity: "medium" as const,
    dependencies: [],
    acceptanceCriteria: s.acceptanceCriteria,
  }));
}

// --- Task Batching ---

const MAX_BATCH_SIZE = 6;

/**
 * Groups tasks into sequential batches where tasks within a batch
 * have no inter-dependencies and can be worked on in parallel.
 * Large independent batches are split into sub-batches of MAX_BATCH_SIZE
 * so interruptions lose at most one batch worth of progress.
 */
function groupIntoBatches(projectTasks: Task[], devTasks: DevTask[]): Task[][] {
  // Build a lookup from title to devTask for dependency info
  const devTaskMap = new Map(devTasks.map((dt) => [dt.id, dt]));
  const titleToId = new Map(devTasks.map((dt) => [dt.title, dt.id]));

  const completed = new Set<string>();
  const remaining = [...projectTasks];
  const batches: Task[][] = [];

  let safetyCounter = 0;
  const maxIterations = remaining.length + 1;

  while (remaining.length > 0 && safetyCounter < maxIterations) {
    safetyCounter++;
    const batch: Task[] = [];
    const batchIds: string[] = [];

    for (const task of remaining) {
      const devTaskId = titleToId.get(task.title);
      const devTask = devTaskId ? devTaskMap.get(devTaskId) : undefined;

      // Check if all dependencies are completed
      const depsResolved =
        !devTask?.dependencies?.length ||
        devTask.dependencies.every((dep) => completed.has(dep));

      if (depsResolved) {
        batch.push(task);
        if (devTaskId) batchIds.push(devTaskId);
      }
    }

    if (batch.length === 0) {
      // Circular dependency or unresolvable — just push everything remaining
      console.warn("[development] Could not resolve task dependencies. Executing remaining tasks in order.");
      batches.push(remaining);
      break;
    }

    // Split large independent batches to limit blast radius on interruption
    if (batch.length > MAX_BATCH_SIZE) {
      for (let i = 0; i < batch.length; i += MAX_BATCH_SIZE) {
        batches.push(batch.slice(i, i + MAX_BATCH_SIZE));
      }
    } else {
      batches.push(batch);
    }
    const batchTaskIds = new Set(batch.map((t) => t.id));
    for (const id of batchIds) completed.add(id);
    remaining.splice(0, remaining.length, ...remaining.filter((t) => !batchTaskIds.has(t.id)));
  }

  return batches;
}

// --- Batch Execution ---

const BASE_AGENT_NAMES = getBaseAgentNames();

const GENERIC_DEV_INSTRUCTIONS = `## Instructions
1. Read the existing codebase to understand current state
2. Implement the task following the architecture exactly
3. Write clean, well-structured code
4. Add appropriate error handling
5. Write or update tests for the new code
6. Run type-check (\`npx tsc --noEmit\`) and fix any errors
7. Run tests (\`npm test\`) and fix any failures
8. Create a git commit for the completed work with a clear message

Report what you implemented and any decisions you made.`;

/**
 * Build the stable system-prompt block shared by every task agent in a batch.
 * Contains the (large) architecture JSON, the file structure summary, and the
 * generic developer instructions — i.e. everything that is identical for every
 * task in the same batch. Putting this text at the front of each subagent's
 * `prompt` lets the SDK's ephemeral cache hit across subagent invocations,
 * eliminating the per-task duplication of the architecture blob.
 */
export function buildSharedTaskContext(
  state: ProjectState,
  envelope?: ExecutionEnvelope,
): string {
  const archJson = JSON.stringify(state.architecture, null, 2);
  const fileStructure = state.architecture?.fileStructure ?? "Not specified";
  const envelopeBlock = envelope ? `\n\n${renderEnvelopeBlock(envelope)}` : "";
  return `You are an expert developer. Implement the task described below.

${wrapUserInput("architecture", archJson)}

## File Structure
${fileStructure}${envelopeBlock}

${GENERIC_DEV_INSTRUCTIONS}`;
}

export function buildBatchAgents(
  batch: Task[],
  state: ProjectState,
  baseAgentDefs: Record<string, AgentDefinition>,
  config: Config,
  registry: AgentRegistry,
  envelope?: ExecutionEnvelope
): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};
  // Build the architecture + file-structure + generic instructions block ONCE
  // per batch. Each task agent prompt prepends this so identical prefixes
  // across subagents are eligible for Anthropic prompt caching.
  const sharedContext = buildSharedTaskContext(state, envelope);

  // Include base agents (developer, qa-engineer, etc.)
  for (const [name, def] of Object.entries(baseAgentDefs)) {
    agents[name] = {
      ...def,
      model: config.subagentModel,
      maxTurns: getMaxTurns(config, "default"),
    };
  }

  // Collect domain-specific agents from registry (everything that isn't a base agent)
  const domainAgents = registry
    .getAll()
    .filter((bp) => !BASE_AGENT_NAMES.has(bp.name));

  // Create a dedicated agent per task in this batch
  for (const task of batch) {
    // Check if a domain agent matches this task by title keywords
    const titleLower = task.title.toLowerCase();
    const matchingDomain = domainAgents.find(
      (bp) =>
        titleLower.includes(bp.name.toLowerCase()) ||
        titleLower.includes(bp.role.toLowerCase())
    );

    if (matchingDomain) {
      const agentName = matchingDomain.name;
      const def = registry.toAgentDefinition(agentName, config);
      console.log(`[dev] Using domain agent: ${agentName}`);
      agents[agentName] = {
        ...def,
        prompt: def.prompt + `\n\n${wrapUserInput("current-task", `**${task.title}**\n${task.description}`)}`,
        model: config.subagentModel,
        maxTurns: getMaxTurns(config, "default"),
      };
    } else {
      const agentName = `dev-${task.id.slice(0, 8)}`;
      console.log(`[dev] Using generic agent for: ${task.title}`);
      const def = buildRunnableAgentDefinition({
        name: agentName,
        role: "Software Developer",
        systemPrompt: buildTaskPrompt(task, sharedContext, envelope),
        tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      }, config);
      agents[agentName] = {
        ...def,
        model: config.subagentModel,
        maxTurns: getMaxTurns(config, "default"),
      };
    }
  }

  return agents;
}

/**
 * Compose a generic-developer agent prompt: shared cached block followed by
 * the per-task suffix. The architecture JSON is NOT inlined here — it lives
 * in `sharedContext` which is built once per batch via
 * `buildSharedTaskContext`.
 *
 * The optional `envelope` argument appends a secondary structured block that
 * carries validated runtime context (project root, branch, package manager,
 * verification command whitelist, OS, Node version). The envelope is emitted
 * AFTER the current-task block so task-specific content still dominates the
 * subagent's attention while runtime assumptions remain visible and machine-
 * readable. Callers that already embed the envelope in `sharedContext` via
 * `buildSharedTaskContext` can omit it here.
 */
export function buildTaskPrompt(
  task: Task,
  sharedContext: string,
  envelope?: ExecutionEnvelope,
): string {
  const taskBlock = wrapUserInput(
    "current-task",
    `**${task.title}**\n${task.description}`,
  );
  const envelopeSuffix = envelope ? `\n\n${renderEnvelopeBlock(envelope)}` : "";
  return `${sharedContext}\n\n${taskBlock}${envelopeSuffix}`;
}

/**
 * Extract every balanced top-level JSON object from `text`.
 * Used to harvest multiple per-task TaskReceipt blocks a batch may emit.
 * Skips content inside string literals so braces in strings don't throw off
 * the brace counter.
 */
export function extractAllJsonObjects(text: string): string[] {
  const out: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = text.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          out.push(candidate);
        } catch {
          /* skip unbalanced / malformed candidate */
        }
        start = -1;
      } else if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }

  return out;
}

/**
 * Harvest structured TaskReceipt blocks from agent output.
 *
 * Accepts either:
 *   - envelope shape `{ "receipts": [<TaskReceipt>...] }`
 *   - one or more bare TaskReceipt objects sprinkled in the output
 *
 * Returns only receipts that pass `TaskReceiptSchema.safeParse`. Anything that
 * looks like a receipt but fails validation is discarded — the owning task
 * will be reported as `invalid_structured_output` downstream.
 */
export function harvestReceipts(output: string): TaskReceipt[] {
  const receipts: TaskReceipt[] = [];
  const seen = new Set<string>();

  for (const candidate of extractAllJsonObjects(output)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    const envelope = TaskReceiptEnvelopeSchema.safeParse(parsed);
    if (envelope.success) {
      for (const r of envelope.data.receipts) {
        if (!seen.has(r.taskId)) {
          seen.add(r.taskId);
          receipts.push(r);
        }
      }
      continue;
    }

    const single = TaskReceiptSchema.safeParse(parsed);
    if (single.success && !seen.has(single.data.taskId)) {
      seen.add(single.data.taskId);
      receipts.push(single.data);
    }
  }

  return receipts;
}

/**
 * Parse task results from agent output — strictly receipt-based (Phase 6).
 *
 * Rules:
 *   - Primary path: harvest TaskReceipt JSON blocks, match by taskId (or title
 *     fallback), validate via Zod.
 *   - A task with a receipt whose `status === "success"` is the ONLY way to
 *     land `TaskResult.success === true`.
 *   - `status === "blocked" | "partial" | "failed"` → `success = false`.
 *   - Invalid / missing receipts → `status = "failed"` with reason
 *     `invalid_structured_output`. No text-heuristic promotion to success.
 *   - Freeform output is captured only as `freeformNotes` for debug.
 */
export function parseTaskResults(output: string, tasks: Task[]): TaskResult[] {
  const receipts = harvestReceipts(output);
  const byId = new Map(receipts.map((r) => [r.taskId, r]));
  const byTitle = new Map(
    receipts.map((r) => [r.taskTitle.trim().toLowerCase(), r]),
  );

  const freeformNotes = output.trim().length > 0 ? output : undefined;

  return tasks.map((task): TaskResult => {
    // Prefer exact id match; fall back to title match.
    let receipt = byId.get(task.id);
    if (!receipt) receipt = byTitle.get(task.title.trim().toLowerCase());

    if (!receipt) {
      // No valid structured receipt → never success, regardless of freeform
      // text. This is the core Phase-6 guarantee.
      const fallback: TaskReceipt = {
        taskId: task.id,
        taskTitle: task.title,
        teamMemberId: "unknown",
        agentRole: "unknown",
        model: "unknown",
        sessionIds: [],
        changedFiles: [],
        verificationCommands: [],
        status: "failed",
        failureReasonCode: "invalid_structured_output",
        ...(freeformNotes ? { freeformNotes } : {}),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      return {
        taskId: task.id,
        success: false,
        ...(freeformNotes ? { output: freeformNotes } : {}),
        error: `Task "${task.title}" has no valid structured receipt (invalid_structured_output)`,
        receipt: fallback,
      };
    }

    const isSuccess = receipt.status === "success";
    const resultText =
      isSuccess
        ? receipt.changedFiles.length > 0
          ? `Changed: ${receipt.changedFiles.join(", ")}`
          : "Receipt reported success"
        : undefined;
    const errorText = isSuccess
      ? undefined
      : `Task "${task.title}" receipt status=${receipt.status}` +
        (receipt.failureReasonCode ? ` (${receipt.failureReasonCode})` : "");

    return {
      taskId: task.id,
      success: isSuccess,
      ...(freeformNotes ? { output: freeformNotes } : {}),
      ...(resultText ? { result: resultText } : {}),
      ...(errorText ? { error: errorText } : {}),
      receipt,
    };
  });
}

/**
 * Persist a task receipt to `<stateDir>/receipts/<phaseId>/<taskId>.json` so
 * audit logs can answer which agent changed which files for each task.
 * Best-effort: on I/O errors we log and continue — a persistence failure must
 * not mask the actual task outcome.
 */
export function persistReceipt(
  stateDir: string,
  phaseId: string,
  receipt: TaskReceipt,
): string | null {
  try {
    const filePath = join(
      stateDir,
      "receipts",
      phaseId,
      `${receipt.taskId}.json`,
    );
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(receipt, null, 2), "utf8");
    return filePath;
  } catch (err) {
    console.warn(
      `[dev] Failed to persist receipt for ${receipt.taskId}: ${errMsg(err)}`,
    );
    return null;
  }
}

async function executeBatch(
  batch: Task[],
  agentDefs: Record<string, AgentDefinition>,
  state: ProjectState,
  config: Config,
  mcpServers: Record<string, McpServerConfig>
): Promise<BatchResult> {
  const taskList = batch
    .map((t, i) => `${i + 1}. **${t.title}**: ${t.description}`)
    .join("\n\n");

  // Derive task agent names from the agentDefs (excludes base agents like developer, qa-engineer)
  const taskAgentNames = Object.keys(agentDefs).filter(
    (name) => !BASE_AGENT_NAMES.has(name)
  );

  // Single-task batch: skip the lead-agent wrapper and dispatch the task's
  // subagent directly. Saves one full turn of lead-agent reasoning plus the
  // Agent-tool invocation overhead (the lead agent's only job would be to
  // delegate to this one subagent).
  if (batch.length === 1 && taskAgentNames.length === 1) {
    const task = batch[0]!;
    const agentName = taskAgentNames[0]!;
    const def = agentDefs[agentName]!;

    const singlePrompt = `Implement the task described in your system prompt. When done, you MUST emit a single structured TaskReceipt JSON block. Freeform text will NOT count as success — only a valid receipt can.

Required receipt shape (all fields mandatory unless marked optional):
\`\`\`json
{
  "taskId": "${task.id}",
  "taskTitle": "${task.title.replace(/"/g, '\\"')}",
  "teamMemberId": "<your agent name>",
  "agentRole": "<your role>",
  "model": "<the model you are running on>",
  "sessionIds": ["<session id(s)>"],
  "branchName": "<feature branch, optional>",
  "commitSha": "<commit sha if created, optional>",
  "changedFiles": ["<relative path>", "..."],
  "verificationCommands": [
    { "command": "npx tsc --noEmit", "success": true, "exitCode": 0, "stdoutSnippet": "..." }
  ],
  "status": "success" | "failed" | "blocked" | "partial",
  "failureReasonCode": "provider_limit | verification_failed | invalid_structured_output | blocked_filesystem | ...",
  "freeformNotes": "<optional debug only>",
  "startedAt": "<ISO-8601>",
  "completedAt": "<ISO-8601>"
}
\`\`\`

Rules:
- Use "blocked" when you could not proceed (missing deps, permission denied, etc.).
- Use "partial" when some acceptance criteria are unmet but progress was made.
- Use "success" only when the task is fully done AND verification passed.
- Omit the receipt or ship malformed JSON → task WILL be marked failed.

After the JSON block, you may add a brief text summary.`;

    let resultText = "";
    let sessionId: string | undefined;
    let costUsd = 0;

    // Preserve the subagent's tool set; intentionally omit "Agent".
    const allowedTools = def.tools ?? ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];

    for await (const message of query({
      prompt: singlePrompt,
      options: {
        systemPrompt: def.prompt,
        allowedTools,
        hooks: {
          PostToolUse: [{ matcher: "Edit|Write", hooks: [auditLoggerHook] }],
        },
        mcpServers,
        model: config.subagentModel,
        maxTurns: getMaxTurns(config, "default"),
        ...getQueryPermissions(config),
      },
    })) {
      if (message.type === "result") {
        if (message.subtype === "success") {
          resultText = message.result;
          sessionId = message.session_id;
          costUsd = message.total_cost_usd;
        } else {
          console.error(
            `[development] Single-task execution ended with error: ${message.subtype}`,
            message.errors
          );
          costUsd = message.total_cost_usd;
        }
      }

      if (isApiRetry(message)) {
        console.warn(
          `[development] API retry attempt ${message.attempt}, waiting ${message.retry_delay_ms}ms`
        );
      }
    }

    const taskResults = parseTaskResults(resultText, batch);
    return { taskResults, costUsd, ...(sessionId !== undefined ? { sessionId } : {}) };
  }

  const prompt = `You are the lead developer orchestrating implementation of ${batch.length} task(s).

## Tasks to implement
${taskList}

## Available subagents
${taskAgentNames.map((name) => `- Use the "${name}" agent for its corresponding task`).join("\n")}

## Instructions
1. For each task, delegate to the corresponding subagent
2. ${batch.length > 1 ? "Tasks in this batch are independent — you can delegate them in parallel" : "Focus on this single task"}
3. After each task completes, verify the implementation:
   - Run \`npx tsc --noEmit\` to check types
   - Run \`npm test\` to check tests
4. If verification fails, send the errors back to the subagent for fixing
5. Create a git branch \`feature/<task-title-slug>\` for each task's work
6. Report the final status of each task

For each task, the assigned subagent MUST emit a structured TaskReceipt. Aggregate them into a single envelope at the end of the lead message:
\`\`\`json
{
  "receipts": [
    {
      "taskId": "<task id from the list above>",
      "taskTitle": "<task title>",
      "teamMemberId": "<subagent name>",
      "agentRole": "<role>",
      "model": "<model>",
      "sessionIds": ["<session ids if available>"],
      "branchName": "<feature branch, optional>",
      "commitSha": "<commit sha, optional>",
      "changedFiles": ["path/to/file.ts"],
      "verificationCommands": [
        { "command": "npx tsc --noEmit", "success": true, "exitCode": 0 },
        { "command": "npm test", "success": true, "exitCode": 0 }
      ],
      "status": "success" | "failed" | "blocked" | "partial",
      "failureReasonCode": "<omit for success, otherwise a reason code>",
      "freeformNotes": "<debug only, optional>",
      "startedAt": "<ISO-8601>",
      "completedAt": "<ISO-8601>"
    }
  ]
}
\`\`\`

Rules:
- A task without a valid receipt will be marked failed regardless of text output.
- "blocked" / "partial" / "failed" are NOT success — only "success" counts.
- Verification commands MUST include the commands you actually ran and their outcomes.`;

  let resultText = "";
  let sessionId: string | undefined;
  let costUsd = 0;

  for await (const message of query({
    prompt,
    options: {
      allowedTools: [
        "Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent",
      ],
      agents: agentDefs,
      hooks: {
        TaskCompleted: [{ hooks: [qualityGateHook] }],
        PostToolUse: [{ matcher: "Edit|Write", hooks: [auditLoggerHook] }],
      },
      mcpServers,
      model: config.model,
      maxTurns: getMaxTurns(config, "development"),
      ...getQueryPermissions(config),
    },
  })) {
    if (message.type === "result") {
      if (message.subtype === "success") {
        resultText = message.result;
        sessionId = message.session_id;
        costUsd = message.total_cost_usd;
      } else {
        console.error(
          `[development] Batch execution ended with error: ${message.subtype}`,
          message.errors
        );
        costUsd = message.total_cost_usd;
      }
    }

    if (isApiRetry(message)) {
      console.warn(
        `[development] API retry attempt ${message.attempt}, waiting ${message.retry_delay_ms}ms`
      );
    }
  }

  // Parse results using structured output when available, falling back to heuristic
  const taskResults = parseTaskResults(resultText, batch);

  return { taskResults, costUsd, ...(sessionId !== undefined ? { sessionId } : {}) };
}

// --- Helpers ---

function getExecStdout(err: unknown): string | null {
  if (err instanceof Error && "stdout" in err) {
    const stdout = (err as Error & { stdout: unknown }).stdout;
    return Buffer.isBuffer(stdout) ? stdout.toString() : typeof stdout === "string" ? stdout : null;
  }
  return null;
}

// --- Quality Gates ---

async function runQualityChecks(): Promise<boolean> {
  const checks = [
    { name: "TypeScript type-check", executable: "npx", args: ["tsc", "--noEmit"] },
    { name: "Tests", executable: "npm", args: ["test"] },
  ];

  let allPassed = true;

  for (const check of checks) {
    try {
      await execFileAsync(check.executable, check.args, { timeout: 120_000 });
      console.log(`[development] Quality check passed: ${check.name}`);
    } catch (err) {
      allPassed = false;
      const output =
        getExecStdout(err)?.slice(0, 300) ?? "unknown error";
      console.warn(`[development] Quality check FAILED: ${check.name}\n${output}`);
    }
  }

  return allPassed;
}

async function autoFixQualityIssues(
  state: ProjectState,
  config: Config,
  agentDefs: Record<string, AgentDefinition>,
  mcpServers: Record<string, McpServerConfig>
): Promise<{ fixed: boolean; costUsd: number }> {
  // Capture current errors
  let typeErrors = "";
  let testErrors = "";

  try {
    await execFileAsync("npx", ["tsc", "--noEmit"], { timeout: 120_000 });
  } catch (err) {
    typeErrors =
      getExecStdout(err)?.slice(0, 2000) ?? "type-check failed";
  }

  try {
    await execFileAsync("npm", ["test"], { timeout: 120_000 });
  } catch (err) {
    testErrors =
      getExecStdout(err)?.slice(0, 2000) ?? "tests failed";
  }

  if (!typeErrors && !testErrors) {
    return { fixed: true, costUsd: 0 };
  }

  const prompt = `You are a developer fixing quality issues in the codebase.

${typeErrors ? `## TypeScript Errors\n\`\`\`\n${typeErrors}\n\`\`\`\n` : ""}
${testErrors ? `## Test Failures\n\`\`\`\n${testErrors}\n\`\`\`\n` : ""}

Fix all the errors above. Read the relevant files, understand the issues, and make corrections.
After fixing, run \`npx tsc --noEmit\` and \`npm test\` to verify.`;

  let costUsd = 0;
  let fixed = false;

  // Convert base agent defs to AgentDefinition shape
  const sdkAgentDefs: Record<string, AgentDefinition> = {};
  for (const [name, def] of Object.entries(agentDefs)) {
    sdkAgentDefs[name] = {
      ...def,
      model: def.model ?? config.subagentModel,
    };
  }

  for await (const message of query({
    prompt,
    options: {
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"],
      agents: sdkAgentDefs,
      mcpServers,
      model: config.subagentModel,
      maxTurns: getMaxTurns(config, "qualityFix"),
      ...getQueryPermissions(config),
    },
  })) {
    if (message.type === "result" && message.subtype === "success") {
      costUsd = message.total_cost_usd;
      fixed = true;
    } else if (message.type === "result") {
      costUsd = message.total_cost_usd;
    }
  }

  // Verify fix
  if (fixed) {
    fixed = await runQualityChecks();
  }

  return { fixed, costUsd };
}
