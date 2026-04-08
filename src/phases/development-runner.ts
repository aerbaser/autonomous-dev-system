import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDefinition, OutputFormat } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type {
  ProjectState,
  PhaseCheckpoint,
  Task,
  UserStory,
} from "../state/project-state.js";
import type { PhaseResult } from "../orchestrator.js";
import type {
  DevTask,
  TaskDecomposition,
  BatchResult,
  TaskResult,
} from "./development-types.js";
import { AgentRegistry } from "../agents/registry.js";
import { getAgentDefinitions } from "../agents/factory.js";
import { getMcpServerConfigs } from "../environment/mcp-manager.js";
import { qualityGateHook } from "../hooks/quality-gate.js";
import { auditLoggerHook } from "../hooks/audit-logger.js";
import {
  addTask,
  updateTask,
  saveCheckpoint as saveCheckpointState,
  saveState,
} from "../state/project-state.js";
import { execFileSync } from "node:child_process";
import { TaskResultsSchema } from "../types/llm-schemas.js";

function extractFirstJson(text: string): string | null {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1);
        try { JSON.parse(candidate); return candidate; } catch { start = -1; }
      }
    }
  }
  return null;
}

// --- Main entry point ---

export async function runDevelopment(
  state: ProjectState,
  config: Config,
  checkpoint?: PhaseCheckpoint | null,
  _sessionId?: string
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
  if (pendingStories.length > 0) {
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
  const completedIds = new Set(checkpoint?.completedTasks ?? []);
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
  const registry = new AgentRegistry(config.stateDir);
  const baseAgentDefs = getAgentDefinitions(registry);
  const mcpServers = state.environment
    ? getMcpServerConfigs(state.environment.mcpServers)
    : {};

  let totalCost = 0;
  let lastSessionId: string | undefined;

  for (let batchIdx = 0; batchIdx < taskBatches.length; batchIdx++) {
    const batch = taskBatches[batchIdx]!;
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

    const batchResult = await executeBatch(
      batch,
      batchAgentDefs,
      updatedState,
      config,
      mcpServers
    );

    totalCost += batchResult.costUsd;
    if (batchResult.sessionId) lastSessionId = batchResult.sessionId;

    // Update task statuses based on results
    for (const taskResult of batchResult.taskResults) {
      updatedState = updateTask(updatedState, taskResult.taskId, {
        status: taskResult.success ? "completed" : "failed",
        ...(taskResult.result !== undefined ? { result: taskResult.result } : {}),
        ...(taskResult.error !== undefined ? { error: taskResult.error } : {}),
        ...(taskResult.success ? { completedAt: new Date().toISOString() } : {}),
      });
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
      metadata: { batchIndex: batchIdx, totalCost },
    };
    updatedState = saveCheckpointState(updatedState, batchCheckpoint);
    saveState(config.stateDir, updatedState);

    console.log(
      `[development] Batch ${batchIdx + 1} complete. ` +
        `Cost so far: $${totalCost.toFixed(4)}`
    );

    // Step 5: Quality gate after each batch
    const qualityOk = runQualityChecks();
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
  const finalQuality = runQualityChecks();

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
    ...(lastSessionId !== undefined ? { sessionId: lastSessionId } : {}),
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

Architecture:
${JSON.stringify(state.architecture, null, 2)}

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
      maxTurns: 3,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
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

  if (structuredOutput && typeof structuredOutput === "object") {
    const obj = structuredOutput as Record<string, unknown>;
    if (Array.isArray(obj.tasks) && obj.tasks.length > 0) {
      return obj.tasks as DevTask[];
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

/**
 * Groups tasks into sequential batches where tasks within a batch
 * have no inter-dependencies and can be worked on in parallel.
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

    batches.push(batch);
    const batchTaskIds = new Set(batch.map((t) => t.id));
    for (const id of batchIds) completed.add(id);
    remaining.splice(0, remaining.length, ...remaining.filter((t) => !batchTaskIds.has(t.id)));
  }

  return batches;
}

// --- Batch Execution ---

const BASE_AGENT_NAMES = new Set([
  "product-manager",
  "architect",
  "developer",
  "qa-engineer",
  "reviewer",
  "devops",
  "analytics",
]);

function buildBatchAgents(
  batch: Task[],
  state: ProjectState,
  baseAgentDefs: Record<string, { description: string; prompt: string; tools: string[] }>,
  config: Config,
  registry: AgentRegistry
): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};

  // Include base agents (developer, qa-engineer, etc.)
  for (const [name, def] of Object.entries(baseAgentDefs)) {
    agents[name] = {
      description: def.description,
      prompt: def.prompt,
      tools: def.tools,
      model: config.subagentModel,
      maxTurns: 50,
    };
  }

  // Collect domain-specific agents from registry (everything that isn't a base agent)
  const domainAgents = registry
    .getAll()
    .filter((bp) => !BASE_AGENT_NAMES.has(bp.name));

  // Create a dedicated agent per task in this batch
  for (const task of batch) {
    // Check if a domain agent matches this task
    const titleLower = task.title.toLowerCase();
    const matchingDomain = domainAgents.find(
      (bp) =>
        titleLower.includes(bp.name.toLowerCase()) ||
        titleLower.includes(bp.role.toLowerCase())
    );

    if (matchingDomain) {
      const agentName = matchingDomain.name;
      const def = registry.toAgentDefinition(agentName);
      console.log(`[dev] Using domain agent: ${agentName}`);
      agents[agentName] = {
        description: def.description,
        prompt: def.prompt + `\n\n## Current Task\n**${task.title}**\n${task.description}`,
        tools: def.tools,
        model: config.subagentModel,
        maxTurns: 50,
      };
    } else {
      const agentName = `dev-${task.id.slice(0, 8)}`;
      console.log(`[dev] Using generic agent for: ${task.title}`);
      agents[agentName] = {
        description: `Implement: ${task.title}`,
        prompt: buildTaskPrompt(task, state),
        tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        model: config.subagentModel,
        maxTurns: 50,
      };
    }
  }

  return agents;
}

function buildTaskPrompt(task: Task, state: ProjectState): string {
  return `You are an expert developer. Implement the following task.

## Task
**${task.title}**
${task.description}

## Architecture
${JSON.stringify(state.architecture, null, 2)}

## File Structure
${state.architecture?.fileStructure ?? "Not specified"}

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
            success: match ? !hasFail : true,
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
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
): Promise<BatchResult> {
  const taskList = batch
    .map((t, i) => `${i + 1}. **${t.title}**: ${t.description}`)
    .join("\n\n");

  // Derive task agent names from the agentDefs (excludes base agents like developer, qa-engineer)
  const taskAgentNames = Object.keys(agentDefs).filter(
    (name) => !BASE_AGENT_NAMES.has(name)
  );

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
      maxTurns: 200,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
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

    if (message.type === "system" && message.subtype === "api_retry") {
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

function runQualityChecks(): boolean {
  const checks = [
    { name: "TypeScript type-check", executable: "npx", args: ["tsc", "--noEmit"] },
    { name: "Tests", executable: "npm", args: ["test"] },
  ];

  let allPassed = true;

  for (const check of checks) {
    try {
      execFileSync(check.executable, check.args, { timeout: 120_000, stdio: "pipe" });
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
  agentDefs: Record<string, { description: string; prompt: string; tools: string[] }>,
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
): Promise<{ fixed: boolean; costUsd: number }> {
  // Capture current errors
  let typeErrors = "";
  let testErrors = "";

  try {
    execFileSync("npx", ["tsc", "--noEmit"], { timeout: 120_000, stdio: "pipe" });
  } catch (err) {
    typeErrors =
      getExecStdout(err)?.slice(0, 2000) ?? "type-check failed";
  }

  try {
    execFileSync("npm", ["test"], { timeout: 120_000, stdio: "pipe" });
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
      maxTurns: 30,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
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
    fixed = runQualityChecks();
  }

  return { fixed, costUsd };
}
