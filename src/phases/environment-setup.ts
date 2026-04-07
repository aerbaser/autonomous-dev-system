import type { Config } from "../utils/config.js";
import type { ProjectState } from "../state/project-state.js";
import type { PhaseResult } from "../orchestrator.js";
import { researchStack } from "../agents/stack-researcher.js";
import { installLspServers } from "../environment/lsp-manager.js";
import { configureMcpServers } from "../environment/mcp-manager.js";
import { installPlugins } from "../environment/plugin-manager.js";
import { scanOpenSource } from "../environment/oss-scanner.js";
import { generateClaudeMd } from "../environment/claude-md-generator.js";

export async function runEnvironmentSetup(
  state: ProjectState,
  config: Config
): Promise<PhaseResult> {
  if (!state.architecture || !state.spec) {
    return {
      success: false,
      state,
      error: "Architecture and spec required for environment setup",
    };
  }

  console.log("[env-setup] Researching optimal environment for this stack...");

  // Step 1: Stack Research — discover what tools to install
  const discovered = await researchStack(state.architecture, state.spec.domain);

  console.log(`[env-setup] Discovered: ${discovered.lspServers.length} LSP, ${discovered.mcpServers.length} MCP, ${discovered.plugins.length} plugins, ${discovered.openSourceTools.length} OSS tools`);

  // Step 2: Install LSP servers
  console.log("[env-setup] Installing LSP servers...");
  const lspServers = installLspServers(discovered.lspServers);
  const lspInstalled = lspServers.filter((l) => l.installed).length;
  console.log(`[env-setup] LSP: ${lspInstalled}/${lspServers.length} installed`);

  // Step 3: Configure MCP servers
  console.log("[env-setup] Configuring MCP servers...");
  const mcpServers = configureMcpServers(config.projectDir, discovered.mcpServers);
  const mcpConfigured = mcpServers.filter((m) => m.installed).length;
  console.log(`[env-setup] MCP: ${mcpConfigured}/${mcpServers.length} configured`);

  // Step 4: Install plugins
  console.log("[env-setup] Installing plugins...");
  const plugins = installPlugins(discovered.plugins);
  const pluginsInstalled = plugins.filter((p) => p.installed).length;
  console.log(`[env-setup] Plugins: ${pluginsInstalled}/${plugins.length} installed`);

  // Step 5: Scan open-source (parallel, non-blocking)
  console.log("[env-setup] Scanning open-source tools...");
  const ossTools = await scanOpenSource(state.architecture, state.spec.domain);
  console.log(`[env-setup] Found ${ossTools.length} potentially useful OSS tools`);

  // Step 6: Generate CLAUDE.md
  const environment = {
    lspServers,
    mcpServers,
    plugins,
    openSourceTools: ossTools,
    claudeMd: discovered.claudeMd,
  };

  generateClaudeMd(config.projectDir, state.architecture, state.spec.domain, environment);

  const newState: ProjectState = {
    ...state,
    environment,
  };

  console.log("[env-setup] Environment setup complete!");

  return {
    success: true,
    nextPhase: "development",
    state: newState,
  };
}
