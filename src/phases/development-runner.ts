import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDefinition, OutputFormat } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type {
  ProjectState,
  PhaseCheckpoint,
  McpServerConfig,
  Task,
  UserStory,
  AgentBlueprint,
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
import { resolveAuxiliaryFlags } from "../utils/config.js";
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
import { isApiRetry, wrapUserInput, errMsg } from "../utils/shared.js";
import { TaskDecompositionSchema } from "../types/llm-schemas.js";
import { getBaseAgentNames } from "../agents/base-blueprints.js";
import { getPhaseSpecialistNames } from "../agents/phase-specialist-blueprints.js";
import { progress } from "../utils/progress.js";
import {
  type ExecutionEnvelope,
  renderEnvelopeBlock,
} from "../runtime/execution-envelope.js";
import { MemoryStore } from "../state/memory-store.js";
import { SkillStore, extractSignature, toDomainSlug } from "../memory/skills.js";
import type { SkillPlaybook } from "../types/skills.js";

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
      ...(at.domain !== undefined ? { domain: at.domain } : {}),
      ...(at.tags !== undefined ? { tags: at.tags } : {}),
    }));
    for (const dt of devTasks) {
      updatedState = addTask(updatedState, {
        title: dt.title,
        description: `${dt.description}\n\nAcceptance Criteria:\n${dt.acceptanceCriteria.map((ac) => `- ${ac}`).join("\n")}`,
        ...(dt.domain !== undefined ? { domain: dt.domain } : {}),
        ...(dt.tags !== undefined ? { tags: dt.tags } : {}),
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
        ...(dt.domain !== undefined ? { domain: dt.domain } : {}),
        ...(dt.tags !== undefined ? { tags: dt.tags } : {}),
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

  // Phase A — Skill crystallization. Instantiate the skill store from the
  // state dir when layered memory is enabled. We keep this local to the
  // runner (rather than plumbing through PhaseExecutionContext) because skill
  // reuse is a development-phase concern; other phases don't need it.
  const skillStore =
    config.memory?.enabled && config.memory.layers?.enabled
      ? new SkillStore(
          new MemoryStore(config.stateDir, {
            maxDocuments: config.memory.maxDocuments,
            maxDocumentSizeKb: config.memory.maxDocumentSizeKb,
          }),
        )
      : null;

  let totalCost = 0;
  const batchSessionIds: string[] = [];

  // Phase 8: resolve auxiliary flags once per phase so inner loops don't
  // re-read the profile on every batch.
  const auxFlags = resolveAuxiliaryFlags(config);

  for (let batchIdx = 0; batchIdx < taskBatches.length; batchIdx++) {
    const batch = taskBatches[batchIdx]!;
    progress.emit("batch:start", { index: batchIdx, total: taskBatches.length, taskCount: batch.length });
    console.log(
      `[development] Batch ${batchIdx + 1}/${taskBatches.length}: ` +
        `${batch.length} task(s) — ${batch.map((t) => t.title).join(", ")}`
    );

    // Phase A: resolve one playbook per task (if any) before building agents
    // so the prompt suffix is included in `buildBatchAgents`. Domain flows as
    // task-specific → project-level → "generic" fallback so skills stay
    // domain-scoped instead of leaking across unrelated projects.
    const projectDomain = updatedState.spec?.domain.classification;
    const taskSkills = new Map<string, SkillPlaybook>();
    for (const task of batch) {
      const skill = await resolveSkillForTask(
        task,
        "development",
        skillStore,
        projectDomain,
      );
      if (skill) taskSkills.set(task.id, skill);
    }

    const batchAgentDefs = buildBatchAgents(
      batch,
      updatedState,
      baseAgentDefs,
      config,
      registry,
      ctx?.envelope,
      taskSkills,
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
        if (skillStore && taskResult.receipt.status === "success") {
          try {
            const batchTask = batch.find((t) => t.id === taskResult.taskId);
            const crystallizeDomain = toDomainSlug(
              batchTask?.domain ?? projectDomain,
            );
            await skillStore.crystallize(taskResult.receipt, {
              domain: crystallizeDomain,
              phase: "development",
            });
          } catch (err) {
            console.warn(
              `[skill-store] Failed to crystallize receipt for ${taskResult.receipt.taskId}: ${errMsg(err)}`,
            );
          }
        }
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

    // Step 5: Quality gate after each batch. The auto-fix retry loop is
    // Phase 8-gated — under the `minimal` profile we only report failures
    // and keep going, leaving expensive fix attempts to the `debug` /
    // `nightly` profiles. This keeps core runs bounded.
    const qualityOk = await runQualityChecks();
    if (!qualityOk) {
      if (auxFlags.qualityFixRetry) {
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
      } else {
        console.warn(
          "[development] Quality checks failed — auto-fix retry disabled by auxiliary profile " +
          `(${config.auxiliaryProfile}). Continuing to next batch.`,
        );
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
        ...(t.domain !== undefined ? { domain: t.domain } : {}),
        ...(t.tags !== undefined ? { tags: t.tags } : {}),
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
// v1.1 super-lead: phase specialists live in the registry but must NEVER
// be matched as task-agents in development. Treated as "base" (i.e. filtered
// out of domain-agent candidates) for dev-runner purposes.
const PHASE_SPECIALIST_NAMES = getPhaseSpecialistNames();
const EXCLUDED_FROM_DOMAIN_AGENTS = new Set([...BASE_AGENT_NAMES, ...PHASE_SPECIALIST_NAMES]);

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

/**
 * HIGH-06 — Match a task to its best domain-specialized agent (if any).
 *
 * Scoring (deterministic):
 *   +3 if task.title (case-insensitive) contains the agent's name
 *   +2 if task.title (case-insensitive) contains the agent's role
 *   +1 per agent.keywords[i] that appears (case-insensitive substring) in
 *      task.title OR task.description
 *   +1 per task.tags[j] whose lowercase equals a lowercased agent.keywords[k]
 *
 * Returns the highest-scoring agent. A score of zero is treated as "no match"
 * so we don't accidentally promote a base/generic agent over the dev-{id}
 * fallback. Ties are broken by input order (which mirrors registry
 * registration order — first registered wins).
 *
 * The function is pure and exported so unit tests can call it directly without
 * spinning up the full runner.
 */
export function matchDomainAgentForTask(
  task: Task,
  domainAgents: AgentBlueprint[],
): AgentBlueprint | undefined {
  const titleLower = task.title.toLowerCase();
  const descLower = task.description.toLowerCase();
  const tagSet = new Set(
    (task.tags ?? []).map((t) => t.toLowerCase()),
  );

  let best: AgentBlueprint | undefined;
  let bestScore = 0;

  for (const bp of domainAgents) {
    let score = 0;
    if (titleLower.includes(bp.name.toLowerCase())) score += 3;
    if (titleLower.includes(bp.role.toLowerCase())) score += 2;

    for (const kw of bp.keywords ?? []) {
      const kwLower = kw.toLowerCase();
      if (titleLower.includes(kwLower) || descLower.includes(kwLower)) {
        score += 1;
      }
      if (tagSet.has(kwLower)) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = bp;
    }
  }

  return bestScore > 0 ? best : undefined;
}

export function buildBatchAgents(
  batch: Task[],
  state: ProjectState,
  baseAgentDefs: Record<string, AgentDefinition>,
  config: Config,
  registry: AgentRegistry,
  envelope?: ExecutionEnvelope,
  taskSkills?: Map<string, SkillPlaybook>,
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

  // Collect domain-specific agents from registry (everything that isn't a
  // base agent OR a v1.1 phase specialist).
  const domainAgents = registry
    .getAll()
    .filter((bp) => !EXCLUDED_FROM_DOMAIN_AGENTS.has(bp.name));

  // Create a dedicated agent per task in this batch
  for (const task of batch) {
    // HIGH-06: keyword-aware matching — scores name/role substring (preserved
    // legacy behavior) PLUS keyword∩title, keyword∩description, and
    // keyword∩task.tags. See `matchDomainAgentForTask` for scoring details.
    const matchingDomain = matchDomainAgentForTask(task, domainAgents);

    const skill = taskSkills?.get(task.id);
    const skillSuffix = skill ? `\n\n${renderSkillBlock(skill)}` : "";

    if (matchingDomain) {
      const agentName = matchingDomain.name;
      const def = registry.toAgentDefinition(agentName, config);
      console.log(`[dev] Using domain agent: ${agentName}`);
      agents[agentName] = {
        ...def,
        prompt:
          def.prompt +
          `\n\n${wrapUserInput("current-task", `**${task.title}**\n${task.description}`)}` +
          skillSuffix,
        model: config.subagentModel,
        maxTurns: getMaxTurns(config, "default"),
      };
    } else {
      const agentName = `dev-${task.id.slice(0, 8)}`;
      console.log(`[dev] Using generic agent for: ${task.title}`);
      const def = buildRunnableAgentDefinition({
        name: agentName,
        role: "Software Developer",
        systemPrompt: buildTaskPrompt(task, sharedContext, envelope, skill),
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
 * Render a SkillPlaybook as a `<prior-successful-approach>` block suitable for
 * appending to a task prompt. Kept as a pure function so tests can assert the
 * exact shape of the injected text without booting the full runner.
 */
export function renderSkillBlock(skill: SkillPlaybook): string {
  const files =
    skill.changedFiles.length > 0
      ? skill.changedFiles.join(", ")
      : "(none recorded)";
  const verification =
    skill.verificationCommands.length > 0
      ? skill.verificationCommands.join("; ")
      : "(none recorded)";
  return `<prior-successful-approach>
Previously-successful approach for similar task "${skill.taskTitle}" (used ${skill.useCount}x):
Files typically changed: ${files}
Verification: ${verification}
</prior-successful-approach>`;
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
 *
 * The optional `skill` argument appends a `<prior-successful-approach>` block
 * summarizing a matching playbook (Phase A — skill crystallization). It goes
 * after the envelope so the current task still leads attention.
 */
export function buildTaskPrompt(
  task: Task,
  sharedContext: string,
  envelope?: ExecutionEnvelope,
  skill?: SkillPlaybook,
): string {
  const taskBlock = wrapUserInput(
    "current-task",
    `**${task.title}**\n${task.description}`,
  );
  const envelopeSuffix = envelope ? `\n\n${renderEnvelopeBlock(envelope)}` : "";
  const skillSuffix = skill ? `\n\n${renderSkillBlock(skill)}` : "";
  return `${sharedContext}\n\n${taskBlock}${envelopeSuffix}${skillSuffix}`;
}

/**
 * Resolve the best matching skill playbook for a task, if any, and log
 * injection for observability. Returns undefined when skill injection is
 * disabled, no store is available, or there is no matching playbook.
 *
 * Domain fallback chain: task's own `domain` field → the project-level
 * `stateDomain` (usually `state.spec.domain.classification`) → "generic".
 * The result is normalized through `toDomainSlug` so the signature matches
 * the form used by `crystallize`.
 */
export async function resolveSkillForTask(
  task: Task,
  phase: string,
  skillStore: SkillStore | null,
  stateDomain?: string,
): Promise<SkillPlaybook | undefined> {
  if (!skillStore) return undefined;
  const domain = toDomainSlug(task.domain ?? stateDomain);
  const signature = extractSignature(task.title, domain, phase);
  const matches = await skillStore.findMatching(signature, 1);
  const skill = matches[0];
  if (!skill) return undefined;
  console.log(`[skill-store] Injected skill ${skill.id} (useCount=${skill.useCount})`);
  await skillStore.recordUse(skill.id);
  return skill;
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

interface DirectDispatchResult {
  taskId: string;
  resultText: string;
  sessionId: string | undefined;
  costUsd: number;
}

/**
 * Phase 3: dispatch a single task directly to its owning subagent, skipping
 * the "lead developer" wrapper entirely. This is the default execution path —
 * the lead wrapper is gated behind `config.developmentCoordinator.enabled`.
 *
 * The SDK `query()` uses the subagent's prompt as `systemPrompt` and omits the
 * Agent tool, so there is no second coordination loop around this call.
 */
async function dispatchTaskDirect(
  task: Task,
  agentName: string,
  def: AgentDefinition,
  config: Config,
  mcpServers: Record<string, McpServerConfig>,
): Promise<DirectDispatchResult> {
  const prompt = `Implement the task described in your system prompt. When done, you MUST emit a single structured TaskReceipt JSON block. Freeform text will NOT count as success — only a valid receipt can.

Required receipt shape (all fields mandatory unless marked optional):
\`\`\`json
{
  "taskId": "${task.id}",
  "taskTitle": "${task.title.replace(/"/g, '\\"')}",
  "teamMemberId": "${agentName}",
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

  // Preserve the subagent's tool set; intentionally omit "Agent" so there is
  // no way for the subagent to spawn its own coordinator.
  const allowedTools = def.tools ?? ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];

  for await (const message of query({
    prompt,
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
          `[development] Direct-dispatch task "${task.title}" ended with error: ${message.subtype}`,
          message.errors,
        );
        costUsd = message.total_cost_usd;
      }
    }

    if (isApiRetry(message)) {
      console.warn(
        `[development] API retry attempt ${message.attempt}, waiting ${message.retry_delay_ms}ms`,
      );
    }
  }

  return { taskId: task.id, resultText, sessionId, costUsd };
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

  // Derive task agent names from the agentDefs (excludes base agents like
  // developer, qa-engineer AND v1.1 phase specialists).
  const taskAgentNames = Object.keys(agentDefs).filter(
    (name) => !EXCLUDED_FROM_DOMAIN_AGENTS.has(name)
  );

  // Phase 3 — Direct-dispatch fast path (default execution mode).
  //
  // When every task has exactly one owning subagent (batch.length === taskAgentNames.length)
  // AND the lead-developer coordinator is not explicitly enabled, we dispatch
  // each task straight to its subagent in parallel. This removes the legacy
  // "lead developer" prompt wrapper that used to orchestrate delegation on top
  // of native subagents — pure double coordination, per the Phase 3 plan.
  //
  // The legacy lead wrapper is retained below as an opt-in debug path via
  // `config.developmentCoordinator.enabled === true`.
  const coordinatorEnabled = config.developmentCoordinator?.enabled === true;
  const canDirectDispatch =
    !coordinatorEnabled &&
    batch.length > 0 &&
    batch.length === taskAgentNames.length;

  if (canDirectDispatch) {
    // Build 1:1 assignment from task to its owning subagent. Naming convention
    // in `buildBatchAgents`: generic tasks get `dev-<taskIdPrefix>`; domain
    // tasks get the domain agent name. We reconstruct the mapping by matching
    // task.id against the `dev-` suffix and falling back to arbitrary pairing
    // for domain agents (they already live 1:1 with the batch member).
    const assignments: Array<{ task: Task; agentName: string }> = [];
    const claimed = new Set<string>();
    for (const task of batch) {
      const devName = `dev-${task.id.slice(0, 8)}`;
      let agentName: string | undefined;
      if (taskAgentNames.includes(devName) && !claimed.has(devName)) {
        agentName = devName;
      } else {
        // Fallback: pick the next unused non-base agent. This mirrors the
        // assignment order used by `buildBatchAgents` for domain agents.
        agentName = taskAgentNames.find((n) => !claimed.has(n));
      }
      if (!agentName) break;
      claimed.add(agentName);
      assignments.push({ task, agentName });
    }

    if (assignments.length === batch.length) {
      console.log(
        `[development] Direct-dispatch fast path: ${batch.length} task(s) → ` +
          `${assignments.length} subagent(s), no lead wrapper`,
      );

      const settled = await Promise.all(
        assignments.map(({ task, agentName }) =>
          dispatchTaskDirect(task, agentName, agentDefs[agentName]!, config, mcpServers),
        ),
      );

      const combinedOutput = settled.map((r) => r.resultText).join("\n");
      const taskResults = parseTaskResults(combinedOutput, batch);
      const costUsd = settled.reduce((sum, r) => sum + r.costUsd, 0);
      // Use the first non-empty session id as the batch-level pointer.
      const sessionId = settled.find((r) => r.sessionId)?.sessionId;
      return { taskResults, costUsd, ...(sessionId !== undefined ? { sessionId } : {}) };
    }
  }

  // Back-compat: preserve the single-task direct-dispatch fast path even when
  // the coordinator flag is enabled, since a single task has literally
  // nothing for a lead to coordinate.
  if (batch.length === 1 && taskAgentNames.length === 1) {
    const task = batch[0]!;
    const agentName = taskAgentNames[0]!;
    const def = agentDefs[agentName]!;
    const { resultText, sessionId, costUsd } = await dispatchTaskDirect(
      task,
      agentName,
      def,
      config,
      mcpServers,
    );
    const taskResults = parseTaskResults(resultText, batch);
    return { taskResults, costUsd, ...(sessionId !== undefined ? { sessionId } : {}) };
  }

  // Legacy / opt-in: lead-developer coordinator wraps native subagents in a
  // second orchestration loop. Gated behind `developmentCoordinator.enabled`
  // because it's pure overhead when tasks have 1:1 owners — that case is
  // handled by the direct-dispatch fast path above.
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
