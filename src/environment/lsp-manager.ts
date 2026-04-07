import { execSync } from "node:child_process";
import type { LspConfig } from "../state/project-state.js";
import { validateLsp } from "./validator.js";

/**
 * Smoke test: verify the LSP server binary exists and is executable.
 * Returns true if the binary is found in PATH.
 */
export function smokeTestLsp(server: string, _language: string): boolean {
  try {
    execSync(`which ${server}`, { stdio: "pipe", timeout: 5000 });
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
      execSync(lsp.installCommand, { stdio: "pipe", timeout: 120_000 });

      // Verify the binary is actually available after install
      if (smokeTestLsp(lsp.server, lsp.language)) {
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
