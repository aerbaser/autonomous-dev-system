import { execSync } from "node:child_process";
import type { LspConfig } from "../state/project-state.js";
import { validateLsp } from "./validator.js";

// Known LSP servers per language with their install commands
const LSP_SERVER_REGISTRY: Record<string, Array<{ server: string; installCommand: string }>> = {
  typescript: [
    { server: "vtsls", installCommand: "npm i -g @vtsls/language-server" },
    { server: "typescript-language-server", installCommand: "npm i -g typescript-language-server" },
  ],
  javascript: [
    { server: "vtsls", installCommand: "npm i -g @vtsls/language-server" },
    { server: "typescript-language-server", installCommand: "npm i -g typescript-language-server" },
  ],
  python: [
    { server: "pyright", installCommand: "npm i -g pyright" },
    { server: "pylsp", installCommand: "pip install python-lsp-server" },
    { server: "ruff-lsp", installCommand: "pip install ruff-lsp" },
  ],
  rust: [
    { server: "rust-analyzer", installCommand: "rustup component add rust-analyzer" },
  ],
  go: [
    { server: "gopls", installCommand: "go install golang.org/x/tools/gopls@latest" },
  ],
  css: [
    { server: "css-language-server", installCommand: "npm i -g vscode-langservers-extracted" },
  ],
  html: [
    { server: "html-language-server", installCommand: "npm i -g vscode-langservers-extracted" },
  ],
};

/**
 * Discover available LSP servers for the given languages.
 * Returns configs for all known servers matching the requested languages.
 */
export function discoverLspServers(languages: string[]): LspConfig[] {
  const results: LspConfig[] = [];

  for (const lang of languages) {
    const entries = LSP_SERVER_REGISTRY[lang.toLowerCase()];
    if (!entries) continue;

    for (const entry of entries) {
      results.push({
        language: lang.toLowerCase(),
        server: entry.server,
        installCommand: entry.installCommand,
        installed: false,
      });
    }
  }

  return results;
}

/**
 * Check if an LSP server is already installed for the given language.
 * Returns the first found installed server config, or null.
 */
export function checkExistingLsp(language: string): LspConfig | null {
  const entries = LSP_SERVER_REGISTRY[language.toLowerCase()];
  if (!entries) return null;

  for (const entry of entries) {
    if (smokeTestLsp(entry.server, language)) {
      return {
        language: language.toLowerCase(),
        server: entry.server,
        installCommand: entry.installCommand,
        installed: true,
      };
    }
  }

  return null;
}

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
