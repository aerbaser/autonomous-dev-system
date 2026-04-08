import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState, ArchDesign } from "../state/project-state.js";
import type { PhaseResult } from "./types.js";
import { buildAgentTeam } from "../agents/factory.js";
import { consumeQuery, getQueryPermissions, getMaxTurns } from "../utils/sdk-helpers.js";
import { extractFirstJson, errMsg, wrapUserInput } from "../utils/shared.js";
import { ArchDesignSchema } from "../types/llm-schemas.js";

const ARCH_PROMPT = `You are a Software Architect. Given a product specification, design the complete
technical architecture.

Output a JSON object:
{
  "techStack": {
    "language": "TypeScript",
    "framework": "Next.js 15",
    "database": "PostgreSQL",
    "orm": "Prisma",
    ... (all technologies with their roles)
  },
  "components": [
    "Description of each major component/service"
  ],
  "apiContracts": "OpenAPI spec or GraphQL schema as a string",
  "databaseSchema": "SQL DDL or Prisma schema as a string",
  "fileStructure": "Project file/folder layout as a string"
}

Guidelines:
- Choose battle-tested technologies appropriate for the domain
- Keep it as simple as possible while meeting requirements
- Ensure the architecture supports all non-functional requirements
- The file structure must be specific enough for developers to follow

Output ONLY the JSON.`;

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
  const architecture = archParseResult.data;

  console.log(`[architecture] Tech stack: ${Object.entries(architecture.techStack).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log(`[architecture] Components: ${architecture.components.length}`);
  console.log(`[architecture] Agents registered: ${registry.getAll().length}`);

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
