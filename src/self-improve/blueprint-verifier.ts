/**
 * HIGH-05 — Blueprint verification gate.
 *
 * Runs synchronously between `mutation.apply()` and `registry.register()` in
 * `src/self-improve/optimizer-runner.ts`. Deterministic, pure-function checks:
 * schema validation (Zod), prompt length bounds, tool allow-list, non-empty
 * name/role. No network, no filesystem, no LLM — the entire point is that
 * verification is cheap enough to run on every mutation and cannot fail open
 * under load.
 *
 * Rejecting a blueprint here short-circuits the expensive benchmark run and
 * guarantees no unverified blueprint is ever written to
 * `.autonomous-dev/agents/{name}.v{N}.md` via `savePromptVersion`.
 */
import type { AgentBlueprint } from "../state/project-state.js";
import { AgentBlueprintSchema } from "../types/llm-schemas.js";

/**
 * Static allow-list of tools permitted in a verified blueprint. Any tool whose
 * name starts with `mcp__` is also accepted (MCP tools are dynamic and named
 * after the MCP server). Extend this list when the project adopts a new SDK
 * tool.
 */
const ALLOWED_TOOLS: ReadonlySet<string> = new Set<string>([
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Agent",
  "Task",
]);

const SYSTEM_PROMPT_MIN_CHARS = 51; // strictly greater than 50
const SYSTEM_PROMPT_MAX_CHARS = 20_000;

export type VerificationResult =
  | { ok: true; blueprint: AgentBlueprint }
  | { ok: false; reason: string };

function isAllowedTool(name: string): boolean {
  if (ALLOWED_TOOLS.has(name)) return true;
  if (name.startsWith("mcp__")) return true;
  return false;
}

export function verifyBlueprint(candidate: unknown): VerificationResult {
  // Step 1 — schema validity. Must come first: every downstream check assumes
  // the candidate has already conformed to AgentBlueprintSchema.
  const parsed = AgentBlueprintSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, reason: `schema_invalid: ${parsed.error.message}` };
  }
  const blueprint: AgentBlueprint = parsed.data;

  // Step 2 — prompt lower bound (strictly greater than 50 chars).
  if (blueprint.systemPrompt.length < SYSTEM_PROMPT_MIN_CHARS) {
    return {
      ok: false,
      reason: `system_prompt_too_short: length=${blueprint.systemPrompt.length} minimum=${SYSTEM_PROMPT_MIN_CHARS}`,
    };
  }

  // Step 3 — prompt upper bound (DoS guard — caps SDK token explosion).
  if (blueprint.systemPrompt.length > SYSTEM_PROMPT_MAX_CHARS) {
    return {
      ok: false,
      reason: `system_prompt_too_long: length=${blueprint.systemPrompt.length} maximum=${SYSTEM_PROMPT_MAX_CHARS}`,
    };
  }

  // Step 4 — tools non-empty. An agent with zero tools is not useful and is
  // a common LLM-mutation failure mode.
  if (blueprint.tools.length === 0) {
    return { ok: false, reason: "tools_empty" };
  }

  // Step 5 — every tool allowed. Mitigates elevation-of-privilege via
  // arbitrary-named tools (T-03-05-02).
  for (const tool of blueprint.tools) {
    if (!isAllowedTool(tool)) {
      return { ok: false, reason: `disallowed_tool: ${tool}` };
    }
  }

  // Step 6 — name and role non-empty after trim. Zod requires strings but
  // accepts whitespace-only strings, which would collide in the registry.
  if (blueprint.name.trim().length === 0) {
    return { ok: false, reason: "empty_name" };
  }
  if (blueprint.role.trim().length === 0) {
    return { ok: false, reason: "empty_role" };
  }

  return { ok: true, blueprint };
}

/** Exposed for tests that need to assert bounds without duplicating literals. */
export const _TEST_EXPORTS = {
  ALLOWED_TOOLS,
  SYSTEM_PROMPT_MIN_CHARS,
  SYSTEM_PROMPT_MAX_CHARS,
} as const;
