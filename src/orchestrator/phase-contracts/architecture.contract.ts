import type { ProjectState } from "../../state/project-state.js";
import type { PhaseContract, PhaseContext } from "../phase-contract.js";
import { ArchDesignSchema } from "../../types/llm-schemas.js";
import type { z } from "zod";

type ArchDesignParsed = z.infer<typeof ArchDesignSchema>;

/**
 * Slice ProjectState for the architecture lead. The spec + domain
 * classification + NFR list is everything the lead needs; other phases'
 * state (completedPhases, deployments, abTests) is noise.
 */
function architectureContextSelector(state: ProjectState): PhaseContext {
  const summary: string[] = [];
  const slices: Record<string, unknown> = {};

  if (state.spec) {
    summary.push(`Idea: ${state.idea}`);
    summary.push(`Domain: ${state.spec.domain.classification}`);
    if (state.spec.domain.specializations.length > 0) {
      summary.push(`Specializations: ${state.spec.domain.specializations.join(", ")}`);
    }
    summary.push(`User stories: ${state.spec.userStories.length}`);
    summary.push(`NFRs: ${state.spec.nonFunctionalRequirements.length}`);

    slices["spec"] = {
      summary: state.spec.summary,
      userStories: state.spec.userStories,
      nonFunctionalRequirements: state.spec.nonFunctionalRequirements,
      domain: state.spec.domain,
    };
  } else {
    summary.push("WARNING: no spec available — architecture cannot proceed without one.");
  }

  return { summary, slices };
}

/**
 * v1.1 super-lead contract for the architecture phase.
 *
 * Lead composes techStack + components + API contracts + DB schema +
 * file structure + task DAG, optionally delegating to security-reviewer
 * and scalability-reviewer for second opinions before finalizing.
 *
 * `ArchDesignSchema.partial({...})` is NOT used here — the lead MUST
 * deliver the full shape. Partial output is a schema violation and
 * will be rejected by parseLeadEnvelope.
 */
export const architectureContract: PhaseContract<ArchDesignParsed> = {
  phase: "architecture",
  goals: [
    "Design the complete technical architecture for the spec'd product.",
    "",
    "Responsibilities:",
    "- Pick a concrete tech stack with versions you can defend.",
    "- List every component with its purpose and upstream dependencies.",
    "- Spell out API contracts (OpenAPI-style summary), DB schema (Prisma/DDL summary), and file structure (tree).",
    "- Decompose work into developer-ready tasks forming a valid DAG — each task's deps only reference earlier task IDs.",
    "",
    "Before emitting your final envelope, invoke the security-reviewer and scalability-reviewer specialists to stress-test the design. Integrate their findings or defend your choice — do not silently ignore them.",
  ].join("\n"),
  deliverables: [
    "techStack: object with language, framework, database, ORM, testing, infra (at minimum)",
    "components: non-empty array of {name, description, dependencies[]}",
    "apiContracts: readable string (OpenAPI/GraphQL summary covering every endpoint implied by user stories)",
    "databaseSchema: readable string (Prisma schema or SQL DDL)",
    "fileStructure: readable string (project tree)",
    "taskDecomposition.tasks: DAG-valid array of tasks, each with id, title, description, estimatedComplexity, dependencies, acceptanceCriteria",
  ],
  // Architecture's legal transitions: environment-setup (full flow) or
  // development directly (quick mode). Only two; no backloop.
  allowedNextPhases: ["environment-setup", "development"],
  outputSchema: ArchDesignSchema,
  outputShapeHint: `{
  "techStack": {
    "language": "TypeScript 5.x",
    "framework": "Next.js 15",
    "database": "PostgreSQL 16",
    "orm": "Prisma 5",
    "testing": "Vitest + Playwright",
    "infra": "Docker + Railway"
  },
  "components": [
    { "name": "Frontend", "description": "Next.js App Router ...", "dependencies": [] },
    { "name": "API Layer", "description": "Route Handlers ...", "dependencies": ["Frontend"] }
  ],
  "apiContracts": "OpenAPI 3.1 summary — MUST be a single readable STRING, not an object.",
  "databaseSchema": "Prisma schema or SQL DDL as a readable STRING, not an object.",
  "fileStructure": "Project tree as a readable STRING, not an object.",
  "taskDecomposition": {
    "tasks": [
      {
        "id": "T-001",
        "title": "Short imperative title",
        "description": "Implementation details, specific file paths",
        "estimatedComplexity": "low | medium | high",
        "dependencies": [],
        "acceptanceCriteria": ["GIVEN ... WHEN ... THEN ...", "..."]
      }
    ]
  }
}`,
  specialistNames: ["security-reviewer", "scalability-reviewer"],
  contextSelector: architectureContextSelector,
  // Architecture rarely backloops; no guards needed.
  maxBackloopsFromHere: {},
};
