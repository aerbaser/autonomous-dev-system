import type { Config } from "../utils/config.js";
import type { ProjectState, PhaseCheckpoint } from "../state/project-state.js";
import type { PhaseResult, PhaseExecutionContext } from "./types.js";
import { QueryAbortedError } from "../utils/sdk-helpers.js";
import { researchStack } from "../agents/stack-researcher.js";
import { installLspServers } from "../environment/lsp-manager.js";
import { configureMcpServers } from "../environment/mcp-manager.js";
import { installPlugins } from "../environment/plugin-manager.js";
import { scanOpenSource } from "../environment/oss-scanner.js";
import { generateClaudeMd } from "../environment/claude-md-generator.js";
import { saveCheckpoint as saveCheckpointState, saveState } from "../state/project-state.js";
import { MemoryStore } from "../state/memory-store.js";
import { LayeredMemory } from "../memory/layers.js";

interface SetupStepResult {
  name: string;
  success: boolean;
  error?: string;
  critical: boolean;
}

export async function runEnvironmentSetup(
  state: ProjectState,
  config: Config,
  ctx?: PhaseExecutionContext,
): Promise<PhaseResult> {
  if (!state.architecture || !state.spec) {
    return {
      success: false,
      state,
      error: "Architecture and spec required for environment setup",
    };
  }

  console.log("[env-setup] Researching optimal environment for this stack...");
  const signal = ctx?.signal;

  const stepResults: SetupStepResult[] = [];
  let updatedState = { ...state };

  // Step 1: Stack Research (critical — without it we can't proceed)
  // Build a LayeredMemory locally so the researcher can persist stable
  // detected facts into L2. Same construction pattern as development-runner's
  // SkillStore bootstrap — keeps phase concerns local and avoids plumbing
  // through PhaseExecutionContext.
  const layeredMemory =
    config.memory?.enabled && config.memory.layers?.enabled !== false
      ? new LayeredMemory(
          new MemoryStore(config.stateDir, {
            maxDocuments: config.memory.maxDocuments,
            maxDocumentSizeKb: config.memory.maxDocumentSizeKb,
          }),
          config.stateDir,
        )
      : undefined;

  let discovered: Awaited<ReturnType<typeof researchStack>>;
  try {
    discovered = await researchStack(state.architecture, state.spec.domain, config, signal, layeredMemory);
    stepResults.push({ name: "Stack Research", success: true, critical: true });
    console.log(
      `[env-setup] Discovered: ${discovered.lspServers.length} LSP, ` +
        `${discovered.mcpServers.length} MCP, ${discovered.plugins.length} plugins, ` +
        `${discovered.openSourceTools.length} OSS tools`
    );
  } catch (err) {
    if (err instanceof QueryAbortedError) {
      return { success: false, state: updatedState, error: "aborted" };
    }
    const message = err instanceof Error ? err.message : String(err);
    stepResults.push({ name: "Stack Research", success: false, error: message, critical: true });
    console.error(`[env-setup] Stack research failed: ${message}`);
    logSetupSummary(stepResults);
    return {
      success: false,
      state: updatedState,
      error: `Stack research failed: ${message}`,
    };
  }

  // Steps 2-5: Run in parallel (all non-critical, independent after stack research)
  console.log("[env-setup] Running LSP, MCP, plugins, and OSS scan in parallel...");

  const [lspResult, mcpResult, pluginsResult, ossResult] = await Promise.allSettled([
    installLspServers(discovered.lspServers),
    (async () => configureMcpServers(config.projectDir, discovered.mcpServers))(),
    installPlugins(discovered.plugins),
    scanOpenSource(state.architecture, state.spec.domain, config),
  ]);

  let lspServers = discovered.lspServers.map((l) => ({ ...l, installed: false }));
  if (lspResult.status === "fulfilled") {
    lspServers = lspResult.value;
    const count = lspServers.filter((l) => l.installed).length;
    console.log(`[env-setup] LSP: ${count}/${lspServers.length} installed`);
    stepResults.push({ name: "LSP Servers", success: true, critical: false });
  } else {
    console.warn(`[env-setup] LSP installation failed (non-critical): ${lspResult.reason}`);
    stepResults.push({ name: "LSP Servers", success: false, error: String(lspResult.reason), critical: false });
  }

  let mcpServers = discovered.mcpServers.map((m) => ({ ...m, installed: false }));
  if (mcpResult.status === "fulfilled") {
    mcpServers = mcpResult.value;
    const count = mcpServers.filter((m) => m.installed).length;
    console.log(`[env-setup] MCP: ${count}/${mcpServers.length} configured`);
    stepResults.push({ name: "MCP Servers", success: true, critical: false });
  } else {
    console.warn(`[env-setup] MCP configuration failed (non-critical): ${mcpResult.reason}`);
    stepResults.push({ name: "MCP Servers", success: false, error: String(mcpResult.reason), critical: false });
  }

  let plugins = discovered.plugins.map((p) => ({ ...p, installed: false }));
  if (pluginsResult.status === "fulfilled") {
    plugins = pluginsResult.value;
    const count = plugins.filter((p) => p.installed).length;
    console.log(`[env-setup] Plugins: ${count}/${plugins.length} installed`);
    stepResults.push({ name: "Plugins", success: true, critical: false });
  } else {
    console.warn(`[env-setup] Plugin installation failed (non-critical): ${pluginsResult.reason}`);
    stepResults.push({ name: "Plugins", success: false, error: String(pluginsResult.reason), critical: false });
  }

  let ossTools = discovered.openSourceTools.map((o) => ({ ...o, integrated: false }));
  if (ossResult.status === "fulfilled") {
    ossTools = ossResult.value;
    console.log(`[env-setup] Found ${ossTools.length} potentially useful OSS tools`);
    stepResults.push({ name: "OSS Scan", success: true, critical: false });
  } else {
    console.warn(`[env-setup] OSS scan failed (non-critical): ${ossResult.reason}`);
    stepResults.push({ name: "OSS Scan", success: false, error: String(ossResult.reason), critical: false });
  }

  // Step 6: Generate CLAUDE.md (non-critical)
  const environment = {
    lspServers,
    mcpServers,
    plugins,
    openSourceTools: ossTools,
    claudeMd: discovered.claudeMd,
  };

  try {
    generateClaudeMd(config.projectDir, state.architecture, state.spec.domain, environment);
    stepResults.push({ name: "CLAUDE.md Generation", success: true, critical: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[env-setup] CLAUDE.md generation failed (non-critical): ${message}`);
    stepResults.push({ name: "CLAUDE.md Generation", success: false, error: message, critical: false });
  }

  // Build final state
  updatedState = { ...updatedState, environment };

  // Save checkpoint with environment setup results
  const checkpoint: PhaseCheckpoint = {
    phase: "environment-setup",
    completedTasks: stepResults.filter((s) => s.success).map((s) => s.name),
    pendingTasks: stepResults.filter((s) => !s.success).map((s) => s.name),
    timestamp: new Date().toISOString(),
    metadata: {
      stepResults: stepResults.map((s) => ({
        name: s.name,
        success: s.success,
        error: s.error,
        critical: s.critical,
      })),
    },
  };
  updatedState = saveCheckpointState(updatedState, checkpoint);
  saveState(config.stateDir, updatedState);

  logSetupSummary(stepResults);

  // Determine overall success: critical steps must pass
  const criticalFailures = stepResults.filter((s) => s.critical && !s.success);
  const overallSuccess = criticalFailures.length === 0;

  return {
    success: overallSuccess,
    ...(overallSuccess ? { nextPhase: "development" as const } : {}),
    state: updatedState,
    ...(!overallSuccess ? { error: `Critical setup steps failed: ${criticalFailures.map((s) => s.name).join(", ")}` } : {}),
  };
}

function logSetupSummary(results: SetupStepResult[]): void {
  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log(`\n[env-setup] Summary: ${passed} passed, ${failed} failed`);
  for (const r of results) {
    const icon = r.success ? "OK" : "FAIL";
    const suffix = r.error ? ` — ${r.error}` : "";
    const critical = r.critical ? " (critical)" : "";
    console.log(`  [${icon}] ${r.name}${critical}${suffix}`);
  }
  console.log("");
}
