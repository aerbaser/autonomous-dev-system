import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState, ArchDesign, ArchTask } from "../state/project-state.js";
import type { PhaseExecutionContext, PhaseResult } from "./types.js";
import { buildAgentTeam } from "../agents/factory.js";
import { consumeQuery, getQueryPermissions, getMaxTurns, QueryAbortedError } from "../utils/sdk-helpers.js";
import { extractFirstJson, errMsg, isRecord, wrapUserInput } from "../utils/shared.js";
import { ArchDesignSchema } from "../types/llm-schemas.js";
import { runLeadDrivenPhase } from "../orchestrator/lead-driven-phase.js";
import { architectureContract } from "../orchestrator/phase-contracts/architecture.contract.js";

const ARCH_PROMPT = `You are a Principal Software Architect. Given a product specification, design the complete
technical architecture AND decompose work into developer-ready tasks.

Use WebSearch to verify current stable versions of the chosen technologies.

Output a JSON object:
{
  "techStack": {
    "language": "TypeScript 5.x",
    "framework": "Next.js 15",
    "database": "PostgreSQL 16",
    "orm": "Prisma 5",
    "testing": "Vitest + Playwright",
    "infra": "Docker + Railway",
    "... (every technology with its version and role)": "..."
  },
  "components": [
    { "name": "Frontend", "description": "Next.js App Router with React Server Components for all data-fetching pages", "dependencies": [] },
    { "name": "API Layer", "description": "Next.js Route Handlers with Zod request validation", "dependencies": ["Frontend"] },
    "... (one object per component with name, description, and dependencies)"
  ],
  "apiContracts": "OpenAPI 3.1 YAML or GraphQL SDL — must cover ALL endpoints referenced in user stories",
  "databaseSchema": "Prisma schema or SQL DDL — tables, indexes, foreign keys, constraints",
  "fileStructure": "Full project tree showing directory layout and key files",
  "taskDecomposition": {
    "tasks": [
      {
        "id": "T-001",
        "title": "Short imperative task title",
        "description": "What needs to be built, specific file paths, implementation details",
        "estimatedComplexity": "low|medium|high",
        "dependencies": ["T-000"],
        "acceptanceCriteria": [
          "GIVEN the system is running WHEN a user does X THEN Y happens",
          "Unit tests cover the happy path and 2 edge cases",
          "No TypeScript type errors"
        ],
        "domain": "payments-specialist (optional — agent name for domain-specific tasks; omit for generic tasks)"
      }
    ]
  }
}

Architecture guidelines:
- Verify technology versions with WebSearch before recommending
- Prefer battle-tested libraries with active maintenance
- Keep it as simple as possible while meeting ALL non-functional requirements from the spec
- Every component must have a clear owner and clear boundaries
- Task IDs must form a valid DAG (no circular dependencies)
- Tasks must be ordered so each task only depends on earlier task IDs
- Each task must have 3+ specific, testable acceptance criteria
- Decompose into tasks that a single developer can complete in 1-4 hours
- Include setup/scaffolding tasks first (T-001, T-002), then feature tasks

Think through the architecture step by step, then provide your final answer as a JSON object.`;

const ARCH_REPAIR_PROMPT = `You are repairing a previously generated architecture response so it matches the required JSON contract.

Return ONLY a JSON object with this exact structure:
{
  "techStack": { "language": "...", "framework": "..." },
  "components": [
    { "name": "Component name", "description": "What it does", "dependencies": [] }
  ],
  "apiContracts": "Readable API contract summary as a string",
  "databaseSchema": "Readable schema summary as a string",
  "fileStructure": "Readable project tree as a string",
  "taskDecomposition": {
    "tasks": [
      {
        "id": "T-001",
        "title": "Task title",
        "description": "Implementation details",
        "estimatedComplexity": "low|medium|high",
        "dependencies": [],
        "acceptanceCriteria": ["Given/When/Then..."]
      }
    ]
  }
}

Rules:
- apiContracts, databaseSchema, and fileStructure MUST be strings, even if the original response used objects or arrays
- components must be a non-empty array
- Preserve the original intent; only fix structure and missing required fields
- Do not include markdown fences or explanation`;

