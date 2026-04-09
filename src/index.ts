#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig } from "./utils/config.js";
import {
  loadState, createInitialState, saveState,
  ALL_PHASES, type Phase, type ProjectState,
} from "./state/project-state.js";
import { runOrchestrator, getInterrupter } from "./orchestrator.js";
import { runOptimizer } from "./self-improve/optimizer.js";
import { display, phaseLabel } from "./utils/progress.js";
import { generateDashboard, openInBrowser } from "./dashboard/generate.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Disable colors when NO_COLOR is set or output is not a TTY.
const USE_COLOR =
  process.env["NO_COLOR"] === undefined && process.stdout.isTTY !== false;

const C = USE_COLOR
  ? {
      reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
      red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
      cyan: "\x1b[36m", gray: "\x1b[90m",
    }
  : {
      reset: "", bold: "", dim: "", red: "", green: "", yellow: "", cyan: "", gray: "",
    };

const OPTIONAL_PHASES: Phase[] = ["review", "ab-testing", "monitoring"];

function isPhase(value: string): value is Phase {
  return (ALL_PHASES as readonly string[]).includes(value);
}

function truncate(text: string, max = 60): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function printBanner(idea: string, projectId: string, startPhase: string): void {
  const W  = 46;
  const hr = "═".repeat(W);
  console.log(`\n${C.bold}${C.cyan}╔${hr}╗`);
  console.log(`║  Autonomous Dev System  v0.1.0               ║`);
  console.log(`╚${hr}╝${C.reset}`);
  console.log(`  ${C.dim}Project :${C.reset} ${projectId}`);
  console.log(`  ${C.dim}Idea    :${C.reset} ${truncate(idea)}`);
  console.log(`  ${C.dim}Phase   :${C.reset} ${phaseLabel(startPhase)}`);
  console.log();
}

function printDryRunPlan(quickMode: boolean): void {
  const planned = quickMode
    ? ALL_PHASES.filter((p) => !OPTIONAL_PHASES.includes(p))
    : ALL_PHASES;
  const W = 40;
  console.log(`\n${C.yellow}┌─ DRY RUN — no code will be executed ─────┐`);
  console.log(`│  Planned phases (${String(planned.length).padEnd(2)} / ${ALL_PHASES.length} total):${" ".repeat(Math.max(0, W - 28))}│`);
  for (const [i, p] of planned.entries()) {
    const label = `${i + 1}. ${phaseLabel(p)}`;
    const optional = OPTIONAL_PHASES.includes(p) ? ` ${C.dim}(optional)${C.yellow}` : "";
    console.log(`│    ${label}${optional}`);
  }
  console.log(`└${"─".repeat(W + 2)}┘${C.reset}`);
  console.log();
}

// ─── CLI definition ───────────────────────────────────────────────────────────

const program = new Command();

program
  .name("autonomous-dev")
  .description("Self-improving autonomous development system on Claude Agent SDK")
  .version("0.1.0")
  .addHelpText("after", `
Examples:
  autonomous-dev run --idea "Build a REST API for a todo app"
  autonomous-dev run --idea "..." --budget 5 --quick
  autonomous-dev run --resume my-session-id
  autonomous-dev status
  autonomous-dev phase --name testing`);

program
  .command("run")
  .description("Start autonomous development from an idea")
  .requiredOption("--idea <text>", "Project idea description")
  .option("--config <path>", "Path to config file")
  .option("--resume <session-id>", "Resume from a previous session")
  .option("--budget <usd>", "Max budget in USD", parseFloat)
  .option("--dry-run", "Show what would happen without executing")
  .option("--quick", "Skip optional phases (env-setup, review, ab-testing, monitoring)")
  .option("--confirm-spec", "Pause for user confirmation after spec generation")
  .option("--verbose", "Show detailed progress output")
  .action(async (opts: {
    idea: string;
    config?: string;
    resume?: string;
    budget?: number;
    dryRun?: boolean;
    quick?: boolean;
    confirmSpec?: boolean;
    verbose?: boolean;
  }) => {
    const config = loadConfig(opts.config);
    config.budgetUsd  = opts.budget;
    config.dryRun     = opts.dryRun ?? false;
    config.quickMode  = opts.quick ?? false;
    config.confirmSpec = opts.confirmSpec ?? false;
    const stateDir = config.stateDir;

    const existingState = loadState(stateDir);

    let state: ProjectState;
    if (opts.resume) {
      if (!existingState) {
        console.error(
          `\n${C.red}[ERROR]${C.reset} No saved state found. Run without --resume to start fresh.`
        );
        process.exit(1);
      }
      state = existingState;
      console.log(
        `${C.cyan}[resume]${C.reset} Resuming project ${C.bold}${state.id}${C.reset}` +
        ` — phase: ${phaseLabel(state.currentPhase)}`
      );
    } else if (existingState) {
      console.error(
        `\n${C.red}[ERROR]${C.reset} Found existing project "${existingState.id}"` +
        ` (phase: ${phaseLabel(existingState.currentPhase)}).\n` +
        `  Use ${C.bold}--resume${C.reset} to continue, or delete ${stateDir}/ to start fresh.`
      );
      process.exit(1);
    } else {
      state = createInitialState(opts.idea);
      saveState(stateDir, state);
    }

    printBanner(opts.idea, state.id, state.currentPhase);

    if (config.dryRun) {
      printDryRunPlan(config.quickMode);
    }

    display.enable(opts.verbose ?? false);

    const onSigint = (): void => {
      getInterrupter().requestShutdown();
      console.log(
        `\n${C.yellow}[shutdown]${C.reset} Ctrl+C received — finishing current phase and saving state...`
      );
    };
    process.on("SIGINT", onSigint);

    try {
      await runOrchestrator(state, config, opts.resume);
    } finally {
      process.removeListener("SIGINT", onSigint);
    }

    // Reload final state from disk (orchestrator writes it)
    const finalState = loadState(stateDir) ?? state;
    display.printSummary(finalState.currentPhase);
  });

