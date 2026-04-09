import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState, ArchDesign, ArchTask } from "../state/project-state.js";
import type { PhaseResult } from "./types.js";
import { buildAgentTeam } from "../agents/factory.js";
import { consumeQuery, getQueryPermissions, getMaxTurns } from "../utils/sdk-helpers.js";
import { extractFirstJson, errMsg, wrapUserInput } from "../utils/shared.js";
import { ArchDesignSchema } from "../types/llm-schemas.js";

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

export async function runArchitecture(
  state: ProjectState,
  config: Config
): Promise<PhaseResult> {
  if (!state.spec) {
    return { success: false, state, error: "No spec found. Run ideation first." };
  }

  console.log("[architecture] Designing system architecture...");

  // Also initialize the agent team (domain analysis -> dynamic agents)
  const { registry } = await buildAgentTeam(state, config);

  let archText: string;
  let costUsd: number | undefined;
  try {
    const queryResult = await consumeQuery(
      query({
        prompt: `${ARCH_PROMPT}

${wrapUserInput("product-spec", JSON.stringify(state.spec, null, 2))}

Domain: ${state.spec.domain.classification}
Specializations: ${state.spec.domain.specializations.join(", ")}
Recommended tech: ${state.spec.domain.techStack.join(", ")}`,
        options: {
          tools: ["WebSearch", "WebFetch"],
          ...getQueryPermissions(config),
          maxTurns: getMaxTurns(config, "architecture"),
        },
      }),
      "architecture"
    );
    archText = queryResult.result;
    costUsd = queryResult.cost;
  } catch (err) {
    return {
      success: false,
      state,
      error: `Failed to generate architecture: ${errMsg(err)}`,
    };
  }

  const jsonStr = extractFirstJson(archText);
  if (!jsonStr) {
    return { success: false, state, error: "Failed to generate architecture: no valid JSON" };
  }

  const archParseResult = ArchDesignSchema.safeParse(JSON.parse(jsonStr));
  if (!archParseResult.success) {
    return { success: false, state, error: `Invalid architecture JSON: ${archParseResult.error.message}` };
  }
  const parsed = archParseResult.data;

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
  };
}
