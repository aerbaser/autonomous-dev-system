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

const execFileAsync = promisify(execFile);
import { TaskResultsSchema } from "../types/llm-schemas.js";
import { getQueryPermissions, getMaxTurns, buildCachedSystemPrompt } from "../utils/sdk-helpers.js";
import { isApiRetry, wrapUserInput, extractFirstJson } from "../utils/shared.js";
import { TaskDecompositionSchema } from "../types/llm-schemas.js";
import { getBaseAgentNames } from "../agents/base-blueprints.js";
import { progress } from "../utils/progress.js";

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
  const signal = ctx?.signal;

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
  const baseAgentDefs = getAgentDefinitions(registry);
  const mcpServers = state.environment
    ? getMcpServerConfigs(state.environment.mcpServers)
    : {};

  let totalCost = 0;
  const batchSessionIds: string[] = [];

  // --- Parallel batch scheduler ---------------------------------------------
  //
  // Batches are eligible to run concurrently when their estimated file globs
  // are disjoint (no two batches touch the same file). Up to
  // `config.maxParallelBatches` batches run at a time. An in-memory mutex
  // (stateMutex) serializes the state-update/save section so concurrent
  // batches can't clobber each other's persisted state.
  const maxParallel = Math.max(1, config.maxParallelBatches ?? 3);
  const batchGlobs: string[][] = taskBatches.map((b) => estimateBatchFileGlobs(b));

  const stateMutex = createMutex();
  const results = new Map<number, BatchResult>();
  const running = new Map<number, Promise<void>>();
  const runningGlobs = new Map<number, string[]>();
  let nextIdx = 0;

  const scheduleBatch = (batchIdx: number): Promise<void> => {
    const batch = taskBatches[batchIdx]!;
    const globs = batchGlobs[batchIdx]!;
    runningGlobs.set(batchIdx, globs);

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
      registry
    );

    const p = (async () => {
      const batchResult = await executeBatch(
        batch,
        batchAgentDefs,
        updatedState,
        config,
        mcpServers
      );
      results.set(batchIdx, batchResult);

      // Serialize the state mutation + persistence section so concurrent
      // batches can't clobber each other.
      await stateMutex.run(async () => {
        totalCost += batchResult.costUsd;
        if (batchResult.sessionId) batchSessionIds.push(batchResult.sessionId);

        progress.emit("batch:end", { index: batchIdx, success: batchResult.taskResults.every((r) => r.success) });

        for (const taskResult of batchResult.taskResults) {
          updatedState = updateTask(updatedState, taskResult.taskId, {
            status: taskResult.success ? "completed" : "failed",
            ...(taskResult.result !== undefined ? { result: taskResult.result } : {}),
            ...(taskResult.error !== undefined ? { error: taskResult.error } : {}),
            ...(taskResult.success ? { completedAt: new Date().toISOString() } : {}),
          });
          saveState(config.stateDir, updatedState);
        }

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
      });

      // Quality gate after each batch (serialized so only one runs at a time)
      await stateMutex.run(async () => {
        const qualityOk = await runQualityChecks(signal);
        if (!qualityOk) {
          console.warn("[development] Quality checks failed after batch. Attempting auto-fix...");
          const fixResult = await autoFixQualityIssues(
            updatedState,
            config,
            baseAgentDefs,
            mcpServers,
            signal
          );
          totalCost += fixResult.costUsd;
          if (!fixResult.fixed) {
            console.error("[development] Auto-fix failed. Continuing to next batch.");
          }
        }
      });
    })();

    return p;
  };

  while (nextIdx < taskBatches.length || running.size > 0) {
    // Start as many non-conflicting batches as we can
    while (nextIdx < taskBatches.length && running.size < maxParallel) {
      const idx = nextIdx;
      const globs = batchGlobs[idx]!;
      let hasConflict = false;
      for (const activeGlobs of runningGlobs.values()) {
        if (globsConflict(globs, activeGlobs)) {
          hasConflict = true;
          break;
        }
      }
      if (hasConflict) break; // wait for a running batch to drain

      const promise = scheduleBatch(idx).finally(() => {
        running.delete(idx);
        runningGlobs.delete(idx);
      });
      running.set(idx, promise);
      nextIdx++;
    }

    if (running.size > 0) {
      await Promise.race(running.values());
    }
  }

  // Step 6: Final quality check
  const finalQuality = await runQualityChecks(signal);

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