program
  .command("optimize")
  .description("Run self-improvement optimization loop")
  .option("--config <path>", "Path to config file")
  .option("--benchmark <id>", "Run specific benchmark only")
  .option("--max-iterations <n>", "Max optimization iterations", "10")
  .action(async (opts: { config?: string; benchmark?: string; maxIterations: string }) => {
    const config = loadConfig(opts.config);
    const state  = loadState(config.stateDir);
    if (!state) {
      console.error(
        `\n${C.red}[ERROR]${C.reset} No project state found.` +
        ` Run ${C.bold}autonomous-dev run${C.reset} first.`
      );
      process.exit(1);
    }

    await runOptimizer(state, config, {
      ...(opts.benchmark !== undefined ? { benchmarkId: opts.benchmark } : {}),
      maxIterations: parseInt(opts.maxIterations, 10),
    });
  });

program
  .command("status")
  .description("Show current project status")
  .option("--config <path>", "Path to config file")
  .action((opts: { config?: string }) => {
    const config = loadConfig(opts.config);
    const state  = loadState(config.stateDir);
    if (!state) {
      console.log(
        `${C.dim}No project found in ${config.stateDir}/.${C.reset}\n` +
        `  Start one with: ${C.bold}autonomous-dev run --idea "..."${C.reset}`
      );
      return;
    }

    const completedTasks = state.tasks.filter((t) => t.status === "completed").length;
    const W  = 44;
    const hr = "─".repeat(W);
    const row = (label: string, value: string): void => {
      const pad = 12;
      console.log(`${C.cyan}│${C.reset}  ${C.dim}${label.padEnd(pad)}${C.reset}${value}`);
    };

    console.log(`\n${C.bold}${C.cyan}┌─ Project Status ${"─".repeat(W - 16)}┐${C.reset}`);
    row("ID",       state.id);
    row("Idea",     truncate(state.idea));
    row("Phase",    `${phaseLabel(state.currentPhase)}  ${C.dim}(${state.currentPhase})${C.reset}`);
    row("Agents",   String(state.agents.length));
    row("Tasks",    `${completedTasks} / ${state.tasks.length} completed`);
    row("Score",    state.baselineScore !== undefined ? String(state.baselineScore) : "—");
    row("Evolution", `${state.evolution.length} entries`);
    if (state.environment) {
      row(
        "Env",
        `${state.environment.lspServers.length} LSP, ` +
        `${state.environment.mcpServers.length} MCP, ` +
        `${state.environment.plugins.length} plugins`,
      );
    }
    console.log(`${C.cyan}└${hr}┘${C.reset}\n`);
  });

program
  .command("phase")
  .description("Run a specific phase")
  .requiredOption("--name <phase>", `Phase name. Valid: ${ALL_PHASES.join(", ")}`)
  .option("--config <path>", "Path to config file")
  .option("--stack <technologies>", "Comma-separated tech stack (for environment-setup)")
  .action(async (opts: { name: string; config?: string; stack?: string }) => {
    const config = loadConfig(opts.config);
    const state  = loadState(config.stateDir);
    if (!state) {
      console.error(
        `\n${C.red}[ERROR]${C.reset} No project state found.` +
        ` Run ${C.bold}autonomous-dev run${C.reset} first.`
      );
      process.exit(1);
    }

    if (!isPhase(opts.name)) {
      console.error(
        `\n${C.red}[ERROR]${C.reset} Unknown phase: "${opts.name}"\n` +
        `  Valid phases: ${ALL_PHASES.map((p) => phaseLabel(p)).join(", ")}`
      );
      process.exit(1);
    }

    console.log(
      `${C.cyan}[phase]${C.reset} Running single phase: ${C.bold}${phaseLabel(opts.name)}${C.reset}`
    );
    await runOrchestrator(state, config, undefined, opts.name);
  });

program
  .command("dashboard")
  .description("Generate and open monitoring dashboard")
  .option("--config <path>", "Path to config file")
  .option("--watch", "Regenerate every 5 seconds")
  .action(async (opts: { config?: string; watch?: boolean }) => {
    const config = loadConfig(opts.config);
    const stateDir = config.stateDir;
    const outputPath = `${stateDir}/dashboard.html`;

    const generate = async (): Promise<void> => {
      await generateDashboard(stateDir, outputPath);
      console.log(`${C.cyan}[dashboard]${C.reset} Generated ${C.bold}${outputPath}${C.reset}`);
    };

    await generate();
    await openInBrowser(outputPath);

    if (opts.watch) {
      console.log(`${C.dim}[dashboard]${C.reset} Watching — regenerating every 5s. Ctrl+C to stop.`);
      const interval = setInterval(() => {
        generate().catch((err: unknown) => {
          console.error(`${C.red}[dashboard error]${C.reset}`, err);
        });
      }, 5_000);
      process.on("SIGINT", () => { clearInterval(interval); process.exit(0); });
      await new Promise<void>(() => { /* run until SIGINT */ });
    }
  });

program.parse();
