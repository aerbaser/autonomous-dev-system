/**
 * Phase: specification (#2 in the 12-phase lifecycle).
 *
 * Takes the coarse `state.spec` produced by ideation and expands it into
 * implementation-ready detail:
 *   - refined user stories with Given/When/Then acceptance criteria
 *   - non-functional requirements with concrete thresholds (no "fast" / "secure")
 *   - explicit out-of-scope list
 *   - integration boundaries with protocol + ownership + failure semantics
 *
 * The result is validated against `DetailedSpecSchema` (Zod) and written back
 * onto `state.spec.detailed`. Next phase: `architecture`.
 *
 * **HIGH-04 (REQUIREMENTS.md v1 milestone):** this file is a REAL handler, not
 * a stub. Imports are kept deliberately minimal and one-directional:
 *   - `../state/project-state.js` — types only
 *   - `../types/llm-schemas.js` — Zod schema + inferred type
 *   - `../utils/sdk-helpers.js` / `../utils/shared.js` — infrastructure helpers
 *   - `./types.js` — phase return shape
 * No import ever closes a cycle back into this file. `tests/phases/specification.test.ts`
 * locks that invariant in with unit coverage of the success, missing-input,
 * bad-JSON, and schema-violation paths.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState, ProductSpec } from "../state/project-state.js";
import type { PhaseResult, PhaseExecutionContext } from "./types.js";
import { consumeQuery, getQueryPermissions, getMaxTurns } from "../utils/sdk-helpers.js";
import { extractFirstJson, errMsg, wrapUserInput } from "../utils/shared.js";
import { DetailedSpecSchema, type DetailedSpec } from "../types/llm-schemas.js";

const SPEC_SYSTEM_PROMPT = `You are a Senior Product Manager turning a coarse product spec into an
implementation-ready specification.

For every input spec you receive, produce a single JSON object with this exact shape:

{
  "refinedUserStories": [
    {
      "id": "US-001",
      "title": "Short imperative title (copied from input)",
      "acceptanceCriteria": [
        "Given <precondition>, When <action>, Then <observable outcome>",
        "Given <precondition>, When <action>, Then <observable outcome>",
        "..."
      ]
    }
  ],
  "refinedNonFunctionalRequirements": [
    {
      "category": "performance | security | scalability | observability | availability | accessibility | compliance",
      "requirement": "One-line plain-English description",
      "threshold": "Concrete measurable bound, e.g. 'p95 < 200ms at 1k RPS' or 'OWASP Top 10 mitigated, SAST scan clean'"
    }
  ],
  "outOfScope": [
    "Explicitly excluded items that someone might mistakenly assume are in-scope"
  ],
  "integrationBoundaries": [
    {
      "name": "External system / subsystem name",
      "description": "Protocol, data contract, ownership, failure semantics"
    }
  ]
}

Rules:
- Every user story MUST have AT LEAST 3 Given/When/Then acceptance criteria.
- Every NFR MUST carry a concrete threshold — no vague words like "fast", "secure", "scalable".
- Out-of-scope MUST list at least 2 items.
- Integration boundaries MUST list every external dependency or adjacent system.
- Output the JSON object only. No prose before or after.`;

export async function runSpecification(
  state: ProjectState,
  config: Config,
  _ctx?: PhaseExecutionContext,
): Promise<PhaseResult> {
  if (!state.spec) {
    return {
      success: false,
      state,
      error: "No spec found. Run ideation first.",
    };
  }

  console.log("[specification] Expanding product spec into implementation-ready detail...");

  const storiesText = state.spec.userStories
    .map(
      (us) =>
        `- ${us.id} [${us.priority}] ${us.title}\n  ${us.description}\n  Existing AC:\n${us.acceptanceCriteria
          .map((ac) => `    * ${ac}`)
          .join("\n")}`,
    )
    .join("\n\n");

  const nfrText = state.spec.nonFunctionalRequirements.map((n) => `- ${n}`).join("\n");
  const mvpText = state.spec.mvpScope
    ? `Included:\n${state.spec.mvpScope.included.map((x) => `  - ${x}`).join("\n")}\n` +
      `Excluded:\n${state.spec.mvpScope.excluded.map((x) => `  - ${x}`).join("\n")}`
    : "(none)";

  const perCallPrompt = `${wrapUserInput("summary", state.spec.summary)}

${wrapUserInput("domain", state.spec.domain.classification)}

${wrapUserInput("user-stories", storiesText)}

${wrapUserInput("non-functional-requirements", nfrText)}

${wrapUserInput("mvp-scope", mvpText)}`;

  let specText: string;
  let costUsd: number | undefined;
  try {
    const queryResult = await consumeQuery(
      query({
        prompt: perCallPrompt,
        options: {
          // The large, fully-static instructions go into `systemPrompt` so the
          // SDK's ephemeral cache can hit across rubric retries. The per-call
          // prompt carries only the project-specific spec.
          systemPrompt: SPEC_SYSTEM_PROMPT,
          ...getQueryPermissions(config),
          maxTurns: getMaxTurns(config, "specification"),
        },
      }),
      "specification",
    );
    specText = queryResult.result;
    costUsd = queryResult.cost;
  } catch (err) {
    return {
      success: false,
      state,
      error: `Failed to expand spec: ${errMsg(err)}`,
    };
  }

  const jsonStr = extractFirstJson(specText);
  if (!jsonStr) {
    return {
      success: false,
      state,
      error: "specification: no valid JSON in LLM output",
    };
  }

  const parsed = DetailedSpecSchema.safeParse(JSON.parse(jsonStr));
  if (!parsed.success) {
    return {
      success: false,
      state,
      error: `specification: invalid DetailedSpec JSON — ${parsed.error.message}`,
    };
  }
  const detailed: DetailedSpec = parsed.data;

  console.log(
    `[specification] Expanded: ${detailed.refinedUserStories.length} stories, ` +
      `${detailed.refinedNonFunctionalRequirements.length} NFRs, ` +
      `${detailed.outOfScope.length} out-of-scope items, ` +
      `${detailed.integrationBoundaries.length} integration boundaries`,
  );

  const updatedSpec: ProductSpec = {
    ...state.spec,
    detailed,
  };

  const newState: ProjectState = {
    ...state,
    spec: updatedSpec,
  };

  return {
    success: true,
    nextPhase: "architecture",
    state: newState,
    ...(costUsd != null ? { costUsd } : {}),
  };
}
