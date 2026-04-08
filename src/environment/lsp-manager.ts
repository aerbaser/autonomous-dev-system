import { execFileSync } from "node:child_process";
import type { LspConfig } from "../state/project-state.js";
import { validateLsp } from "./validator.js";

function smokeTestLsp(server: string): boolean {
  try {
    execFileSync("which", [server], { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function installLspServers(servers: LspConfig[]): LspConfig[] {
  return servers.map((lsp) => {
    const validation = validateLsp(lsp);
    if (!validation.valid) {
      console.log(`[lsp] Skipping ${lsp.server}: ${validation.reason}`);
      return lsp;
    }

    try {
      console.log(`[lsp] Installing ${lsp.server} for ${lsp.language}...`);
      const parts = lsp.installCommand.split(/\s+/);
      execFileSync(parts[0]!, parts.slice(1), { stdio: "pipe", timeout: 120_000 });

      // Verify the binary is actually available after install
      if (smokeTestLsp(lsp.server)) {
        console.log(`[lsp] Installed and verified: ${lsp.server}`);
        return { ...lsp, installed: true };
      } else {
        console.log(`[lsp] Installed but smoke test failed: ${lsp.server}`);
        return lsp;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[lsp] Failed to install ${lsp.server}: ${msg}`);
      return lsp;
    }
  });
}
