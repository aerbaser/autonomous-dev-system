import type { ProductSpec, ArchDesign, StackEnvironment } from "../state/project-state.js";

/**
 * Build a context string from project state for agent prompts.
 */
export function buildProjectContext(opts: {
  idea: string;
  spec?: ProductSpec | null;
  architecture?: ArchDesign | null;
  environment?: StackEnvironment | null;
}): string {
  const sections: string[] = [];

  sections.push(`Project Idea: ${opts.idea}`);

  if (opts.spec) {
    sections.push(`\nDomain: ${opts.spec.domain.classification}`);
    sections.push(`Specializations: ${opts.spec.domain.specializations.join(", ") || "none"}`);
    sections.push(`User Stories: ${opts.spec.userStories.length}`);
    sections.push(`Must-have stories: ${opts.spec.userStories.filter((s) => s.priority === "must").map((s) => s.title).join(", ")}`);
  }

  if (opts.architecture) {
    sections.push(`\nTech Stack: ${Object.entries(opts.architecture.techStack).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    sections.push(`Components: ${opts.architecture.components.join(", ")}`);
  }

  if (opts.environment) {
    const lsp = opts.environment.lspServers.filter((l) => l.installed);
    const mcp = opts.environment.mcpServers.filter((m) => m.installed);
    if (lsp.length > 0) {
      sections.push(`\nLSP servers: ${lsp.map((l) => `${l.server} (${l.language})`).join(", ")}`);
    }
    if (mcp.length > 0) {
      sections.push(`MCP tools: ${mcp.map((m) => m.name).join(", ")}`);
    }
  }

  return sections.join("\n");
}
