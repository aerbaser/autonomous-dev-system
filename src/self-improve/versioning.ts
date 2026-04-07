import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
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
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

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

/**
 * Load a specific version of an agent's prompt.
 * Strips the metadata header before returning the prompt text.
 */
export function loadPromptVersion(
  stateDir: string,
  name: string,
  version: number
): string | null {
  const filePath = join(getAgentVersionDir(stateDir, name), `v${version}.md`);
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, "utf-8");

  // Strip metadata lines (lines starting with <!--)
  const lines = raw.split("\n");
  const promptLines: string[] = [];
  let headerDone = false;
  for (const line of lines) {
    if (!headerDone) {
      if (line.startsWith("<!--") || line.trim() === "") {
        continue;
      }
      headerDone = true;
    }
    promptLines.push(line);
  }

  return promptLines.join("\n").trimEnd() || null;
}

/**
 * List all versions of an agent's prompt, sorted by version number.
 */
export function listPromptVersions(
  stateDir: string,
  name: string
): Array<{ version: number; timestamp: string; size: number }> {
  const dir = getAgentVersionDir(stateDir, name);
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir)
    .filter((f) => /^v\d+\.md$/.test(f))
    .map((f) => {
      const filePath = join(dir, f);
      const stat = statSync(filePath);
      const versionMatch = f.match(/^v(\d+)\.md$/);
      const version = versionMatch ? parseInt(versionMatch[1], 10) : 0;

      // Try to extract timestamp from metadata
      let timestamp = stat.mtime.toISOString();
      try {
        const content = readFileSync(filePath, "utf-8");
        const tsMatch = content.match(/<!-- timestamp: (.+?) -->/);
        if (tsMatch) timestamp = tsMatch[1];
      } catch {
        // Use file mtime as fallback
      }

      return { version, timestamp, size: stat.size };
    })
    .sort((a, b) => a.version - b.version);

  return entries;
}

/**
 * Diff two versions of an agent's prompt (simple line diff).
 * Returns a human-readable diff showing added/removed lines.
 */
export function diffPromptVersions(
  stateDir: string,
  name: string,
  v1: number,
  v2: number
): string {
  const prompt1 = loadPromptVersion(stateDir, name, v1);
  const prompt2 = loadPromptVersion(stateDir, name, v2);

  if (prompt1 === null) return `Version ${v1} not found for agent "${name}"`;
  if (prompt2 === null) return `Version ${v2} not found for agent "${name}"`;

  const lines1 = prompt1.split("\n");
  const lines2 = prompt2.split("\n");

  const output: string[] = [];
  output.push(`--- ${name} v${v1}`);
  output.push(`+++ ${name} v${v2}`);
  output.push("");

  // Simple LCS-based diff
  const lcs = computeLcs(lines1, lines2);
  let i = 0;
  let j = 0;
  let k = 0;

  while (i < lines1.length || j < lines2.length) {
    if (k < lcs.length && i < lines1.length && lines1[i] === lcs[k]) {
      if (j < lines2.length && lines2[j] === lcs[k]) {
        // Common line
        output.push(`  ${lines1[i]}`);
        i++;
        j++;
        k++;
      } else {
        // Added in v2
        output.push(`+ ${lines2[j]}`);
        j++;
      }
    } else if (i < lines1.length && (k >= lcs.length || lines1[i] !== lcs[k])) {
      // Removed from v1
      output.push(`- ${lines1[i]}`);
      i++;
    } else if (j < lines2.length) {
      // Added in v2
      output.push(`+ ${lines2[j]}`);
      j++;
    }
  }

  return output.join("\n");
}

/**
 * Compute the longest common subsequence of two string arrays.
 */
function computeLcs(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0) as number[]
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find the LCS
  const result: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}
