import type { Config } from "../utils/config.js";
import type { ProjectState, AgentBlueprint } from "../state/project-state.js";
import { AgentRegistry } from "./registry.js";
import { analyzeDomain, generateDomainAgents } from "./domain-analyzer.js";
import { getBaseAgentNames } from "./base-blueprints.js";

/**
 * Agent Factory: analyzes the project domain and dynamically creates
 * specialized agent blueprints alongside the standard ones.
 */
export async function buildAgentTeam(
  state: ProjectState,
  config: Config,
  signal?: AbortSignal,
): Promise<{ registry: AgentRegistry; domain: ProjectState["spec"] }> {
  const registry = new AgentRegistry(config.stateDir);

  // If we already have domain-specific agents, just return the registry
  const baseNames = getBaseAgentNames();
  const existingDomainAgents = registry
    .getAll()
    .filter((a) => !baseNames.has(a.name));

  if (existingDomainAgents.length > 0) {
    console.log(
      `[factory] Using ${existingDomainAgents.length} existing domain agents: ${existingDomainAgents.map((a) => a.name).join(", ")}`
    );
    return { registry, domain: state.spec };
  }

  // Step 1: Reuse domain from spec if available, otherwise analyze
  const domain = state.spec?.domain ?? await analyzeDomain(state.idea, config, signal);
  console.log(`[factory] Domain: ${domain.classification}`);
  console.log(`[factory] Specializations: ${domain.specializations.join(", ") || "none"}`);
  console.log(`[factory] Required roles: ${domain.requiredRoles.join(", ") || "none (standard only)"}`);

  // Step 2: Generate domain-specific agents
  if (domain.requiredRoles.length > 0) {
    console.log("[factory] Generating specialized agent blueprints...");
    const domainAgents = await generateDomainAgents(state.idea, domain, config, signal);

    for (const agent of domainAgents) {
      registry.register(agent);
      console.log(`[factory] Registered: ${agent.name} (${agent.role})`);
    }
  }

  // Step 3: Persist
  registry.save();

  return { registry, domain: state.spec };
}

/**
 * Get all agent definitions for the Agent SDK, suitable for passing to query() options.
 */
export function getAgentDefinitions(
  registry: AgentRegistry
): Record<string, { description: string; prompt: string; tools: string[] }> {
  const defs: Record<string, { description: string; prompt: string; tools: string[] }> = {};

  for (const bp of registry.getAll()) {
    defs[bp.name] = registry.toAgentDefinition(bp.name);
  }

  return defs;
}