const GENERIC_DEV_INSTRUCTIONS = `You are an expert developer. Implement the task described below.

## Instructions
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
export function buildSharedTaskContext(state: ProjectState): string {
  const archJson = JSON.stringify(state.architecture, null, 2);
  const fileStructure = state.architecture?.fileStructure ?? "Not specified";
  const staticContext = `${wrapUserInput("architecture", archJson)}

## File Structure
${fileStructure}`;
  return buildCachedSystemPrompt(staticContext, GENERIC_DEV_INSTRUCTIONS);
}

export function buildBatchAgents(
  batch: Task[],
  state: ProjectState,
  baseAgentDefs: Record<string, { description: string; prompt: string; tools: string[] }>,
  config: Config,
  registry: AgentRegistry
): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};
  // Build the architecture + file-structure + generic instructions block ONCE
  // per batch. Each task agent prompt prepends this so identical prefixes
  // across subagents are eligible for Anthropic prompt caching.
  const sharedContext = buildSharedTaskContext(state);

  // Include base agents (developer, qa-engineer, etc.)
  for (const [name, def] of Object.entries(baseAgentDefs)) {
    agents[name] = {
      description: def.description,
      prompt: def.prompt,
      tools: def.tools,
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

    const taskBlock = wrapUserInput(
      "current-task",
      `**${task.title}**\n${task.description}`
    );

    if (matchingDomain) {
      const agentName = matchingDomain.name;
      const def = registry.toAgentDefinition(agentName);
      console.log(`[dev] Using domain agent: ${agentName}`);
      // Domain specialization stays up top (cache-friendly across domain
      // matches), shared architecture block follows, then the per-task suffix.
      agents[agentName] = {
        description: def.description,
        prompt: `${def.prompt}\n\n${sharedContext}\n\n${taskBlock}`,
        tools: def.tools,
        model: config.subagentModel,
        maxTurns: getMaxTurns(config, "default"),
      };
    } else {
      const agentName = `dev-${task.id.slice(0, 8)}`;
      console.log(`[dev] Using generic agent for: ${task.title}`);
      agents[agentName] = {
        description: `Implement: ${task.title}`,
        prompt: buildTaskPrompt(task, sharedContext),
        tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
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
 */
export function buildTaskPrompt(task: Task, sharedContext: string): string {
  return `${sharedContext}\n\n${wrapUserInput("current-task", `**${task.title}**\n${task.description}`)}`;
}

/**
 * Parse task results from agent output. Prefers structured JSON blocks,
 * falls back to text heuristic for backward compatibility.
 */
function parseTaskResults(output: string, tasks: Task[]): TaskResult[] {
  // Try to find a JSON block with a "tasks" array in the output
  const jsonStr = extractFirstJson(output);
  if (jsonStr) {
    try {
      const parseResult = TaskResultsSchema.safeParse(JSON.parse(jsonStr));
      if (parseResult.success) {
        const parsed = parseResult.data;
        return tasks.map((task) => {
          const match = parsed.tasks.find((t) =>
            t.title.toLowerCase().includes(task.title.toLowerCase())
          );
          const hasFail = match?.status === "failed";
          return {
            taskId: task.id,
            success: match ? !hasFail : false,
            output,
            ...(output.length > 0 ? { result: "Implemented as part of batch" } : {}),
            ...(hasFail ? { error: `Task "${task.title}" reported as failed` } : {}),
          };
        });
      }
    } catch {
      /* fall through to heuristic */
    }
  }

  // Fallback: heuristic (existing behavior)
  console.log(
    "[dev] Warning: no structured output found, using text heuristic"
  );
  return tasks.map((task) => {
    const titleLower = task.title.toLowerCase();
    const outputLower = output.toLowerCase();
    const hasFail =
      outputLower.includes(titleLower) &&
      (outputLower.includes("failure") || outputLower.includes("failed"));
    return {
      taskId: task.id,
      success: !hasFail && output.length > 0,
      output,
      ...(output.length > 0 ? { result: "Implemented as part of batch" } : {}),
      ...(hasFail ? { error: `Task "${task.title}" reported as failed` } : {}),
    };
  });
}

async function executeBatch(
  batch: Task[],
  agentDefs: Record<string, AgentDefinition>,
  state: ProjectState,
  config: Config,
  mcpServers: Record<string, McpServerConfig>
): Promise<BatchResult> {
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

    const singlePrompt = `Implement the task described in your system prompt. When done, report the result as structured JSON:
