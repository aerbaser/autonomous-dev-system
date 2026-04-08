#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig } from "./utils/config.js";
import { loadState, createInitialState, saveState, ALL_PHASES, type Phase, type ProjectState } from "./state/project-state.js";
import { runOrchestrator, requestShutdown } from "./orchestrator.js";
import { runOptimizer } from "./self-improve/optimizer.js";

function isPhase(value: string): value is Phase {
  return (ALL_PHASES as readonly string[]).includes(value);
}

const program = new Command();

program
  .name("autonomous-dev")
  .description("Self-improving autonomous development system on Claude Agent SDK")
  .version("0.1.0");

program
  .command("run")
  .description("Start autonomous development from an idea")
  .requiredOption("--idea <text>", "Project idea description")
  .option("--config <path>", "Path to config file")
  .option("--resume <session-id>", "Resume from a previous session")
  .option("--budget <usd>", "Max budget in USD", parseFloat)
  .option("--dry-run", "Show what would happen without executing")
  .option("--quick", "Skip optional phases (env-setup, review, ab-testing)")
  .option("--confirm-spec", "Pause for user confirmation after spec generation")
  .action(async (opts: { idea: string; config?: string; resume?: string; budget?: number; dryRun?: boolean; quick?: boolean; confirmSpec?: boolean }) => {
    const config = loadConfig(opts.config);
    config.budgetUsd = opts.budget;
    config.dryRun = opts.dryRun ?? false;
    config.quickMode = opts.quick ?? false;
    config.confirmSpec = opts.confirmSpec ?? false;
    const stateDir = config.stateDir;

    const existingState = loadState(stateDir);

    let state: ProjectState;
    if (opts.resume) {
      // --resume flag: require existing state
      if (!existingState) {
        console.error("[error] No saved state to resume. Run without --resume to start fresh.");
        process.exit(1);
      }
      state = existingState;
      console.log(`[resume] Resuming project: ${state.id} (phase: ${state.currentPhase})`);
    } else if (existingState) {
      // No --resume but state exists: warn and exit
      console.error(
        `[error] Found existing state for project "${existingState.id}" (phase: ${existingState.currentPhase}). ` +
        `Use --resume to continue or delete ${stateDir}/ to start fresh.`
      );
      process.exit(1);
    } else {
      // Fresh start
      state = createInitialState(opts.idea);
      saveState(stateDir, state);
      console.log(`[init] Created project: ${state.id}`);
    }

    const onSigint = (): void => {
      requestShutdown();
      console.log("\n[shutdown] Ctrl+C received. Finishing current phase and saving state...");
    };
    process.on("SIGINT", onSigint);

    try {
      await runOrchestrator(state, config, opts.resume);
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  });

program
  .command("optimize")
  .description("Run self-improvement optimization loop")
  .option("--config <path>", "Path to config file")
  .option("--benchmark <id>", "Run specific benchmark only")
  .option("--max-iterations <n>", "Max optimization iterations", "10")
  .action(
    async (opts: {
      config?: string;
      benchmark?: string;
      maxIterations: string;
    }) => {
      const config = loadConfig(opts.config);
      const state = loadState(config.stateDir);
      if (!state) {
        console.error("[error] No project state found. Run 'autonomous-dev run' first.");
        process.exit(1);
      }

      await runOptimizer(state, config, {
        ...(opts.benchmark !== undefined ? { benchmarkId: opts.benchmark } : {}),
        maxIterations: parseInt(opts.maxIterations, 10),
      });
    }
  );

program
  .command("status")
  .description("Show current project status")
  .option("--config <path>", "Path to config file")
  .action((opts: { config?: string }) => {
    const config = loadConfig(opts.config);
    const state = loadState(config.stateDir);
    if (!state) {
      console.log("No project found.");
      return;
    }

    console.log(`Project: ${state.id}`);
    console.log(`Idea: ${state.idea}`);
    console.log(`Phase: ${state.currentPhase}`);
    console.log(`Agents: ${state.agents.length}`);
    console.log(`Tasks: ${state.tasks.length} (${state.tasks.filter((t) => t.status === "completed").length} completed)`);
    console.log(`Baseline Score: ${state.baselineScore}`);
    console.log(`Evolution entries: ${state.evolution.length}`);
    if (state.environment) {
      console.log(`Environment: ${state.environment.lspServers.length} LSP, ${state.environment.mcpServers.length} MCP, ${state.environment.plugins.length} plugins`);
    }
  });

program
  .command("phase")
  .description("Run a specific phase")
  .requiredOption("--name <phase>", "Phase name to run")
  .option("--config <path>", "Path to config file")
  .option("--stack <technologies>", "Comma-separated tech stack (for environment-setup)")
  .action(
    async (opts: { name: string; config?: string; stack?: string }) => {
      const config = loadConfig(opts.config);
      const state = loadState(config.stateDir);
      if (!state) {
        console.error("[error] No project state found.");
        process.exit(1);
      }

      if (!isPhase(opts.name)) {
        console.error(`[error] Unknown phase: ${opts.name}. Valid: ${ALL_PHASES.join(", ")}`);
        process.exit(1);
      }
      await runOrchestrator(state, config, undefined, opts.name);
    }
  );

program.parse();
