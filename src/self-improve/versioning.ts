import {
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import type { AgentBlueprint } from "../state/project-state.js";

/**
 * Get the directory path for an agent's prompt versions.
 */
function getAgentVersionDir(stateDir: string, name: string): string {
  return resolve(stateDir, "evolution", "agents", name);
}

/**
 * Save a versioned snapshot of an agent's prompt.
 * Stored in: {stateDir}/evolution/agents/{name}/v{version}.md
 */
export function savePromptVersion(
  stateDir: string,
  blueprint: AgentBlueprint
): void {
  const dir = getAgentVersionDir(stateDir, blueprint.name);
  mkdirSync(dir, { recursive: true });

  const filename = `v${blueprint.version}.md`;
  const filePath = join(dir, filename);

  const metadata = [
    `<!-- version: ${blueprint.version} -->`,
    `<!-- timestamp: ${new Date().toISOString()} -->`,
    `<!-- role: ${blueprint.role} -->`,
    `<!-- score: ${blueprint.score ?? "N/A"} -->`,
    "",
  ].join("\n");

  const content = metadata + blueprint.systemPrompt + "\n";
  writeFileSync(filePath, content);
}

