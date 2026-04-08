import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LspConfig } from "../state/project-state.js";
import { validateLsp } from "./validator.js";

const execFileAsync = promisify(execFile);

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
      const parts = lsp.installCommand.split(/\s+/);
      await execFileAsync(parts[0]!, parts.slice(1), { timeout: 120_000 });

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
