import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState, ArchDesign } from "../state/project-state.js";
import type { PhaseResult } from "../orchestrator.js";
import { buildAgentTeam } from "../agents/factory.js";
import { consumeQuery } from "../utils/sdk-helpers.js";

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
  try {
    const { result } = await consumeQuery(
      query({
        prompt: `${ARCH_PROMPT}

Product Specification:
${JSON.stringify(state.spec, null, 2)}

Domain: ${state.spec.domain.classification}
Specializations: ${state.spec.domain.specializations.join(", ")}
Recommended tech: ${state.spec.domain.techStack.join(", ")}`,
        options: {
          tools: ["WebSearch", "WebFetch"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 10,
        },
      }),
      "architecture"
    );
    archText = result;
  } catch (err) {
    return {
      success: false,
      state,
      error: `Failed to generate architecture: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const jsonStr = extractFirstJson(archText);
  if (!jsonStr) {
    return { success: false, state, error: "Failed to generate architecture: no valid JSON" };
  }

  let architecture: ArchDesign;
  try {
    architecture = JSON.parse(jsonStr);
  } catch (e) {
    return { success: false, state, error: `Failed to parse architecture JSON: ${e}` };
  }

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
  };
}