function stringifyArchitectureField(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

function normalizeArchitecturePayload(payload: unknown): unknown {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  const normalized: Record<string, unknown> = { ...payload as Record<string, unknown> };
  for (const key of ["apiContracts", "databaseSchema", "fileStructure"] as const) {
    if (key in normalized) {
      normalized[key] = stringifyArchitectureField(normalized[key]);
    }
  }

  if (Array.isArray(normalized["components"])) {
    normalized["components"] = normalized["components"].map((component) => {
      if (typeof component === "string") {
        return {
          name: component,
          description: `${component} component`,
          dependencies: [],
        };
      }

      if (!isRecord(component)) {
        return component;
      }

      return {
        name: typeof component["name"] === "string" ? component["name"] : "Unnamed component",
        description: typeof component["description"] === "string"
          ? component["description"]
          : stringifyArchitectureField(component),
        dependencies: Array.isArray(component["dependencies"])
          ? component["dependencies"].filter((dep): dep is string => typeof dep === "string")
          : [],
      };
    });
  }

  return normalized;
}

function validateArchitectureCompleteness(
  architecture: Pick<ArchDesign, "techStack" | "components" | "apiContracts" | "databaseSchema" | "fileStructure">
): string | undefined {
  const missing: string[] = [];
  if (Object.keys(architecture.techStack).length === 0) missing.push("techStack");
  if (architecture.components.length === 0) missing.push("components");
  if (architecture.apiContracts.trim().length === 0) missing.push("apiContracts");
  if (architecture.databaseSchema.trim().length === 0) missing.push("databaseSchema");
  if (architecture.fileStructure.trim().length === 0) missing.push("fileStructure");
  if (missing.length === 0) return undefined;
  return `Architecture incomplete: missing ${missing.join(", ")}`;
}

function parseArchitectureText(archText: string): {
  parsed?: ReturnType<typeof ArchDesignSchema.parse>;
  error?: string;
} {
  const jsonStr = extractFirstJson(archText);
  if (!jsonStr) {
    return { error: "no valid JSON" };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonStr);
  } catch {
    return { error: "no valid JSON" };
  }

  const normalizedPayload = normalizeArchitecturePayload(parsedJson);
  const archParseResult = ArchDesignSchema.safeParse(normalizedPayload);
  if (!archParseResult.success) {
    return { error: archParseResult.error.message };
  }

  const completenessError = validateArchitectureCompleteness(archParseResult.data);
  if (completenessError) {
    return { error: completenessError };
  }

  return { parsed: archParseResult.data };
}

async function repairArchitectureText(
  archText: string,
  parseError: string,
  config: Config,
  ctx?: PhaseExecutionContext,
): Promise<{ repairedText: string; costUsd?: number; sessionId?: string }> {
  const repairResult = await consumeQuery(
    query({
      prompt: `${ARCH_REPAIR_PROMPT}

Validation error: ${parseError}

${wrapUserInput("broken-architecture-response", archText)}`,
      options: {
        allowedTools: [],
        ...getQueryPermissions(config),
        maxTurns: 1,
      },
    }),
    {
      label: "architecture-repair",
      eventBus: ctx?.eventBus,
      phase: "architecture",
      agentName: "architecture-repair",
      model: config.model,
    }
  );

  return {
    repairedText: repairResult.result,
    ...(repairResult.cost != null ? { costUsd: repairResult.cost } : {}),
    ...(repairResult.sessionId ? { sessionId: repairResult.sessionId } : {}),
  };
}