\`\`\`json
{ "tasks": [{ "title": "${task.title.replace(/"/g, '\\"')}", "status": "success" | "failed" }] }
\`\`\`
Follow with a brief text summary.`;

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

  const taskList = batch
    .map((t, i) => `${i + 1}. **${t.title}**: ${t.description}`)
    .join("\n\n");

  const prompt = `You are the lead developer orchestrating implementation of ${batch.length} task(s).

## Tasks to implement
${taskList}

## Available subagents
${taskAgentNames.map((name) => `- Use the "${name}" agent for its corresponding task`).join("\n")}

## Instructions
1. For each task, delegate to the corresponding subagent
2. Tasks in this batch are independent. You MUST invoke all subagents in a SINGLE assistant message (multiple Agent tool calls in parallel) to maximize throughput.
3. After each task completes, verify the implementation:
   - Run \`npx tsc --noEmit\` to check types
   - Run \`npm test\` to check tests
4. If verification fails, send the errors back to the subagent for fixing
5. Create a git branch \`feature/<task-title-slug>\` for each task's work
6. Report the final status of each task

For each task, report as structured JSON:
\`\`\`json
{ "tasks": [{ "title": "<task title>", "status": "success" | "failed" }] }
\`\`\`
Also include a brief text summary for each task.`;

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

// --- Parallel scheduling helpers ---

/**
 * Static analysis of a task description/title to extract file path references.
 * Heuristic extraction — conservative by design.
 *
 * Looks for:
 *   - Paths with `/` or common source file extensions (.ts, .tsx, .js, .jsx,
 *     .py, .go, .java, .rb, .rs, .cpp, .c, .h, .md, .json, .yaml, .yml, .html,
 *     .css, .scss, .vue, .svelte)
 *   - Capitalised component names following verbs like "Create", "Modify",
 *     "Update", "Add", "Refactor", "Implement"
 *
 * Returns `["*"]` when nothing can be extracted so the scheduler treats the
 * task as conflicting with everything (serial fallback).
 */
export function estimateTaskFileGlobs(task: { title: string; description: string }): string[] {
  const text = `${task.title}\n${task.description}`;
  const globs = new Set<string>();

  // Match paths / filenames with an extension, optionally including `/`.
  const pathRegex =
    /\b(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|py|go|java|rb|rs|cpp|cc|c|h|hpp|md|json|ya?ml|html|css|scss|vue|svelte)\b/g;
  for (const match of text.matchAll(pathRegex)) {
    globs.add(match[0]);
  }

  // Match explicit paths with `/` even without an extension.
  const slashRegex = /\b(?:src|tests?|lib|app|pkg|cmd|internal|packages)\/[\w./-]+/g;
  for (const match of text.matchAll(slashRegex)) {
    globs.add(match[0]);
  }

  // Component names following verbs (Create X, Update Y, etc.). Used as a
  // fallback logical identifier — we normalise them to lowercase to act as
  // keys in the conflict graph.
  const componentRegex =
    /\b(?:Create|Modify|Update|Add|Refactor|Implement|Build|Delete|Remove|Fix)\s+(?:the\s+|a\s+|an\s+)?([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)?)/g;
  for (const match of text.matchAll(componentRegex)) {
    const name = match[1];
    if (name) globs.add(`component:${name.toLowerCase().replace(/\s+/g, "-")}`);
  }

  if (globs.size === 0) return ["*"];
  return [...globs];
}

