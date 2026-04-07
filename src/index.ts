#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig } from "./utils/config.js";
import { loadState, createInitialState, saveState, type Phase } from "./state/project-state.js";
import { runOrchestrator } from "./orchestrator.js";
import { runOptimizer } from "./self-improve/optimizer.js";

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
  .action(async (opts: { idea: string; config?: string; resume?: string }) => {
    const config = loadConfig(opts.config);
    const stateDir = config.stateDir;

    let state = loadState(stateDir);
    if (!state) {
      state = createInitialState(opts.idea);
      saveState(stateDir, state);
      console.log(`[init] Created project: ${state.id}`);
    } else {
      console.log(`[resume] Resuming project: ${state.id} (phase: ${state.currentPhase})`);
    }

    await runOrchestrator(state, config, opts.resume);
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
        benchmarkId: opts.benchmark,
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

      await runOrchestrator(state, config, undefined, opts.name as Phase);
    }
  );

program.parse();
