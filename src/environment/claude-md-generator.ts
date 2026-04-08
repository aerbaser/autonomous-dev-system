import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ArchDesign, DomainAnalysis, StackEnvironment } from "../state/project-state.js";

/**
 * Generate a project-specific CLAUDE.md with conventions, available tools,
 * and domain-specific instructions.
 */
export function generateClaudeMd(
  projectDir: string,
  architecture: ArchDesign,
  domain: DomainAnalysis,
  environment: StackEnvironment
): void {
  const sections: string[] = [];

  // Header
  sections.push("# Project Context");
  sections.push("");

  // Tech Stack
  sections.push("## Tech Stack");
  for (const [key, value] of Object.entries(architecture.techStack)) {
    sections.push(`- **${key}**: ${value}`);
  }
  sections.push("");

  // Domain
  if (domain.specializations.length > 0) {
    sections.push("## Domain");
    sections.push(`- Classification: ${domain.classification}`);
    sections.push(`- Specializations: ${domain.specializations.join(", ")}`);
    sections.push("");
  }

  // Available Tools
  const installedLsp = environment.lspServers.filter((l) => l.installed);
  const installedMcp = environment.mcpServers.filter((m) => m.installed);

  if (installedLsp.length > 0 || installedMcp.length > 0) {
    sections.push("## Available Tools");

    if (installedLsp.length > 0) {
      sections.push("### LSP (use for navigation)");
      for (const lsp of installedLsp) {
        sections.push(`- **${lsp.server}** (${lsp.language}): go-to-definition, find-references, hover for type info`);
      }
      sections.push("- Prefer LSP navigation over grep for finding definitions and references");
      sections.push("");
    }

    if (installedMcp.length > 0) {
      sections.push("### MCP Servers");
      for (const mcp of installedMcp) {
        sections.push(`- **${mcp.name}**: ${mcp.reason}`);
      }
      sections.push("");
    }
  }

  // Conventions from stack researcher
  if (environment.claudeMd) {
    sections.push("## Conventions");
    sections.push(environment.claudeMd);
    sections.push("");
  }

  // File Structure
  if (architecture.fileStructure) {
    sections.push("## File Structure");
    sections.push("```");
    sections.push(architecture.fileStructure);
    sections.push("```");
    sections.push("");
  }

  // Write CLAUDE.md
  const claudeMdPath = resolve(projectDir, "CLAUDE.md");
  writeFileSync(claudeMdPath, sections.join("\n"));
  console.log(`[claude-md] Generated: ${claudeMdPath}`);

  // Also write to .claude/ directory
  const dotClaudeDir = resolve(projectDir, ".claude");
  mkdirSync(dotClaudeDir, { recursive: true });
  const dotClaudeMdPath = resolve(dotClaudeDir, "CLAUDE.md");
  writeFileSync(dotClaudeMdPath, sections.join("\n"));
}