/** Union of estimated globs for every task in a batch. */
function estimateBatchFileGlobs(batch: Task[]): string[] {
  const all = new Set<string>();
  for (const t of batch) {
    for (const g of estimateTaskFileGlobs(t)) all.add(g);
  }
  return [...all];
}

/**
 * Conservative overlap check between two glob sets. Treats `*` as "matches
 * everything" and uses prefix matching as a cheap approximation otherwise.
 */
function globsConflict(a: string[], b: string[]): boolean {
  if (a.includes("*") || b.includes("*")) return true;
  for (const ga of a) {
    for (const gb of b) {
      if (ga === gb) return true;
      // Prefix match: `src/foo` overlaps with `src/foo/bar.ts`.
      if (ga.includes("/") && gb.startsWith(ga + "/")) return true;
      if (gb.includes("/") && ga.startsWith(gb + "/")) return true;
    }
  }
  return false;
}

/** True when two batches share any estimated file glob. */
export function batchesConflict(batchA: Task[], batchB: Task[]): boolean {
  return globsConflict(estimateBatchFileGlobs(batchA), estimateBatchFileGlobs(batchB));
}

/**
 * Tiny async mutex — serialises work through `run()`. Used to protect the
 * state-update section of the concurrent batch loop.
 */
interface Mutex {
  run<T>(task: () => Promise<T>): Promise<T>;
}

function createMutex(): Mutex {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task, task);
      tail = result.catch(() => undefined);
      return result;
    },
  };
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

async function runQualityChecks(signal?: AbortSignal): Promise<boolean> {
  const checks = [
    { name: "TypeScript type-check", executable: "npx", args: ["tsc", "--noEmit"] },
    { name: "Tests", executable: "npm", args: ["test"] },
  ];

  let allPassed = true;

  for (const check of checks) {
    if (signal?.aborted) {
      console.warn(`[development] Aborted before running: ${check.name}`);
      return false;
    }
    try {
      // Pass the interrupter signal so SIGINT terminates the child process
      // (Node sends SIGTERM by default, then SIGKILL after the grace window
      // if the process is still alive). killSignal is set explicitly for
      // clarity.
      const opts: Parameters<typeof execFileAsync>[2] = {
        timeout: 120_000,
        killSignal: "SIGTERM",
        ...(signal ? { signal } : {}),
      };
      await execFileAsync(check.executable, check.args, opts);
      console.log(`[development] Quality check passed: ${check.name}`);
    } catch (err) {
      if (signal?.aborted) {
        console.warn(`[development] Quality check aborted: ${check.name}`);
        return false;
      }
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
  agentDefs: Record<string, { description: string; prompt: string; tools: string[] }>,
  mcpServers: Record<string, McpServerConfig>,
  signal?: AbortSignal,
): Promise<{ fixed: boolean; costUsd: number }> {
  // Capture current errors
  let typeErrors = "";
  let testErrors = "";

  const execOpts: Parameters<typeof execFileAsync>[2] = {
    timeout: 120_000,
    killSignal: "SIGTERM",
    ...(signal ? { signal } : {}),
  };

  try {
    await execFileAsync("npx", ["tsc", "--noEmit"], execOpts);
  } catch (err) {
    if (signal?.aborted) return { fixed: false, costUsd: 0 };
    typeErrors =
      getExecStdout(err)?.slice(0, 2000) ?? "type-check failed";
  }

  try {
    await execFileAsync("npm", ["test"], execOpts);
  } catch (err) {
    if (signal?.aborted) return { fixed: false, costUsd: 0 };
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
      description: def.description,
      prompt: def.prompt,
      tools: def.tools,
      model: config.subagentModel,
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
    fixed = await runQualityChecks(signal);
  }

  return { fixed, costUsd };
}
