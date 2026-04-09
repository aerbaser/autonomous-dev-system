import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LspConfig } from "../state/project-state.js";
import { validateLsp } from "./validator.js";

const execFileAsync = promisify(execFile);

function parseCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (const ch of command) {
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; } else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (/\s/.test(ch)) {
      if (current) { args.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

const ALLOWED_INSTALL_EXECUTABLES = new Set([
  'npm', 'npx', 'pip', 'pip3', 'brew', 'cargo', 'go',
]);

async function smokeTestLsp(server: string): Promise<boolean> {
  try {
    await execFileAsync("which", [server], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function installLspServers(servers: LspConfig[]): Promise<LspConfig[]> {
  const results: LspConfig[] = [];

  for (const lsp of servers) {
    const validation = validateLsp(lsp);
    if (!validation.valid) {
      console.log(`[lsp] Skipping ${lsp.server}: ${validation.reason}`);
      results.push(lsp);
      continue;
    }

    try {
      console.log(`[lsp] Installing ${lsp.server} for ${lsp.language}...`);
      const parts = parseCommand(lsp.installCommand);
      const executable = parts[0]!;
      if (!ALLOWED_INSTALL_EXECUTABLES.has(executable)) {
        console.log(`[lsp] Blocked: '${executable}' is not an allowed install executable`);
        results.push(lsp);
        continue;
      }
      await execFileAsync(executable, parts.slice(1), { timeout: 120_000 });

      if (await smokeTestLsp(lsp.server)) {
        console.log(`[lsp] Installed and verified: ${lsp.server}`);
        results.push({ ...lsp, installed: true });
      } else {
        console.log(`[lsp] Installed but smoke test failed: ${lsp.server}`);
        results.push(lsp);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[lsp] Failed to install ${lsp.server}: ${msg}`);
      results.push(lsp);
    }
  }

  return results;
}