export async function runArchitecture(
  state: ProjectState,
  config: Config,
  ctx?: PhaseExecutionContext,
): Promise<PhaseResult> {
  if (!state.spec) {
    return { success: false, state, error: "No spec found. Run ideation first." };
  }

  console.log("[architecture] Designing system architecture...");
  const signal = ctx?.signal;

  // Also initialize the agent team (domain analysis -> dynamic agents)
  const { registry } = await buildAgentTeam(state, config, signal);

  // v1.1 super-lead path — opt-in via AUTONOMOUS_DEV_LEAD_DRIVEN=1 env var.
  // When enabled, the phase runs through the lead-driven primitive with
  // security-reviewer + scalability-reviewer specialists. Default path
  // (below) is unchanged for backwards compatibility and for projects that
  // haven't opted in yet.
  if (process.env["AUTONOMOUS_DEV_LEAD_DRIVEN"] === "1") {
    console.log("[architecture] lead-driven mode enabled — spawning agent team");
    return runLeadDrivenPhase({
      contract: architectureContract,
      state,
      config,
      ...(ctx ? { execCtx: ctx } : {}),
      registry,
      applyResult: (s, arch) => {
        const architecture: ArchDesign = {
          techStack: arch.techStack,
          components: arch.components,
          apiContracts: arch.apiContracts,
          databaseSchema: arch.databaseSchema,
          fileStructure: arch.fileStructure,
        };
        if (arch.taskDecomposition != null) {
          architecture.taskDecomposition = {
            tasks: arch.taskDecomposition.tasks.map((t): ArchTask => {
              const task: ArchTask = {
                id: t.id,
                title: t.title,
                description: t.description,
                estimatedComplexity: t.estimatedComplexity,
                dependencies: t.dependencies,
                acceptanceCriteria: t.acceptanceCriteria,
              };
              if (t.domain != null) task.domain = t.domain;
              if (t.tags != null) task.tags = t.tags;
              return task;
            }),
          };
        }
        return {
          ...s,
          architecture,
          agents: registry.getAll(),
        };
      },
    });
  }

  let archText: string;
  let costUsd: number | undefined;
  let sessionId: string | undefined;
  // Fully-static instructions go in `options.systemPrompt` so the SDK's
  // ephemeral cache can hit across retries. Per-call prompt carries only the
  // project-specific spec and domain summary.
  const perCallPrompt = `${wrapUserInput("product-spec", JSON.stringify(state.spec, null, 2))}

Domain: ${state.spec.domain.classification}
Specializations: ${state.spec.domain.specializations.join(", ")}
Recommended tech: ${state.spec.domain.techStack.join(", ")}`;
  try {
    const queryResult = await consumeQuery(
      query({
        prompt: perCallPrompt,
        options: {
          systemPrompt: ARCH_PROMPT,
          tools: ["WebSearch", "WebFetch"],
          ...getQueryPermissions(config),
          maxTurns: getMaxTurns(config, "architecture"),
        },
      }),
      {
        label: "architecture",
        eventBus: ctx?.eventBus,
        phase: "architecture",
        agentName: "architect",
        model: config.model,
        ...(signal ? { signal } : {}),
      }
    );
    archText = queryResult.result;
    costUsd = queryResult.cost;
    sessionId = queryResult.sessionId;
  } catch (err) {
    if (err instanceof QueryAbortedError) {
      return { success: false, state, error: "aborted" };
    }
    return {
      success: false,
      state,
      error: `Failed to generate architecture: ${errMsg(err)}`,
    };
  }

  let archParseResult = parseArchitectureText(archText);
  if (!archParseResult.parsed) {
    console.warn(`[architecture] Primary parse failed, attempting repair: ${archParseResult.error}`);
    try {
      const repairResult = await repairArchitectureText(
        archText,
        archParseResult.error ?? "unknown parse error",
        config,
        ctx,
      );
      archText = repairResult.repairedText;
      if (repairResult.costUsd != null) {
        costUsd = (costUsd ?? 0) + repairResult.costUsd;
      }
      if (!sessionId && repairResult.sessionId) {
        sessionId = repairResult.sessionId;
      }
      archParseResult = parseArchitectureText(archText);
    } catch (err) {
      return {
        success: false,
        state,
        error: `Invalid architecture JSON: ${archParseResult.error}. Repair failed: ${errMsg(err)}`,
      };
    }
  }
  if (!archParseResult.parsed) {
    return { success: false, state, error: `Invalid architecture JSON: ${archParseResult.error}` };
  }
  const parsed = archParseResult.parsed;

  // Map Zod output to ArchDesign, stripping explicit undefined to satisfy exactOptionalPropertyTypes
  const architecture: ArchDesign = {
    techStack: parsed.techStack,
    components: parsed.components,
    apiContracts: parsed.apiContracts,
    databaseSchema: parsed.databaseSchema,
    fileStructure: parsed.fileStructure,
  };
  if (parsed.taskDecomposition != null) {
    const tasks: ArchTask[] = parsed.taskDecomposition.tasks.map((t) => {
      const task: ArchTask = {
        id: t.id,
        title: t.title,
        description: t.description,
        estimatedComplexity: t.estimatedComplexity,
        dependencies: t.dependencies,
        acceptanceCriteria: t.acceptanceCriteria,
      };
      if (t.domain != null) task.domain = t.domain;
      if (t.tags != null) task.tags = t.tags;
      return task;
    });
    architecture.taskDecomposition = { tasks };
  }

  console.log(`[architecture] Tech stack: ${Object.entries(architecture.techStack).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log(`[architecture] Components: ${architecture.components.length}`);
  console.log(`[architecture] Agents registered: ${registry.getAll().length}`);
  if (architecture.taskDecomposition) {
    const tasks = architecture.taskDecomposition.tasks;
    const byComplexity = tasks.reduce<Record<string, number>>((acc, t) => {
      acc[t.estimatedComplexity] = (acc[t.estimatedComplexity] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`[architecture] Tasks decomposed: ${tasks.length} (low=${byComplexity["low"] ?? 0}, medium=${byComplexity["medium"] ?? 0}, high=${byComplexity["high"] ?? 0})`);
  }

  const newState: ProjectState = {
    ...state,
    architecture,
    agents: registry.getAll(),
  };

  return {
    success: true,
    nextPhase: "environment-setup",
    state: newState,
    ...(costUsd != null ? { costUsd } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}
