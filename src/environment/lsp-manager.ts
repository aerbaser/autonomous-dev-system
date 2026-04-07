import { execSync } from "node:child_process";
import type { LspConfig } from "../state/project-state.js";
import { validateLsp } from "./validator.js";

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
      console.log(`[lsp] Installed: ${lsp.server}`);
      return { ...lsp, installed: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[lsp] Failed to install ${lsp.server}: ${msg}`);
      return lsp;
    }
  });
}
